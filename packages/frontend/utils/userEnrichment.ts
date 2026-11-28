import { User as UserRecord } from '@oxy.so/services/ui/client';
import { actorWriter } from '@/lib/actorCache';
import type { User } from '@oxy.so/core';

/**
 * For each user missing an avatar, fetch the full profiles in a SINGLE bulk
 * request and merge them into the SDK's `User` (the account's actor cache) via
 * `lib/actorCache`. This avoids the classic N+1 —
 * one HTTP request per missing user — by routing the misses through
 * `oxyServices.users.getMany` (chunked 100/req, deduped) instead of looping
 * `getUserById`. The merge-upsert fills the avatar without stripping any field an
 * authoritative profile fetch already stored (viewer `relationship`, `createdAt`,
 * `_count`), and seeds the by-username entry too when a username is present.
 *
 * Fire-and-forget — callers should NOT await this if they want the UI to render
 * immediately with placeholder avatars. The full profiles fill in reactively as
 * `useUserById` re-reads the primed cache entries.
 */
export function enrichMissingAvatars(
  users: readonly { id: string; avatar?: string; [k: string]: unknown }[],
  getUsersByIds: (ids: string[]) => Promise<User[]>,
): Promise<void> {
  const missingIds = users
    .filter((u) => !u.avatar || !u.avatar.startsWith('http'))
    .map((u) => u.id)
    .filter((id) => id.length > 0);
  if (missingIds.length === 0) return Promise.resolve();

  const actors = actorWriter();
  return getUsersByIds(missingIds)
    .then((fetched) => {
      actors.cacheActors(fetched.filter((user) => Boolean(user?.id)));
    })
    .catch(() => {
      // Avatar enrichment is best-effort: placeholders stay in place on failure.
    });
}

/**
 * Warm the SDK's `User` for a set of user ids in a SINGLE bulk request,
 * skipping ids it already holds in memory. Each fetched
 * profile is merge-upserted via `lib/actorCache` so per-row reads
 * (e.g. a list whose rows resolve a user by id) hit the warm cache instead of
 * firing one HTTP request per row — the classic N+1 — without clobbering any
 * field an authoritative fetch already stored. Best-effort: resolves to `[]` on
 * failure so callers degrade to their own per-row resolution.
 *
 * Reads and writes the signed-in account's store (the one `lib/actorCache`
 * writes), captured before the request, so an answer that lands after an
 * account switch primes nothing of the next account.
 */
export function prewarmUsersByIds(
  ids: readonly string[],
  getUsersByIds: (ids: string[]) => Promise<User[]>,
): Promise<User[]> {
  const toFetch = Array.from(new Set(ids.filter((id) => id.length > 0))).filter(
    (id) => !UserRecord.has(id),
  );
  if (toFetch.length === 0) return Promise.resolve([]);

  const actors = actorWriter();
  return getUsersByIds(toFetch)
    .then((fetched) => {
      actors.cacheActors(fetched.filter((user) => Boolean(user?.id)));
      return fetched;
    })
    .catch(() => []);
}
