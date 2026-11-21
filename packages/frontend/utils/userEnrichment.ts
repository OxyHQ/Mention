import { storeUsers, User } from '@oxy.so/services/ui/client';
import type { User as OxyUser } from '@oxy.so/core';

/**
 * For each user missing an avatar, fetch the full profiles in a SINGLE bulk
 * request and store them in the Oxy SDK's `User` (`storeUsers`). This avoids the
 * classic N+1 — one HTTP request per missing user — by routing the misses
 * through `oxyServices.users.getMany` (chunked 100/req, deduped) instead of
 * looping `getUserById`. `User` merges what it is given, so the avatar fills in
 * without stripping any field an authoritative profile read already stored
 * (viewer `relationship`, `createdAt`, `_count`).
 *
 * Fire-and-forget — callers should NOT await this if they want the UI to render
 * immediately with placeholder avatars. The full profiles fill in reactively on
 * every row that reads the person from `User` (`data/users`).
 */
export function enrichMissingAvatars(
  users: readonly { id: string; avatar?: string; [k: string]: unknown }[],
  getUsersByIds: (ids: string[]) => Promise<OxyUser[]>,
): Promise<void> {
  const missingIds = users
    .filter((u) => !u.avatar || !u.avatar.startsWith('http'))
    .map((u) => u.id)
    .filter((id) => id.length > 0);
  if (missingIds.length === 0) return Promise.resolve();

  return getUsersByIds(missingIds)
    .then((fetched) => storeUsers(fetched))
    .catch(() => {
      // Avatar enrichment is best-effort: placeholders stay in place on failure.
    });
}

/**
 * Fetch the people `ids` names that `User` does not hold yet, in a SINGLE bulk
 * request, and store them there, so per-row reads (a list whose rows resolve a
 * person by id) find them instead of firing one HTTP request per row — the
 * classic N+1. Best-effort: resolves to `[]` on failure so callers degrade to
 * their own per-row resolution.
 */
export function prewarmUsersByIds(
  ids: readonly string[],
  getUsersByIds: (ids: string[]) => Promise<OxyUser[]>,
): Promise<OxyUser[]> {
  const toFetch = Array.from(new Set(ids.filter((id) => id.length > 0))).filter(
    (id) => !User.has(id),
  );
  if (toFetch.length === 0) return Promise.resolve([]);

  return getUsersByIds(toFetch)
    .then((fetched) => {
      storeUsers(fetched);
      return fetched;
    })
    .catch(() => []);
}
