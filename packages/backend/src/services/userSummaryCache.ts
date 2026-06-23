import type { PostActorSummary } from '@mention/shared-types';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Redis-backed cache for resolved post-author summaries (the {@link PostActorSummary}
 * shape that {@link PostHydrationService.buildUserMap} produces from an Oxy user).
 *
 * WHY THIS EXISTS — hydrating a feed used to issue ONE `getUserById` HTTP request
 * per unique author on every render (the classic M+1). The same authors appear
 * across consecutive feed pages and across viewers, so resolving them once and
 * caching the ready-to-render summary collapses that fan-out to a single batched
 * Oxy call for the cache MISSES only.
 *
 * Design constraints (mirror {@link ./linkPreviewCache} and
 * {@link ./mediaCache/negativeCache}):
 *  - Uses the shared {@link getRedisClient} singleton — never opens a new socket.
 *  - When Redis is unavailable (no `REDIS_URL`, or the server is down) every
 *    operation degrades to a no-op via {@link withRedisFallback}: hydration still
 *    works, it just resolves every author from Oxy each time.
 *  - Only the resolved summary is cached — never auth-scoped or viewer-scoped
 *    data. The summary is identical for every viewer, so a single shared entry
 *    per author id is correct.
 */

/** Redis key prefix for cached author summaries. `v1` namespaces the schema so a shape change can bump it. */
const USER_SUMMARY_PREFIX = 'usersummary:v1:';

/**
 * TTL for a cached summary. Display name / avatar / verification change rarely;
 * ten minutes keeps the feed fresh while still absorbing the burst of repeated
 * lookups within a browsing session. Tunable via env without a redeploy.
 */
const SUMMARY_TTL_SECONDS = Number(process.env.USER_SUMMARY_CACHE_TTL_SECONDS ?? 10 * 60);

/**
 * The cached value: the ready-to-render {@link PostActorSummary} plus the
 * author's follower count (used by ranking's authority signal). Follower count
 * is OPTIONAL — older entries or users whose count was unavailable simply omit
 * it, and ranking falls back to a neutral authority multiplier.
 */
export interface CachedUserSummary {
  summary: PostActorSummary;
  followerCount?: number;
}

/** Hash-free key: Oxy user ids are already short and bounded, so embed them directly. */
function keyFor(userId: string): string {
  return `${USER_SUMMARY_PREFIX}${userId}`;
}

/**
 * Batch-read cached summaries for many user ids in a single Redis round-trip.
 *
 * Returns a map of `userId -> CachedUserSummary` containing ONLY the hits;
 * misses are simply absent so the caller can compute the miss set. Degrades to
 * an empty map (all misses) whenever Redis is unavailable.
 */
export async function mget(userIds: string[]): Promise<Map<string, CachedUserSummary>> {
  const result = new Map<string, CachedUserSummary>();
  if (userIds.length === 0) {
    return result;
  }

  const redis = getRedisClient();
  return withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return result;

      const keys = userIds.map(keyFor);
      const values = await redis.mGet(keys);

      values.forEach((raw, index) => {
        if (!raw) return;
        try {
          result.set(userIds[index], JSON.parse(raw) as CachedUserSummary);
        } catch {
          // Corrupt entry — treat as a miss so it gets re-resolved and re-written.
        }
      });

      return result;
    },
    result,
    'userSummaryCacheMget',
  );
}

/**
 * Write resolved summaries back to the cache with a TTL. A write failure must
 * never affect hydration, so any error degrades to a no-op (logged at debug).
 *
 * Each entry is written with its own `setEx` so the TTL is applied atomically
 * per key (a pipeline of `setEx` keeps it to a single round trip).
 */
export async function mset(entries: Map<string, CachedUserSummary>): Promise<void> {
  if (entries.size === 0) {
    return;
  }

  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;

      const pipeline = redis.multi();
      for (const [userId, value] of entries) {
        pipeline.setEx(keyFor(userId), SUMMARY_TTL_SECONDS, JSON.stringify(value));
      }
      await pipeline.exec();
    },
    undefined,
    'userSummaryCacheMset',
  ).catch((error: unknown) => {
    logger.debug('[UserSummaryCache] Store failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}
