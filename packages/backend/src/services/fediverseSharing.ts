import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';
import { resolveOxyUser } from '../connectors/activitypub/constants';

/**
 * Read chokepoint for a user's fediverse-sharing consent flag.
 *
 * Oxy owns the canonical `fediverseSharing` boolean on the user DTO. This
 * module is the ONLY place the rest of Mention reads it — AP routes, inbox
 * handling, and outbound delivery all gate through {@link isFediverseSharingEnabled}
 * / {@link isFediverseSharingEnabledByUsername} rather than calling
 * `oxy.getUserById` directly, so the consent semantics (absent ⇒ enabled) and
 * the caching strategy live in exactly one place.
 *
 * Design constraints (mirrors {@link ./mediaCache/negativeCache} and
 * {@link ./userSummaryCache}):
 *  - Uses the shared {@link getRedisClient} singleton — never opens a new socket.
 *  - When Redis is unavailable every operation degrades to a no-op via
 *    {@link withRedisFallback}: reads just re-resolve from Oxy each time.
 *  - `oxy` is reached via a late dynamic `import()` inside the function below
 *    (same rationale as the late `require` behind `resolveOxyUser` in
 *    `connectors/activitypub/constants.ts`) rather than a static top-level
 *    import, so this module never forces the whole server entry point into
 *    the import graph of its callers at load time.
 *  - Oxy lookup failures fail OPEN — an outage must never look like every
 *    user disabled fediverse sharing. The failed lookup is never cached, so
 *    the next read retries against Oxy instead of sticking at "enabled".
 */

const KEY_PREFIX = 'fedisharing:v1:';
const TTL_SECONDS = Number(process.env.FEDIVERSE_SHARING_CACHE_TTL_SECONDS ?? 600);

/** Fields of the resolved Oxy user this module reads. */
interface FediverseSharingUserView {
  _id?: string | null;
  id?: string | null;
  fediverseSharing?: unknown;
}

function keyFor(oxyUserId: string): string {
  return `${KEY_PREFIX}${oxyUserId}`;
}

/** Absent/unknown field ⇒ enabled; only an explicit `false` disables. */
function readFlag(user: FediverseSharingUserView | null | undefined): boolean {
  return user?.fediverseSharing !== false;
}

/**
 * Write the resolved flag to the cache with the standard TTL. A write
 * failure must never affect the read result, so any error degrades to a
 * no-op (logged at debug).
 */
async function cacheFlag(oxyUserId: string, enabled: boolean): Promise<void> {
  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      await redis.setEx(keyFor(oxyUserId), TTL_SECONDS, enabled ? '1' : '0');
    },
    undefined,
    'fediverseSharingCacheSet',
  ).catch((error: unknown) => {
    logger.debug('[FediverseSharing] Cache write failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

/**
 * Whether `oxyUserId` currently allows their posts to be shared into the
 * fediverse. Redis-cached; on a miss, resolves from Oxy and populates the
 * cache. An Oxy lookup failure fails OPEN (returns `true`, logged as a
 * warning) and is never cached, so a transient outage retries on the next
 * read instead of sticking every user at "disabled".
 */
export async function isFediverseSharingEnabled(oxyUserId: string): Promise<boolean> {
  const redis = getRedisClient();
  const cached = await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return undefined;
      return await redis.get(keyFor(oxyUserId));
    },
    undefined,
    'fediverseSharingCacheGet',
  );
  if (cached === '1') return true;
  if (cached === '0') return false;

  // Dynamic `import()` (not a static top-level import) defers module
  // resolution past server.ts's own init order — the same reason
  // `resolveOxyUser` in `connectors/activitypub/constants.ts` reaches `oxy`
  // late, since this module is pulled in by route/connector modules server.ts
  // wires up before `oxy` is constructed. Unlike a CJS `require()`, a dynamic
  // `import()` is intercepted by `vi.mock` and keeps `oxy`'s real type.
  const { oxy } = await import('../../server');
  let user: FediverseSharingUserView;
  try {
    user = await oxy.getUserById(oxyUserId);
  } catch (error) {
    logger.warn('[FediverseSharing] Oxy lookup failed, failing open', {
      oxyUserId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return true;
  }

  const enabled = readFlag(user);
  await cacheFlag(oxyUserId, enabled);
  return enabled;
}

/**
 * Username variant of {@link isFediverseSharingEnabled}, for callers that
 * only have a handle (e.g. inbound webfinger/AP resolution). Returns `false`
 * for an unknown username — callers 404 on that case anyway, so there is no
 * ambiguity with the "absent field" default. Seeds the id-keyed cache from
 * the resolved DTO so a subsequent {@link isFediverseSharingEnabled} call for
 * the same user hits the cache.
 */
export async function isFediverseSharingEnabledByUsername(username: string): Promise<boolean> {
  const resolved = await resolveOxyUser(username);
  if (!resolved) return false;

  const user = resolved as FediverseSharingUserView;
  const id = user._id || user.id;
  const enabled = readFlag(user);
  if (id) {
    await cacheFlag(String(id), enabled);
  }
  return enabled;
}

/** Evicts the cached flag for `oxyUserId` — call after Oxy reports a change. */
export async function invalidateFediverseSharing(oxyUserId: string): Promise<void> {
  const redis = getRedisClient();
  await withRedisFallback(
    redis,
    async () => {
      const connected = await ensureRedisConnected(redis);
      if (!connected) return;
      await redis.del(keyFor(oxyUserId));
    },
    undefined,
    'fediverseSharingCacheInvalidate',
  ).catch((error: unknown) => {
    logger.debug('[FediverseSharing] Cache invalidate failed', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}
