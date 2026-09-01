/**
 * The trending JOB and the public trend READS.
 *
 * What is left here is the orchestration and the two things that are genuinely
 * about the service as a whole: the leader-gated schedule, and the cached
 * read path with its staleness observation. Every step the job runs lives in
 * `services/trending/` and is imported from its owner —
 * {@link aggregateTermCandidates} measures, `trendScoring` ranks,
 * {@link buildTrendItems} names and files, {@link saveTrendingBatch} stores.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { trendBatches, trending, TrendingType } from '../db/schema/discovery';
import { logger } from '../utils/logger';
import { getRedisClient } from '../utils/redis';
import { emitTrendsUpdated } from '../utils/socket';
import { inferenceChat, isInferenceEnabled } from '../utils/oxyInference';
import { metrics } from '../utils/metrics';
import { topicService } from './TopicService';
import { saveTrendGraph } from './trending/trendGraph';
import { mintTrendRecId } from './trending/trendTelemetry';
import { rankTrendCandidates, topUpWithPopular } from './trending/trendScoring';
import { resolveTrendSummary, type TrendSummaryResult } from './trending/trendSummary';
import { aggregateTermCandidates } from './trending/trendDetection';
import { buildTrendItems, type TrendItem } from './trending/trendItems';
import { cleanupOldTrends, saveTrendingBatch } from './trending/trendBatchStore';
import { loadExcerptsByTerm } from './trending/trendExcerpts';
import { loadTrendActors, loadVolumeSeries } from './trending/trendDecoration';
import {
  LANGUAGE_OVERFETCH,
  orderByLanguageMatch,
  serializeTrend,
  type TrendWithSeries,
} from './trending/trendRow';
import type { PostUser, TrendCategory } from '@mention/shared-types';

/**
 * How long the current batch's `recId` is memoized in process. Far shorter than
 * the 30-minute batch interval so a rotation is picked up almost immediately,
 * long enough that a burst of reported presses costs at most one database read.
 */
const CURRENT_REC_ID_TTL_MS = 30_000;

/**
 * What `GET /trending/summary` answers: how to PRESENT one trend.
 *
 * Named for what it is rather than for the summary alone, because the summary
 * is the optional part — a trend has a name and a category from the moment it
 * is detected, and only earns prose once enough readers open it.
 */
export type TrendDetail = TrendSummaryResult & {
  /** The trend's label, as the batch derived it. Absent when not currently trending. */
  displayName?: string;
  category?: TrendCategory;
};

class TrendingService {
  private calculationInterval: NodeJS.Timeout | null = null;
  /** Memoized current-batch token; see {@link getCurrentRecId}. */
  private currentRecIdCache: { value: string | null; expiresAt: number } | null = null;
  private readonly REDIS_CACHE_TTL = 1800; // 30 minutes in seconds
  private readonly CALCULATION_INTERVAL = 1800000; // 30 minutes in milliseconds
  // Default `limit` for the public trending list (mirrors the GET /trending
  // route default). Warmed into Redis after each recalculation so the most
  // common request is a cache hit, never a cold aggregate.
  private readonly DEFAULT_TRENDING_LIMIT = 20;
  // How old the served batch may get before it is reported as stale. Derived from
  // the calculation cadence rather than fixed, so the two can never drift apart.
  // Three cadences: one missed run is a blip (a leader handover, a slow write),
  // three in a row is the job not landing, which is what went unnoticed for a day.
  private readonly STALE_BATCH_AFTER_MS = this.CALCULATION_INTERVAL * 3;

  /**
   * Initialize the service and start periodic calculations.
   *
   * Leader-gated by design: this is invoked ONLY from `startSchedulers()` in
   * `server.ts`, which `LeaderElection` runs on exactly one backend task. Non-
   * leader tasks never compute trends — they serve reads from the shared
   * `trending` table / Redis cache. Same pattern as every other periodic
   * job (FeedJobScheduler, FollowerSnapshotJob, etc.).
   */
  public initialize(): void {
    this.calculateTrending().catch(error => {
      logger.error('[Trending] Initial calculation failed:', error);
    });

    this.calculationInterval = setInterval(() => {
      this.calculateTrending().catch(error => {
        logger.error('[Trending] Periodic calculation failed:', error);
      });
    }, this.CALCULATION_INTERVAL);
    // Never keep the event loop (or the jest run) alive solely for this timer.
    this.calculationInterval.unref?.();

    logger.info('[Trending] Service initialized with 30-minute calculation interval');
  }

  /**
   * Clean up resources.
   */
  public cleanup(): void {
    if (this.calculationInterval) {
      clearInterval(this.calculationInterval);
      this.calculationInterval = null;
    }
  }

  /**
   * Main calculation: aggregate hashtags + topics from classified post data, then save as a batch.
   *
   * `TrendBatch` is what `getTrending` reads the current timestamp from, so it is
   * created only once the rows it points at exist. The failure this ordering
   * guards against is not hypothetical: a batch write that died partway left the
   * `TrendBatch` uncreated, and the endpoint then served its last complete batch
   * for over a day — HTTP 200, full payload, no external sign anything was wrong.
   * Hence the outcome counter here, and the age gauge in {@link getTrending}: the
   * job failing and the job never running must both be visible from outside.
   */
  public async calculateTrending(): Promise<void> {
    try {
      logger.info('[Trending] Starting trending calculation');

      const calculatedAt = new Date();

      // ONE term space. Hashtags, extracted words and classified topic slugs are
      // all just terms, counted the same way, competing in the same list — see
      // `aggregateTermCandidates`.
      const { candidates, graph } = await aggregateTermCandidates(calculatedAt);
      const measurements = candidates.map((candidate) => candidate.measurement);
      // Bursts first; then, only if too few things are genuinely spiking, fill
      // out the list by volume. The top-up relaxes the burst bar and nothing
      // else — every floor still applies — so a quiet network gets a list that
      // says "people are posting about this" instead of an empty widget that
      // reads as broken.
      const ranked = topUpWithPopular(measurements, rankTrendCandidates(measurements));

      const allTrends: TrendItem[] = await buildTrendItems(ranked, candidates, calculatedAt);

      const popularityUpdates = allTrends
        .filter((trend) => trend.topicId)
        .map((trend) => ({ topicId: trend.topicId as string, trendingScore: trend.score }));

      // Run AI summary generation, trend persistence, and popularity updates in parallel
      const [summary, write] = await Promise.all([
        // The summary reads the LABELS, not the terms: it is prose for a human,
        // and `orioles, frightclub` describes the index rather than the day.
        this.generateSummary(allTrends.slice(0, 10).map((trend) => trend.displayName)),
        saveTrendingBatch(allTrends, calculatedAt),
        saveTrendGraph(graph),
        topicService.updatePopularityFromTrending(popularityUpdates),
      ]);

      // Nothing accepted out of a non-empty batch: publishing the `TrendBatch`
      // would point readers at rows that do not exist and blank the widget, which
      // is strictly worse than continuing to serve the previous batch. An empty
      // INSTANCE (no trends measured at all) is a different thing and still
      // publishes — that is a fact about the data, not a failed write.
      if (allTrends.length > 0 && write.insertedCount === 0) {
        throw new Error(
          `Trending batch ${calculatedAt.toISOString()} inserted 0 of ${allTrends.length} rows`,
        );
      }

      if (write.rejected.length > 0) {
        // Loud on purpose. Every rejected row is a trend the batch measured and
        // failed to store, and the only place that is visible is right here.
        logger.error('[Trending] Batch stored with rejected rows', {
          calculatedAt: calculatedAt.toISOString(),
          inserted: write.insertedCount,
          expected: allTrends.length,
          rejected: write.rejected,
        });
      }
      metrics.incrementCounter('trending_calculation_total', 1, {
        result: write.rejected.length > 0 ? 'partial' : 'success',
      });

      await getDb().insert(trendBatches).values({ calculatedAt, summary });

      logger.info(
        `[Trending] Saved batch: ${allTrends.length} trends from ${candidates.length} candidate terms ` +
          `(${popularityUpdates.length} topic popularities updated)`,
      );

      await this.invalidateCache();

      // Warm the default trending cache immediately after invalidation so the
      // first reader after each recalculation gets a cache hit instead of
      // paying the full aggregate cost (see getTrending). Fail-soft.
      await this.warmDefaultCache();

      // Broadcast a lightweight signal so connected clients refetch trends.
      emitTrendsUpdated(calculatedAt.toISOString());

      await cleanupOldTrends();
    } catch (error) {
      metrics.incrementCounter('trending_calculation_total', 1, { result: 'failure' });
      logger.error('[Trending] Error calculating trending:', error);
      throw error;
    }
  }

  /**
   * Generate a lightweight AI summary from trend names.
   */
  private async generateSummary(trendNames: string[]): Promise<string> {
    if (!isInferenceEnabled() || trendNames.length === 0) {
      return '';
    }

    try {
      const summary = await inferenceChat(
        [
          {
            role: 'system',
            content: 'You are a social media trend analyst. Given a list of trending topics, write a 1-2 sentence summary of what people are talking about right now. Be natural and engaging. Vary the phrasing. Return ONLY the summary text.',
          },
          {
            role: 'user',
            content: `Trending: ${trendNames.join(', ')}`,
          },
        ],
        { feature: 'trending-overview', temperature: 0.5 },
      );

      return summary.trim();
    } catch (error) {
      logger.warn('[Trending] Summary generation failed:', error);
      return '';
    }
  }

  /**
   * Get the latest batch of trends with its summary and its `recId`.
   *
   * The `recId` identifies the BATCH (see {@link mintTrendRecId}) and is what a
   * later `POST /trending/events` submits back, so the server can tell a press
   * on the current batch from one on a page a CDN served after the batch rotated.
   * It is derived from `calculatedAt` — already loaded here — rather than minted
   * per request, precisely because this result is cached and shared.
   *
   * This is also where batch staleness is observed, via {@link observeBatchAge}.
   * The read path is the honest place for it: the age is derived from persisted
   * state, so it survives a task restart and does not care which task holds
   * leadership — a job that dies, a job that never starts, and a leader that never
   * gets elected all show up identically here, which is exactly the property the
   * calculation-side counter lacks.
   */
  public async getTrending(
    limit: number = 20,
    type?: TrendingType,
    languages: readonly string[] = [],
  ): Promise<{ trending: TrendWithSeries[]; summary: string; recId?: string }> {
    // The reader's languages are part of the cache IDENTITY, not of a per-user
    // personalization: the route takes them as a query parameter precisely so
    // this stays a public, shared, CDN-cacheable read. The set is normalized and
    // sorted by the caller, so `es,en` and `en,es` are one entry rather than two.
    const languageKey = languages.length > 0 ? languages.join(',') : 'any';
    const cacheKey = `trending:latest:${limit}:${type || 'all'}:${languageKey}`;
    const redis = await getRedisClient();

    if (redis) {
      try {
        const cached = await redis.get(cacheKey);
        if (cached) {
          logger.debug('[Trending] Cache hit for latest trends');
          return JSON.parse(cached);
        }
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache read failed:', cacheError);
      }
    }

    const db = getDb();
    // `trend_batches` carries the latest timestamp and summary in one row.
    const [latestBatch] = await db
      .select()
      .from(trendBatches)
      .orderBy(desc(trendBatches.calculatedAt))
      .limit(1);

    if (!latestBatch) return { trending: [], summary: '' };

    this.observeBatchAge(latestBatch.calculatedAt);

    /**
     * `(score desc, rank asc)` is already a strict total order HERE and needs no
     * tiebreak: the query is pinned to ONE batch, and `rank` is assigned `1..n`
     * over that batch's rows in `saveTrendingBatch`, so no two rows in scope can
     * share it. The `limit` therefore cuts a deterministic prefix.
     *
     * `type` is compared through `sql` rather than `eq()` because `TrendingType`
     * is a string ENUM and the column is typed as the literal union — the same
     * three strings, but TypeScript treats enums nominally and would reject the
     * assignment. The bound value is the enum's own string at runtime.
     *
     * Overfetched, then ordered by language match below: the reader's languages
     * decide the ORDER, never membership, so a quiet language cannot leave
     * somebody with an empty list.
     */
    const rows = await db
      .select()
      .from(trending)
      .where(
        and(
          eq(trending.calculatedAt, latestBatch.calculatedAt),
          type ? sql`${trending.type} = ${type}` : undefined,
        ),
      )
      .orderBy(desc(trending.score), asc(trending.rank))
      .limit(limit * LANGUAGE_OVERFETCH);

    const trends = orderByLanguageMatch(rows.map(serializeTrend), languages).slice(0, limit);

    // Only reached on a cache MISS. The entry below is warmed right after each
    // recalculation (see warmDefaultCache), so these run on the order of once per
    // 30-minute batch per requested shape — not once per reader.
    const [series, actors] = await Promise.all([
      loadVolumeSeries(trends),
      loadTrendActors(trends),
    ]);

    const result = {
      trending: trends.map((trend): TrendWithSeries => {
        const points = series.get(trend.name);
        const faces = trend.actorIds
          ?.map((actorId) => actors.get(actorId))
          .filter((user): user is PostUser => Boolean(user));
        return {
          ...trend,
          ...(points ? { series: points } : {}),
          ...(faces && faces.length > 0 ? { actors: faces } : {}),
        };
      }),
      summary: latestBatch.summary,
      recId: mintTrendRecId(latestBatch.calculatedAt),
    };

    if (redis && trends.length > 0) {
      try {
        await redis.setEx(cacheKey, this.REDIS_CACHE_TTL, JSON.stringify(result));
      } catch (cacheError) {
        logger.warn('[Trending] Redis cache write failed:', cacheError);
      }
    }

    return result;
  }

  /**
   * Everything the trend screen needs to present a term: what it is called, how
   * it is filed, and its summary if it has earned one.
   *
   * The presentation travels in the RESPONSE rather than in the URL. A label
   * passed as a query parameter would make `/trend/politics` and
   * `/trend/politics?label=Politics` two addresses for one resource, freeze a
   * shared link's title at the moment it was copied — so it lies the next time
   * the term is relabelled — and let anyone hand a reader a fabricated name.
   * The row this reads is the same one the `startedAt` lookup already fetches,
   * so carrying the label costs nothing.
   *
   * The on-demand summary for a trend a reader just opened.
   *
   * The run is read from the STORED row for the current batch, never from the
   * request: it is the identity a summary is generated and cached under, so a
   * caller-supplied one would let anyone mint unlimited cache keys — and with
   * them, unlimited generations — for a single term. The same lookup is what
   * restricts generation to terms that are actually trending right now.
   *
   * Excerpts are passed as a THUNK so the query only runs when a generation is
   * actually due: the overwhelming majority of calls are a single indexed read
   * that finds an existing summary, or a counter increment below the threshold.
   */
  public async getTrendSummary(term: string): Promise<TrendDetail> {
    const normalized = term.trim().toLowerCase();
    if (!normalized) return {};

    const db = getDb();
    const [latestBatch] = await db
      .select({ calculatedAt: trendBatches.calculatedAt })
      .from(trendBatches)
      .orderBy(desc(trendBatches.calculatedAt))
      .limit(1);
    if (!latestBatch) return {};

    const [row] = await db
      .select({
        startedAt: trending.startedAt,
        displayName: trending.displayName,
        category: trending.category,
      })
      .from(trending)
      .where(and(
        eq(trending.name, normalized),
        eq(trending.calculatedAt, latestBatch.calculatedAt),
      ))
      .limit(1);
    // Not in the current batch, or written before onset tracking: either way
    // there is no run to attribute a summary to, so there is nothing to do.
    if (!row?.startedAt) return {};

    const summary = await resolveTrendSummary({
      term: normalized,
      runStartedAt: row.startedAt,
      // The one-term case of the batch, not a second implementation of it: a
      // single branch renders as the per-term query wrapped in a subselect, so
      // this reads the same rows in the same order the labeller sees.
      loadExcerpts: async () => (await loadExcerptsByTerm([normalized])).get(normalized) ?? [],
    });

    return {
      ...summary,
      ...(row.displayName ? { displayName: row.displayName } : {}),
      ...(row.category ? { category: row.category } : {}),
    };
  }

  /**
   * Publish how old the batch being served actually is.
   *
   * The defect this exists for is not that the job can fail — it always could —
   * but that a frozen batch is indistinguishable from a fresh one from outside:
   * `GET /trending` answered 200 with a full, plausible payload for over a day
   * while every recalculation behind it was dying. The gauge makes the age
   * alertable, and the log gives a human reading the logs the same fact.
   *
   * Only reached on a cache miss, which is roughly once per batch per requested
   * shape — the right frequency for a health observation and nowhere near a hot
   * path. Never throws: an observation must not be able to fail a read.
   */
  private observeBatchAge(calculatedAt: Date): void {
    const ageMs = Date.now() - calculatedAt.getTime();
    metrics.setGauge('trending_batch_age_seconds', Math.max(0, Math.round(ageMs / 1000)));

    if (ageMs > this.STALE_BATCH_AFTER_MS) {
      logger.error('[Trending] Serving a stale batch — recalculation is not landing', {
        calculatedAt: calculatedAt.toISOString(),
        ageSeconds: Math.round(ageMs / 1000),
        staleAfterSeconds: Math.round(this.STALE_BATCH_AFTER_MS / 1000),
      });
    }
  }

  /**
   * The `recId` of the batch that is current RIGHT NOW — what a submitted token
   * is compared against to derive the bounded `freshness` label.
   *
   * Memoized in process for {@link CURRENT_REC_ID_TTL_MS} because this is read on
   * the telemetry hot path, where a database round trip per reported press would
   * cost far more than the measurement is worth. The memo is deliberately much
   * shorter than the 30-minute batch interval, so a rotation shows up almost
   * immediately; a stale-by-seconds token would only ever mislabel presses that
   * land in that window, and it never blocks the write.
   *
   * Fail-soft: `null` on any error, which the telemetry module reads as
   * `unknown` rather than declaring every press stale.
   */
  public async getCurrentRecId(): Promise<string | null> {
    const now = Date.now();
    if (this.currentRecIdCache && this.currentRecIdCache.expiresAt > now) {
      return this.currentRecIdCache.value;
    }

    try {
      const [latestBatch] = await getDb()
        .select({ calculatedAt: trendBatches.calculatedAt })
        .from(trendBatches)
        .orderBy(desc(trendBatches.calculatedAt))
        .limit(1);
      const value = latestBatch ? mintTrendRecId(latestBatch.calculatedAt) : null;
      this.currentRecIdCache = { value, expiresAt: now + CURRENT_REC_ID_TTL_MS };
      return value;
    } catch (error) {
      logger.warn('[Trending] Current recId lookup failed:', error);
      return null;
    }
  }

  /**
   * Warm the default `getTrending` cache entry so the first read after a cache
   * invalidation is a hit rather than a cold aggregate. Reuses the normal read
   * path (which populates the cache on a miss) so the warmed value has the exact
   * same shape a request would produce. Fail-soft — a warm failure never breaks
   * the calculation.
   */
  private async warmDefaultCache(): Promise<void> {
    try {
      await this.getTrending(this.DEFAULT_TRENDING_LIMIT);
    } catch (error) {
      logger.warn('[Trending] Default cache warm failed:', error);
    }
  }

  /**
   * Invalidate Redis cache.
   */
  private async invalidateCache(): Promise<void> {
    try {
      const redis = await getRedisClient();
      if (!redis) return;

      const keys = await redis.keys('trending:*');
      if (keys.length > 0) {
        await redis.del(keys);
        logger.debug(`[Trending] Invalidated ${keys.length} cache keys`);
      }
    } catch {
      // Redis unavailable — cache invalidation skipped silently
    }
  }
}

// Export singleton instance
export const trendingService = new TrendingService();
