import { createHash } from 'node:crypto';
import { getRedisClient } from '../../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../../utils/redisHelpers';
import { logger } from '../../utils/logger';

/**
 * Negative cache for the `/media/proxy` endpoint.
 *
 * Remote fediverse media is frequently deleted, access-restricted, or
 * hotlink-protected — the upstream answers 403/404/410. Without a memo, the SAME
 * dead URL is re-fetched on every feed render (a 30s-bounded round trip each
 * time), inflating both latency and error volume. This module records a
 * short-lived "this URL is known-bad" marker in the EXISTING Redis/Valkey
 * connection so a subsequent request short-circuits to 404 without touching the
 * network.
 *
 * Design constraints:
 *  - Uses the shared {@link getRedisClient} singleton — never opens a new socket.
 *  - When Redis is unavailable (no `REDIS_URL`, or the server is down) every
 *    operation degrades to a no-op via {@link withRedisFallback}: the proxy
 *    behaves exactly as it did before this module existed, just without memoing.
 *  - Only CLIENT-class failures (4xx) and hard CONNECTION failures are cached.
 *    Genuine upstream 5xx are NEVER cached — they may be transient.
 *  - Connection failures use a SHORTER TTL than 4xx because a remote host being
 *    momentarily unreachable is more likely to recover than a deleted asset.
 */

/** Redis key prefix for negative-cache markers (mirrors the `rl:` convention). */
const NEGATIVE_CACHE_PREFIX = 'mediaproxy:neg:';

/**
 * TTL for a client-class (4xx) negative result. A deleted/forbidden asset is
 * unlikely to come back soon, but we keep the window short so a re-published or
 * re-permissioned asset recovers within ~10 minutes without operator action.
 */
const CLIENT_ERROR_TTL_SECONDS = 10 * 60;

/**
 * TTL for a connection-failure negative result. Kept deliberately short because
 * connection failures are often transient (remote restart, brief network blip);
 * we don't want a momentary outage to suppress a healthy URL for long.
 */
const CONNECTION_ERROR_TTL_SECONDS = 60;

/** Kind of failure being memoized — controls the TTL applied. */
export type NegativeCacheKind = 'client-error' | 'connection-error';

/**
 * Derive the Redis key for a remote media URL. We hash the URL (SHA-256) rather
 * than embedding it raw so the key length is bounded and the (potentially long,
 * signed) upstream URL is not stored verbatim in Redis.
 */
function keyFor(remoteUrl: string): string {
  const hash = createHash('sha256').update(remoteUrl).digest('hex');
  return `${NEGATIVE_CACHE_PREFIX}${hash}`;
}

/**
 * Return `true` when `remoteUrl` is currently marked as known-bad, so the caller
 * can short-circuit to 404 without an upstream fetch. Degrades to `false` (cache
 * miss) whenever Redis is unavailable, so the proxy still attempts the fetch.
 */
export async function isNegativelyCached(remoteUrl: string): Promise<boolean> {
  const redis = getRedisClient();
  return withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return false;
      const hit = await redis.exists(keyFor(remoteUrl));
      return hit === 1;
    },
    false,
    'mediaProxyNegativeCacheGet',
  );
}

/**
 * Record `remoteUrl` as known-bad with a TTL chosen by failure `kind`. A failure
 * to write must never break the proxy response, so any error degrades to a no-op
 * (logged at debug — not silently swallowed).
 */
export async function markNegativelyCached(remoteUrl: string, kind: NegativeCacheKind): Promise<void> {
  const redis = getRedisClient();
  const ttlSeconds = kind === 'connection-error' ? CONNECTION_ERROR_TTL_SECONDS : CLIENT_ERROR_TTL_SECONDS;
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      // Value is a marker only; the key's existence is the signal. setEx applies
      // the TTL atomically so a crash can't leave a permanent negative entry.
      await redis.setEx(keyFor(remoteUrl), ttlSeconds, kind);
    },
    undefined,
    'mediaProxyNegativeCacheSet',
  ).catch((error: unknown) => {
    logger.debug('[MediaProxy] Negative-cache write failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}
