import { isNotFoundError } from '@oxyhq/core';
import { getRedisClient } from '../utils/redis';
import { withRedisFallback, ensureRedisConnected } from '../utils/redisHelpers';
import { logger } from '../utils/logger';

/**
 * Read chokepoint for a user's fediverse-sharing consent flag.
 *
 * Oxy owns the canonical `fediverseSharing` boolean on the user DTO. This
 * module is the ONLY place the rest of Mention reads it — AP routes, inbox
 * handling, and outbound delivery all gate through {@link isFediverseSharingEnabled}
 * / {@link isFediverseSharingEnabledFromUser} / {@link getFediverseSharingStateByUsername}
 * / {@link getFediverseSharingStateById} rather than calling
 * `oxy.getUserById`/`oxy.getProfileByUsername` directly, so the consent
 * semantics (absent ⇒ enabled) and the caching strategy live in exactly one
 * place.
 *
 * Design constraints (mirrors {@link ./mediaCache/negativeCache} and
 * {@link ./userSummaryCache}):
 *  - Uses the shared {@link getRedisClient} singleton — never opens a new socket.
 *  - When Redis is unavailable every operation degrades to a no-op via
 *    {@link withRedisFallback}: reads just re-resolve from Oxy each time.
 *  - `oxy` is reached via a late dynamic `import()` inside the functions below
 *    (same rationale as the late `require` behind `resolveOxyUser` in
 *    `connectors/activitypub/constants.ts`) rather than a static top-level
 *    import, so this module never forces the whole server entry point into
 *    the import graph of its callers at load time.
 *  - Oxy lookup failures fail OPEN — an outage must never look like every
 *    user disabled fediverse sharing. The failed lookup is never cached, so
 *    the next read retries against Oxy instead of sticking at "enabled".
 *  - Every `oxy.getUserById` / `oxy.getProfileByUsername` call in this module
 *    passes `{ cache: false }`. Those SDK methods cache their result
 *    in-process for 5 minutes; without the override, that cache sits as an
 *    UNDOCUMENTED third layer underneath Mention's own Redis cache — a fresh
 *    read issued right after `invalidateFediverseSharing` could still return
 *    a pre-toggle snapshot from the SDK's memory and write it straight back
 *    into the just-cleared Redis entry, silently undoing the invalidation for
 *    a full TTL. Mention's Redis cache (below) stays the ONLY cache for this
 *    flag.
 */

const KEY_PREFIX = 'fedisharing:v1:';
const TTL_SECONDS = Number(process.env.FEDIVERSE_SHARING_CACHE_TTL_SECONDS ?? 600);

/** Fields of the resolved Oxy user this module reads. */
interface FediverseSharingUserView {
  _id?: string | null;
  id?: string | null;
  fediverseSharing?: unknown;
}

/**
 * Outcome of a username-keyed consent read — see {@link getFediverseSharingStateByUsername}.
 */
export type FediverseSharingState = 'enabled' | 'disabled' | 'unknown-user' | 'unavailable';

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
 * fediverse. Redis-cached; on a miss, resolves from Oxy (bypassing the SDK's
 * own cache — see the module doc) and populates the cache. An Oxy lookup
 * failure fails OPEN (returns `true`, logged as a warning) and is never
 * cached, so a transient outage retries on the next read instead of sticking
 * every user at "disabled".
 *
 * `options.skipRedisCache` bypasses the Redis read (the write on a fresh
 * resolve still happens) — for callers that need a guaranteed-current value
 * regardless of what Redis currently holds, e.g. {@link runSharingCleanup}'s
 * spurious-queue guard, which must not trust a Redis entry that could have
 * been written by a race between the toggle and the guard's own check.
 */
export async function isFediverseSharingEnabled(
  oxyUserId: string,
  options: { skipRedisCache?: boolean } = {},
): Promise<boolean> {
  if (!options.skipRedisCache) {
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
  }

  // Dynamic `import()` (not a static top-level import) defers module
  // resolution past server.ts's own init order — the same reason
  // `resolveOxyUser` in `connectors/activitypub/constants.ts` reaches `oxy`
  // late, since this module is pulled in by route/connector modules server.ts
  // wires up before `oxy` is constructed. Unlike a CJS `require()`, a dynamic
  // `import()` is intercepted by `vi.mock` and keeps `oxy`'s real type.
  const { oxy } = await import('../../server');
  let user: FediverseSharingUserView;
  try {
    user = await oxy.getUserById(oxyUserId, { cache: false });
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
 * Pure variant of {@link isFediverseSharingEnabled} for callers that ALREADY
 * hold a resolved Oxy user object — 5 of the 6 user-scoped AP/discovery GET
 * surfaces (actor, outbox, followers, following, post dereference; webfinger
 * is the exception, see {@link getFediverseSharingStateByUsername}) resolve
 * the user for their own response body before they need the consent flag, so
 * re-deriving the flag from that same object avoids a second, redundant Oxy
 * round-trip. Reads the DTO field synchronously (absent ⇒ enabled). NO Redis
 * write: the object backing this read comes from `resolveOxyUser`, which is
 * itself subject to the SDK's own ≤5-minute in-process cache — seeding Redis
 * from a possibly-stale DTO would let a pre-toggle snapshot overwrite a
 * just-invalidated '0' with '1' fleet-wide for a full {@link TTL_SECONDS},
 * reopening every outbound consent gate after an opt-out. Leaving Redis
 * untouched here keeps this read's own staleness self-consistent with the
 * response body it's paired with — bounded by that SAME ≤5-minute SDK cache
 * window, never worse — while `isFediverseSharingEnabled` (Redis-backed) and
 * `invalidateFediverseSharing` (the only Redis writer/evictor for this flag
 * besides a fresh Oxy resolve) stay the sole source of truth for the cache.
 */
export function isFediverseSharingEnabledFromUser(
  user: FediverseSharingUserView | null | undefined,
): boolean {
  return readFlag(user);
}

/**
 * Username-keyed consent read for callers that only have a handle and no
 * already-resolved user object — currently the user-inbox POST gate
 * (`POST /ap/users/:username/inbox`), which must distinguish a genuine
 * Oxy outage from a real unknown/opted-out user: the caller lets an outage
 * PROCEED (a 404 would make the remote server drop the delivery permanently)
 * while still 404ing a disabled or nonexistent user.
 *
 * Calls `oxy.getProfileByUsername` directly with `{ cache: false }` — does
 * NOT go through `resolveOxyUser` (which caches, and falls back to
 * `searchProfiles` on failure), since neither behavior is appropriate for a
 * consent read: caching would reintroduce the third-cache-layer bug this
 * module exists to avoid, and a search fallback can't distinguish "unknown
 * user" from "search also failed". A thrown 404 is treated as `unknown-user`;
 * any other failure (timeout, 5xx, network) is `unavailable` and logged at
 * warn. Seeds the id-keyed Redis cache on a resolved user, same as
 * {@link isFediverseSharingEnabledFromUser}.
 */
export async function getFediverseSharingStateByUsername(username: string): Promise<FediverseSharingState> {
  const { oxy } = await import('../../server');
  let user: FediverseSharingUserView;
  try {
    user = await oxy.getProfileByUsername(username, { cache: false });
  } catch (error) {
    if (isNotFoundError(error)) return 'unknown-user';
    logger.warn('[FediverseSharing] Oxy lookup failed, treating as unavailable', {
      username,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return 'unavailable';
  }

  const enabled = readFlag(user);
  const id = user._id || user.id;
  if (id) {
    await cacheFlag(String(id), enabled);
  }
  return enabled ? 'enabled' : 'disabled';
}

/**
 * Id-keyed tri-state consent read, uncached and Redis-skipping — mirrors
 * {@link getFediverseSharingStateByUsername}'s split but for a caller that
 * already holds the `oxyUserId` and needs a guaranteed-fresh state,
 * distinguishing a genuine Oxy outage from a real disabled/deleted user.
 *
 * Currently used ONLY by `runSharingCleanup`'s spurious-queue guard
 * (`connectors/activitypub/sharingCleanup.service.ts`), where
 * {@link isFediverseSharingEnabled}'s fail-OPEN-on-outage semantics would be
 * actively WRONG for that one call site: reading "enabled" during an outage
 * would make the guard treat a real teardown job as spurious and silently
 * drop it — precisely during the outage window BullMQ's retry budget exists
 * to survive. Every OTHER caller on this module keeps fail-open; only this
 * guard needs the split.
 */
export async function getFediverseSharingStateById(oxyUserId: string): Promise<FediverseSharingState> {
  const { oxy } = await import('../../server');
  let user: FediverseSharingUserView;
  try {
    user = await oxy.getUserById(oxyUserId, { cache: false });
  } catch (error) {
    if (isNotFoundError(error)) return 'unknown-user';
    logger.warn('[FediverseSharing] Oxy lookup failed, treating as unavailable', {
      oxyUserId,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return 'unavailable';
  }

  const enabled = readFlag(user);
  await cacheFlag(oxyUserId, enabled);
  return enabled ? 'enabled' : 'disabled';
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
