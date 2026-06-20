/**
 * InterestScoreService — derives a per-user "activity/interest" score from
 * recent engagement on the user's posts and reports DELTAS to Oxy
 * (`POST /app-signals/ingest` → `interests`).
 *
 * Score model (per author, over a recent window):
 *   raw       = sum of (likes + boosts + comments + views + shares) across the
 *               author's published, public posts in the window.
 *   perPost   = log1p(raw) / log1p(postCount + 1)   // density, not just volume
 *   score     = clamp01(perPost * recencyDecay)     // 0..1 (Oxy contract bound)
 *
 * The Oxy contract clamps `interestScore` to [0, 1], so the score is normalized
 * here. Only users whose score moved by more than {@link SCORE_EPSILON} since the
 * last push are sent (delta-only), avoiding redundant last-write-wins writes.
 *
 * Last-pushed scores are tracked in Redis (a single hash); when Redis is
 * unavailable the service degrades to pushing every computed score (still
 * correct — Oxy is last-write-wins — just less efficient).
 */

import { Post } from '../models/Post';
import { getRedisClient } from '../utils/redis';
import { logger } from '../utils/logger';
import { oxySignalsClient, type OxySignalsClient, type InterestSignal } from './OxySignalsClient';

/** Engagement window: posts created within this many days count toward the score. */
const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Half-life (days) of the recency decay applied to the density score. */
const RECENCY_HALF_LIFE_DAYS = 14;

/** Minimum score change required to re-push a user's interest signal. */
const SCORE_EPSILON = 0.01;

/** Push interest signals to Oxy in batches of this size. */
const PUSH_CHUNK_SIZE = 500;

/** Redis hash storing the last pushed score per user (field = oxyUserId). */
const LAST_PUSHED_HASH = 'interest:lastPushed:v1';

/** Engagement totals + post metadata for one author in the window. */
interface AuthorAggregate {
  oxyUserId: string;
  raw: number;
  postCount: number;
  /** Most recent post's createdAt (ms) — drives recency decay. */
  lastPostMs: number;
}

/** Clamp a value into [0, 1]. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export class InterestScoreService {
  constructor(private readonly signalsClient: OxySignalsClient = oxySignalsClient) {}

  /**
   * Aggregate engagement per author over the recent window. Sums all five
   * denormalized `stats.*` counters across each author's published, public,
   * non-boost posts and tracks the post count + latest post time.
   */
  async aggregateAuthors(now: number = Date.now()): Promise<AuthorAggregate[]> {
    const since = new Date(now - WINDOW_MS);

    const rows = await Post.aggregate<{
      _id: string;
      raw: number;
      postCount: number;
      lastPost: Date;
    }>([
      {
        $match: {
          oxyUserId: { $ne: null },
          status: 'published',
          visibility: 'public',
          // Exclude boosts: a boost carries no original engagement of its own.
          type: { $ne: 'boost' },
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$oxyUserId',
          raw: {
            $sum: {
              $add: [
                { $ifNull: ['$stats.likesCount', 0] },
                { $ifNull: ['$stats.boostsCount', 0] },
                { $ifNull: ['$stats.commentsCount', 0] },
                { $ifNull: ['$stats.viewsCount', 0] },
                { $ifNull: ['$stats.sharesCount', 0] },
              ],
            },
          },
          postCount: { $sum: 1 },
          lastPost: { $max: '$createdAt' },
        },
      },
    ]);

    return rows
      .filter((r) => typeof r._id === 'string' && r._id.length > 0)
      .map((r) => ({
        oxyUserId: r._id,
        raw: r.raw ?? 0,
        postCount: r.postCount ?? 0,
        lastPostMs: r.lastPost ? new Date(r.lastPost).getTime() : now,
      }));
  }

  /** Compute the normalized [0,1] interest score for one author aggregate. */
  computeScore(agg: AuthorAggregate, now: number = Date.now()): number {
    if (agg.postCount <= 0) return 0;
    const density = Math.log1p(Math.max(0, agg.raw)) / Math.log1p(agg.postCount + 1);
    const ageDays = Math.max(0, (now - agg.lastPostMs) / (24 * 60 * 60 * 1000));
    const recencyDecay = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
    return clamp01(density * recencyDecay);
  }

  /** Read the last-pushed score map from Redis. Empty map on miss/error. */
  private async readLastPushed(): Promise<Map<string, number>> {
    try {
      const client = getRedisClient();
      if (!client?.isReady) return new Map();
      const hash = await client.hGetAll(LAST_PUSHED_HASH);
      const map = new Map<string, number>();
      for (const [userId, value] of Object.entries(hash)) {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) map.set(userId, parsed);
      }
      return map;
    } catch (error) {
      logger.debug('[InterestScore] last-pushed read failed:', error);
      return new Map();
    }
  }

  /** Persist the pushed scores back to Redis. Best-effort; never throws. */
  private async writeLastPushed(signals: InterestSignal[]): Promise<void> {
    if (signals.length === 0) return;
    try {
      const client = getRedisClient();
      if (!client?.isReady) return;
      const entries: Record<string, string> = {};
      for (const s of signals) {
        entries[s.userId] = String(s.interestScore);
      }
      await client.hSet(LAST_PUSHED_HASH, entries);
    } catch (error) {
      logger.debug('[InterestScore] last-pushed write failed:', error);
    }
  }

  /** Split into fixed-size chunks for bounded pushes. */
  private chunk(items: InterestSignal[], size: number): InterestSignal[][] {
    if (items.length <= size) return items.length > 0 ? [items] : [];
    const out: InterestSignal[][] = [];
    for (let i = 0; i < items.length; i += size) {
      out.push(items.slice(i, i + size));
    }
    return out;
  }

  /**
   * Full run: aggregate → score → diff against last-pushed → push deltas.
   * Returns counts for observability. Idempotent: a re-run with unchanged
   * engagement pushes nothing (all deltas below epsilon).
   */
  async run(now: number = Date.now()): Promise<{ scored: number; pushed: number }> {
    const aggregates = await this.aggregateAuthors(now);
    if (aggregates.length === 0) {
      return { scored: 0, pushed: 0 };
    }

    const lastPushed = await this.readLastPushed();
    const deltas: InterestSignal[] = [];
    for (const agg of aggregates) {
      const score = this.computeScore(agg, now);
      const previous = lastPushed.get(agg.oxyUserId);
      if (previous === undefined || Math.abs(score - previous) > SCORE_EPSILON) {
        deltas.push({ userId: agg.oxyUserId, interestScore: score });
      }
    }

    if (deltas.length === 0) {
      logger.debug(`[InterestScore] no deltas to push (${aggregates.length} authors scored)`);
      return { scored: aggregates.length, pushed: 0 };
    }

    let pushed = 0;
    for (const batch of this.chunk(deltas, PUSH_CHUNK_SIZE)) {
      await this.signalsClient.pushInterests(batch);
      await this.writeLastPushed(batch);
      pushed += batch.length;
    }

    logger.info(`[InterestScore] scored ${aggregates.length} authors, pushed ${pushed} deltas`);
    return { scored: aggregates.length, pushed };
  }
}

export const interestScoreService = new InterestScoreService();
export default interestScoreService;
