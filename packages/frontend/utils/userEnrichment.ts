import { useUsersStore } from '@/stores/usersStore';

/**
 * For each user missing an avatar, fetch the full profile and merge it into
 * the users store. Per-user errors are silently ignored so one bad profile
 * does not block the rest.
 *
 * Fire-and-forget — callers should NOT await this if they want the UI to
 * render immediately with placeholder avatars.
 */
export function enrichMissingAvatars(
  users: ReadonlyArray<{ id: string; avatar?: string; [k: string]: unknown }>,
  getUserById: (id: string) => Promise<unknown>,
): Promise<void> {
  const store = useUsersStore.getState();
  const missing = users.filter((u) => !u.avatar);
  if (missing.length === 0) return Promise.resolve();

  return Promise.all(
    missing.map((u) =>
      store.ensureById(u.id, (id) => getUserById(id) as any).catch(() => {})
    ),
  ).then(() => {});
}
