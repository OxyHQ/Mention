import type { QueryClient } from '@tanstack/react-query';
import { queryKeys } from '@oxyhq/services';
import type { User } from '@oxyhq/core';

/**
 * For each user missing an avatar, fetch the full profile and write it into the
 * React Query cache (the single in-memory actor cache). Per-user errors are
 * silently swallowed so one bad profile does not block the rest.
 *
 * Fire-and-forget — callers should NOT await this if they want the UI to render
 * immediately with placeholder avatars. The full profiles fill in reactively as
 * `useUserById` re-reads the primed cache entries.
 */
export function enrichMissingAvatars(
  users: readonly { id: string; avatar?: string; [k: string]: unknown }[],
  getUserById: (id: string) => Promise<User | null | undefined>,
  queryClient: QueryClient,
): Promise<void> {
  const missing = users.filter(
    (u) => !u.avatar || (typeof u.avatar === 'string' && !u.avatar.startsWith('http')),
  );
  if (missing.length === 0) return Promise.resolve();

  return Promise.all(
    missing.map((u) =>
      getUserById(u.id)
        .then((user) => {
          if (user?.id) {
            queryClient.setQueryData(queryKeys.users.detail(user.id), user);
          }
        })
        .catch(() => {}),
    ),
  ).then(() => {});
}
