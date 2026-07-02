import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Redis-backed rolling AVERAGE of per-post impression dwell time (ms), powering
 * the opt-in `dwellTime` ranking signal.
 *
 * WHY A RUNNING AVERAGE (sum + count), not an EMA — the average is maintained
 * with two ATOMIC field increments (`HINCRBYFLOAT sum`, `HINCRBY n`), so
 * concurrent impressions never clobber each other (no read-modify-write race).
 * The average is `sum / n` at read time.
 *
 * Design constraints (mirror {@link ./feedViewCounter} + {@link ./userSummaryCache}):
 *  - Uses the shared {@link getRedisClient} singleton — never opens a new socket.
 *  - Every operation degrades to a NO-OP when Redis is unavailable (the signal
 *    then reads no data and stays neutral) — dwell is a best-effort ranking input,
 *    never a correctness-critical write.
 *  - Absurd client-reported durations are clamped so one forged sample can't skew
 *    a post's average.
 */

/** Redis key prefix for per-post dwell aggregates. `v1` namespaces the schema. */
const DWELL_PREFIX = 'dwell:v1:';

/** TTL for a post's dwell aggregate. Rolling window of relevance; 7 days. */
const DWELL_TTL_SECONDS = Number(process.env.DWELL_AGGREGATE_TTL_SECONDS ?? 7 * 24 * 60 * 60);

/**
 * Upper bound on a single dwell sample (ms). Client telemetry is untrusted, so a
 * pathological value (a backgrounded tab, a forged report) is clamped rather than
 * allowed to dominate the running average. 10 minutes.
 */
const MAX_DWELL_SAMPLE_MS = 10 * 60 * 1000;

function keyFor(postId: string): string {
  return `${DWELL_PREFIX}${postId}`;
}

/**
 * Fold one impression's dwell duration into a post's running average. Fire and
 * forget — never throws, and a Redis outage (or a non-positive/non-finite
 * duration) is a silent no-op. Clamps the sample to {@link MAX_DWELL_SAMPLE_MS}.
 */
export async function recordDwell(postId: string, durationMs: number): Promise<void> {
  if (!postId || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return;
  }
  const sample = Math.min(durationMs, MAX_DWELL_SAMPLE_MS);
  const redis = getRedisClient();

  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      const key = keyFor(postId);
      const multi = redis.multi();
      multi.hIncrByFloat(key, 'sum', sample);
      multi.hIncrBy(key, 'n', 1);
      multi.expire(key, DWELL_TTL_SECONDS);
      await multi.exec();
    },
    undefined,
    'dwellAggregateRecord',
  ).catch((error: unknown) => {
    logger.debug('[DwellAggregate] record failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/**
 * Batch-read the average dwell (ms) for many post ids. Returns a map of
 * `postId -> averageMs` containing ONLY posts that have at least one recorded
 * impression; posts with no data are simply absent so the caller's scorer stays
 * neutral. Degrades to an empty map when Redis is unavailable.
 */
export async function getDwellAverages(postIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (postIds.length === 0) {
    return result;
  }

  const redis = getRedisClient();
  return withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return result;

      // node-redis queues these on one connection in the same tick (pipelined).
      const rows = await Promise.all(postIds.map((id) => redis.hGetAll(keyFor(id))));
      rows.forEach((row, index) => {
        const sum = Number(row?.sum);
        const n = Number(row?.n);
        if (Number.isFinite(sum) && Number.isFinite(n) && n > 0) {
          result.set(postIds[index], sum / n);
        }
      });
      return result;
    },
    result,
    'dwellAggregateGet',
  );
}
