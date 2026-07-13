import type { PostUser } from '@mention/shared-types';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Redis-backed cache for resolved post-author identities (the canonical Oxy
 * {@link PostUser} that {@link PostHydrationService.resolveUserSummaries}
 * passes through UNCHANGED from Oxy, plus the author's follower count for
 * ranking's authority signal).
 *
 * WHY THIS EXISTS — hydrating a feed used to issue ONE `getUserById` HTTP request
 * per unique author on every render (the classic M+1). The same authors appear
 * across consecutive feed pages and across viewers, so resolving them once and
 * caching the raw Oxy user collapses that fan-out to a single batched Oxy call
 * for the cache MISSES only.
 *
 * This cache does NOT reshape identity — Oxy owns the user shape. It only stores
 * the Oxy user verbatim (so the feed doesn't re-fetch it) and the follower count.
 *
 * Design constraints (mirror {@link ./mediaCache/negativeCache}):
 *  - Uses the shared {@link getRedisClient} singleton — never opens a new socket.
 *  - When Redis is unavailable (no `REDIS_URL`, or the server is down) every
 *    operation degrades to a no-op via {@link withRedisFallback}: hydration still
 *    works, it just resolves every author from Oxy each time.
 *  - Only public identity is cached — never auth-scoped or viewer-scoped data.
 *    The Oxy user is identical for every viewer, so a single shared entry per
 *    author id is correct. It is invalidated ({@link invalidate}) when the
 *    federated-actor identity bridge re-resolves a user (avatar/name refresh).
 */

/**
 * Redis key prefix for cached user identities. Bumped whenever the cached VALUE
 * schema changes so stale entries are never read back with missing fields:
 *  - `v2` — raw Oxy user (replaced the old flat summary).
 *  - `v3` — adds the account's BCP-47 `languages` (ranking-side, see
 *    {@link CachedUserSummary}).
 */
const USER_SUMMARY_PREFIX = 'usersummary:v3:';

/**
 * TTL for a cached summary. Display name / avatar / verification change rarely;
 * ten minutes keeps the feed fresh while still absorbing the burst of repeated
 * lookups within a browsing session. Tunable via env without a redeploy.
 */
const SUMMARY_TTL_SECONDS = Number(process.env.USER_SUMMARY_CACHE_TTL_SECONDS ?? 10 * 60);

/**
 * The cached value: the raw canonical Oxy {@link PostUser} plus the RANKING-side
 * facts about that account which never belong on a post DTO — the follower count
 * (authority signal) and the account's languages (the viewer-language signal).
 *
 * Both are OPTIONAL: a user whose count was unavailable, or who set no account
 * languages, simply omits the field and the corresponding signal falls back to
 * its neutral multiplier.
 */
export interface CachedUserSummary {
  user: PostUser;
  followerCount?: number;
  /**
   * The account's languages as canonical BCP-47 locales (`es-ES`, `en-US`),
   * primary first — resolved from the Oxy user via `getUserLanguages`. Read for
   * the VIEWER (`languageMismatchPenalty`); it is deliberately kept OFF
   * {@link PostUser} so it never ships inside a post's author DTO.
   */
  languages?: string[];
}

/** Hash-free key: Oxy user ids are already short and bounded, so embed them directly. */
function keyFor(userId: string): string {
  return `${USER_SUMMARY_PREFIX}${userId}`;
}

/**
 * One-time latch so the non-array-reply diagnostic escalates to `warn` exactly
 * once per process, not once per request. The non-array path can fire on EVERY
 * feed hydration, so an unbounded `warn` would flood the logs.
 */
let nonArrayReplyWarned = false;

/**
 * BOUNDED diagnostic for the "MGET returned a non-array reply" degradation.
 *
 * Every occurrence logs at `debug` (cheap, per-request). The FIRST occurrence
 * additionally logs at `warn` with the reply's runtime shape — `typeof`, the
 * constructor name, and a truncated JSON sample — so production can root-cause
 * WHY node-redis hands back a non-array against ElastiCache Valkey (the perf
 * follow-up) without changing the RESP protocol or spamming `warn`.
 */
function reportNonArrayMgetReply(reply: unknown, keyCount: number): void {
  logger.debug('[UserSummaryCache] mGet returned a non-array reply; treating as cache miss', {
    replyType: typeof reply,
    keyCount,
  });

  if (nonArrayReplyWarned) return;
  nonArrayReplyWarned = true;

  let sample: string;
  try {
    sample = JSON.stringify(reply)?.slice(0, 200) ?? String(reply);
  } catch {
    // A value that can't be serialized (e.g. a circular structure) still yields
    // a useful hint via its string coercion — never let diagnostics throw.
    sample = String(reply).slice(0, 200);
  }
  const constructorName =
    reply === null || reply === undefined ? undefined : reply.constructor?.name;

  logger.warn(
    '[UserSummaryCache] mGet returned a non-array reply (one-time diagnostic); treating as cache miss',
    {
      replyType: typeof reply,
      constructorName,
      sample,
      keyCount,
    },
  );
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

      // Defensive: a Redis client/server can return a non-array reply for MGET
      // (observed against ElastiCache Valkey). A non-array here throws a
      // TypeError that `withRedisFallback` does NOT swallow (it only degrades
      // connection errors), which 500s the whole feed. Treat any non-array reply
      // as a full cache miss so hydration degrades gracefully to a cold fetch,
      // and emit a bounded one-time diagnostic to root-cause the reply shape.
      if (!Array.isArray(values)) {
        reportNonArrayMgetReply(values, keys.length);
        return result;
      }

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

/**
 * Evict cached identities for a set of user ids so the next hydration re-reads
 * the authoritative Oxy user. Called from the federated-actor identity bridge
 * ({@link resolveOxyExternalUser}) after a successful re-resolve — an avatar or
 * display-name refresh on a federated actor must not be masked by a warm 10-min
 * cache entry. A failure degrades to a no-op (the entry simply ages out via TTL).
 */
export async function invalidate(userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    return;
  }

  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      await redis.del(userIds.map(keyFor));
    },
    undefined,
    'userSummaryCacheInvalidate',
  ).catch((error: unknown) => {
    logger.debug('[UserSummaryCache] Invalidate failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}
