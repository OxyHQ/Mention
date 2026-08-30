import type { PostUser } from '@mention/shared-types';
import { config } from '../config';
import { createCache } from '../utils/cache';

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
 * Design constraints:
 *  - Storage, TTL and the fail-open contract come from the shared
 *    {@link createCache} primitive — this module owns only the key, the value
 *    shape and the BATCH access pattern hydration needs.
 *  - When Redis is unavailable (no `REDIS_URL`, or the server is down) every
 *    operation degrades to a no-op: hydration still works, it just resolves
 *    every author from Oxy each time.
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
 *  - `v4` — adds the bounded `starterPackScore` (ranking-side, see
 *    {@link CachedUserSummary}).
 *  - `v5` — the cached Oxy user now carries `kind` (the account
 *    classification), which the reply gate reads off `user.kind`.
 */
const USER_SUMMARY_PREFIX = 'usersummary:v5:';

/**
 * TTL for a cached summary. Display name / avatar / verification change rarely;
 * ten minutes keeps the feed fresh while still absorbing the burst of repeated
 * lookups within a browsing session. Tunable via env without a redeploy.
 */
const SUMMARY_TTL_SECONDS = config.cache.userSummaryTtlSeconds;

/**
 * The cached value: the raw canonical Oxy {@link PostUser} plus the RANKING-side
 * facts about that account which never belong on a post DTO — the follower count
 * (authority signal), the account's languages (the viewer-language signal), and
 * the starter-pack curation score (the `starterPackBoost` signal).
 *
 * All three are OPTIONAL: a user whose count was unavailable, who set no account
 * languages, or whom nobody curated simply omits the field and the corresponding
 * signal falls back to its neutral multiplier.
 *
 * The account `kind` is NOT one of them — it lives on `user.kind`, because it is
 * part of the Oxy user DTO rather than a Mention-side signal. `services/publishAsAccount`
 * reads it from there, which is what keeps ONE copy of it: a second field here
 * would be free to disagree with the one the DTO ships.
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
  /**
   * The bounded starter-pack CURATION score for this account — how strongly OTHER
   * people curated them into starter packs that newcomers actually used (see
   * `services/starterPackCuration.ts`). Computed once per cache-fill (one batched
   * aggregation for the whole author batch) and read back on every warm hydration,
   * so the `starterPackBoost` ranking signal costs no per-post query. RANKING-side
   * only: like `followerCount`, it never ships on the {@link PostUser} DTO.
   * Absent ⇒ uncurated (or unresolvable) ⇒ the signal is exactly neutral.
   */
  starterPackScore?: number;
}

/** Hash-free key: Oxy user ids are already short and bounded, so embed them directly. */
function keyFor(userId: string): string {
  return `${USER_SUMMARY_PREFIX}${userId}`;
}

const cache = createCache({ name: 'UserSummaryCache', ttlSeconds: SUMMARY_TTL_SECONDS });

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

  const values = await cache.getMany<CachedUserSummary>(userIds.map(keyFor));
  values.forEach((value, index) => {
    if (value) result.set(userIds[index], value);
  });
  return result;
}

/**
 * Write resolved summaries back to the cache with a TTL. A write failure must
 * never affect hydration, so any error degrades to a no-op.
 *
 * Callers decide what is CACHEABLE: {@link PostHydrationService} passes only
 * genuinely resolved authors here, never the degraded `'Unknown user'` summary
 * it hands the renderer for an author Oxy could not resolve.
 */
export async function mset(entries: Map<string, CachedUserSummary>): Promise<void> {
  if (entries.size === 0) {
    return;
  }

  await cache.setMany(
    [...entries].map(([userId, value]) => [keyFor(userId), value] as const),
  );
}

/**
 * Evict cached identities for a set of user ids so the next hydration re-reads
 * the authoritative Oxy user. Called from the federated-actor identity bridge
 * ({@link resolveOxyExternalUser}) after a successful re-resolve — an avatar or
 * display-name refresh on a federated actor must not be masked by a warm 10-min
 * cache entry. A failure degrades to a no-op (the entry simply ages out via TTL).
 */
export async function invalidate(userIds: string[]): Promise<void> {
  await cache.delete(userIds.map(keyFor));
}
