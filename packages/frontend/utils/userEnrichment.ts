import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@oxyhq/services';
import type { User } from '@oxyhq/core';

/**
 * For each user missing an avatar, fetch the full profiles in a SINGLE bulk
 * request and write them into the React Query cache (the single in-memory actor
 * cache). This avoids the classic N+1 — one HTTP request per missing user —
 * by routing the misses through `oxyServices.getUsersByIds` (chunked 100/req,
 * deduped) instead of looping `getUserById`.
 *
 * Fire-and-forget — callers should NOT await this if they want the UI to render
 * immediately with placeholder avatars. The full profiles fill in reactively as
 * `useUserById` re-reads the primed cache entries.
 */
export function enrichMissingAvatars(
  users: readonly { id: string; avatar?: string; [k: string]: unknown }[],
  getUsersByIds: (ids: string[]) => Promise<User[]>,
  queryClient: QueryClient,
): Promise<void> {
  const missingIds = users
    .filter((u) => !u.avatar || !u.avatar.startsWith('http'))
    .map((u) => u.id)
    .filter((id) => id.length > 0);
  if (missingIds.length === 0) return Promise.resolve();

  return getUsersByIds(missingIds)
    .then((fetched) => {
      for (const user of fetched) {
        if (user?.id) {
          queryClient.setQueryData(queryKeys.users.detail(user.id), user);
        }
      }
    })
    .catch(() => {
      // Avatar enrichment is best-effort: placeholders stay in place on failure.
    });
}

/**
 * Warm the React Query user cache for a set of user ids in a SINGLE bulk request,
 * skipping ids already cached. Each fetched profile is written to
 * `queryKeys.users.detail(id)` so per-row reads (e.g. a list whose rows resolve a
 * user by id) hit the warm cache instead of firing one HTTP request per row — the
 * classic N+1. Best-effort: resolves to `[]` on failure so callers degrade to
 * their own per-row resolution.
 */
export function prewarmUsersByIds(
  ids: readonly string[],
  getUsersByIds: (ids: string[]) => Promise<User[]>,
  queryClient: QueryClient,
): Promise<User[]> {
  const toFetch = Array.from(new Set(ids.filter((id) => id.length > 0))).filter(
    (id) => !queryClient.getQueryData(queryKeys.users.detail(id)),
  );
  if (toFetch.length === 0) return Promise.resolve([]);

  return getUsersByIds(toFetch)
    .then((fetched) => {
      for (const user of fetched) {
        if (user?.id) {
          queryClient.setQueryData(queryKeys.users.detail(user.id), user);
        }
      }
      return fetched;
    })
    .catch(() => []);
}
