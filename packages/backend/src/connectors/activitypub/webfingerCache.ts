import { getRedisClient } from '../../utils/redis';
import { logger } from '../../utils/logger';

/**
 * Redis key format for a cached WebFinger JRD response — the single source of
 * truth shared by `routes/wellKnown.routes.ts` (which reads/writes it) and
 * {@link invalidateWebfingerCache} (which evicts it).
 */
export function webfingerCacheKey(username: string): string {
  return `webfinger:${username.toLowerCase()}`;
}

/**
 * Evict the cached WebFinger JRD for `username`.
 *
 * `GET /.well-known/webfinger` serves a cache hit BEFORE its `fediverseSharing`
 * gate runs (see `routes/wellKnown.routes.ts`), so a toggle in EITHER direction
 * must evict the stale entry immediately — otherwise a user who just disabled
 * sharing stays discoverable, or one who just enabled it stays hidden, for up
 * to the cache's 1h TTL. Fail-soft: a Redis outage must never fail the
 * caller's flag-change request — the entry simply expires on its own TTL.
 */
export async function invalidateWebfingerCache(username: string): Promise<void> {
  const redis = getRedisClient();
  if (!redis?.isReady) return;
  try {
    await redis.del(webfingerCacheKey(username));
  } catch (err) {
    logger.warn('Failed to invalidate webfinger cache:', err);
  }
}
