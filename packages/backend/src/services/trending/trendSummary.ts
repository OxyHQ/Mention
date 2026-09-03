/**
 * On-demand trend summaries — the ONE place a model runs in this feature.
 *
 * Everything else about a trend is derived deterministically on a schedule. A
 * summary is the exception because it is the one artefact that (a) genuinely
 * needs generation and (b) is only ever read on one screen. So it is paid for by
 * DEMAND rather than by the clock: nothing is generated until real readers have
 * opened the trend {@link MtnConfig.trending.summary.minViews} times, and then
 * exactly once for that run.
 *
 * ## The three things that bound the spend
 *
 *  1. **Only a term that is CURRENTLY trending can trigger a generation**, and
 *     the run it is attributed to is read from the stored trend row — never from
 *     the request. A caller-supplied run would let anyone mint unlimited cache
 *     keys for one term and, with them, unlimited generations.
 *  2. **One generation per (term, run)**, enforced by a unique CONSTRAINT rather
 *     than by remembering to check: two tasks that cross the threshold together
 *     end with one insert and one unique violation.
 *  3. **A short lock around the call**, so the concurrent case costs one
 *     in-flight generation instead of N — the index makes duplicates harmless
 *     after the fact, but only the lock stops paying for them.
 *
 * Fail-soft throughout, in the direction of NOT generating: no Redis means no
 * demand signal, and no demand signal means no spend.
 */

import { MtnConfig } from '@mention/shared-types';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { isUniqueViolation } from '@oxyhq/db';
import { trendSummaries } from '../../db/schema/discovery';
import { inferenceChat, isInferenceEnabled } from '../../utils/oxyInference';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import { getRedisClient } from '../../utils/redis';

/** What the trend screen gets back. */
export interface TrendSummaryResult {
  /** The summary, when one exists. Absent is the ordinary case, not an error. */
  description?: string;
}

/** How long the generation lock is held. Longer than any single model call. */
const GENERATION_LOCK_TTL_SECONDS = 60;

/** Posts handed to the model as evidence. */
const SUMMARY_EXCERPT_COUNT = 12;

/** Longest excerpt sent per post. */
const SUMMARY_EXCERPT_LENGTH = 240;

/**
 * Record one open of a trend and return its summary if there is one.
 *
 * Counting and reading are one operation on purpose: the screen that reads a
 * summary IS the demand signal for writing it, and splitting them would mean
 * either a second round trip or a counter that drifts from what it measures.
 */
export async function resolveTrendSummary(input: {
  term: string;
  runStartedAt: Date;
  /** Recent post texts, loaded by the caller only when a generation is due. */
  loadExcerpts: () => Promise<string[]>;
}): Promise<TrendSummaryResult> {
  const term = input.term.trim().toLowerCase();
  if (!term) return {};

  const stored = await readStoredSummary(term, input.runStartedAt);
  // A FAILED lookup is not "no summary". Treating it as one would regenerate on
  // every open while storage is unavailable — and the write that would normally
  // stop the second generation is unavailable too, so it would not stop. Same
  // rule as the demand counter below: when the evidence cannot be read, do not
  // spend.
  if (!stored.ok) return {};
  if (stored.description) return { description: stored.description };

  if (!isInferenceEnabled()) return {};

  const views = await recordView(term, input.runStartedAt);
  if (views === null || views < MtnConfig.trending.summary.minViews) return {};

  return { description: await generateSummary(term, input.runStartedAt, input.loadExcerpts) };
}

/**
 * The stored summary for this run.
 *
 * `ok` separates "there is none" from "we could not tell", which are the same
 * value but opposite instructions: the first may generate, the second must not.
 */
async function readStoredSummary(
  term: string,
  runStartedAt: Date,
): Promise<{ ok: boolean; description?: string }> {
  try {
    const [row] = await getDb()
      .select({ description: trendSummaries.description })
      .from(trendSummaries)
      .where(and(
        eq(trendSummaries.term, term),
        eq(trendSummaries.runStartedAt, runStartedAt),
      ))
      .limit(1);
    return { ok: true, ...(row?.description ? { description: row.description } : {}) };
  } catch (error) {
    logger.warn('[Trending] Summary lookup failed', { term, error });
    return { ok: false };
  }
}

/**
 * Increment and return this run's view count, or `null` when it cannot be
 * counted.
 *
 * `null` is what makes the absence of Redis mean "do not generate": a summary
 * exists because demand was DEMONSTRATED, and an uncountable open demonstrates
 * nothing. Failing the other way would turn a Redis outage into a generation for
 * every trend anyone opened.
 */
async function recordView(term: string, runStartedAt: Date): Promise<number | null> {
  try {
    const redis = await getRedisClient();
    if (!redis) return null;

    // The term is hashed into the key rather than interpolated: a term is
    // arbitrary user text, and Redis keys should not carry it verbatim.
    const key = `trendsummary:views:${createHash('sha256')
      .update(`${term}\u0000${runStartedAt.getTime()}`)
      .digest('hex')}`;

    const views = await redis.incr(key);
    if (views === 1) {
      await redis.expire(key, Math.round(MtnConfig.trending.summary.viewWindowMs / 1000));
    }
    return views;
  } catch (error) {
    logger.warn('[Trending] Summary view count failed', { term, error });
    return null;
  }
}

/**
 * Generate, store and return the summary — or `undefined` if anything at all
 * gets in the way.
 *
 * Every failure here is silent to the reader by design: the screen renders
 * without a summary, which is exactly what it did a moment before the threshold
 * was crossed.
 */
async function generateSummary(
  term: string,
  runStartedAt: Date,
  loadExcerpts: () => Promise<string[]>,
): Promise<string | undefined> {
  const lock = await acquireLock(term, runStartedAt);
  if (!lock) return undefined;

  try {
    const excerpts = (await loadExcerpts())
      .map((excerpt) => excerpt.trim().slice(0, SUMMARY_EXCERPT_LENGTH))
      .filter((excerpt) => excerpt.length > 0)
      .slice(0, SUMMARY_EXCERPT_COUNT);
    // Nothing to read means nothing to say. Explaining a trend from its term
    // alone is how a summary becomes confident fiction.
    if (excerpts.length === 0) return undefined;

    const raw = await inferenceChat(
      [
        {
          role: 'system',
          content:
            'You explain why a topic is trending on a social network. Given the posts, ' +
            'write ONE or TWO plain sentences saying what is happening. Use only what the ' +
            'posts state — never speculate, never add facts that are not there, and if the ' +
            'posts do not agree on what happened, say what they have in common instead. ' +
            'Write in the language the posts are written in. Return the sentences only, ' +
            'with no preamble, quotes or markdown.',
        },
        { role: 'user', content: JSON.stringify({ topic: term, posts: excerpts }) },
      ],
      { feature: 'trend-summary', temperature: 0.3 },
    );

    const description = raw.trim().replace(/\s+/g, ' ').slice(0, MtnConfig.trending.summary.maxLength);
    if (!description) return undefined;

    await getDb()
      .insert(trendSummaries)
      .values({ term, runStartedAt, description, generatedAt: new Date() });
    metrics.incrementCounter('trend_summary_total', 1, { result: 'generated' });
    return description;
  } catch (error) {
    // A unique violation means another task won the race and already stored one
    // — an outcome, not a failure, so read theirs rather than reporting an error.
    if (isUniqueViolation(error)) return (await readStoredSummary(term, runStartedAt)).description;

    logger.warn('[Trending] Summary generation failed', { term, error });
    metrics.incrementCounter('trend_summary_total', 1, { result: 'failed' });
    return undefined;
  }
}

/** Best-effort lock. `false` simply means someone else is already generating. */
async function acquireLock(term: string, runStartedAt: Date): Promise<boolean> {
  try {
    const redis = await getRedisClient();
    if (!redis) return false;

    const key = `trendsummary:lock:${createHash('sha256')
      .update(`${term}\u0000${runStartedAt.getTime()}`)
      .digest('hex')}`;
    return (await redis.set(key, '1', { NX: true, EX: GENERATION_LOCK_TTL_SECONDS })) === 'OK';
  } catch (error) {
    logger.warn('[Trending] Summary lock failed', { term, error });
    return false;
  }
}
