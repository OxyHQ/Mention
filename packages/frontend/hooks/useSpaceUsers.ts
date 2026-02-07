import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@oxyhq/services';
import { useUsersStore, type UserEntity } from '@/stores/usersStore';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';

/**
 * Resolves an array of user IDs into cached user profiles.
 * Uses the same pattern as NotificationItem and BlockedUsers:
 * tries getProfileById → getProfile → getUserById on oxyServices.
 *
 * Components then use `useUserById(id)` to subscribe to individual profiles.
 */
export function useSpaceUsers(userIds: string[]) {
  const { oxyServices } = useAuth();
  const ensureById = useUsersStore((s) => s.ensureById);
  const resolvedRef = useRef<Set<string>>(new Set());

  const loader = useCallback(
    async (id: string) => {
      const svc = oxyServices as any;
      if (typeof svc?.getProfileById === 'function') {
        try { return await svc.getProfileById(id); } catch {}
      }
      if (typeof svc?.getProfile === 'function') {
        try { return await svc.getProfile(id); } catch {}
      }
      if (typeof svc?.getUserById === 'function') {
        try { return await svc.getUserById(id); } catch {}
      }
      if (typeof svc?.getUser === 'function') {
        try { return await svc.getUser(id); } catch {}
      }
      return null;
    },
    [oxyServices]
  );

  useEffect(() => {
    if (!userIds.length || !oxyServices) return;

    for (const id of userIds) {
      if (!id || resolvedRef.current.has(id)) continue;
      resolvedRef.current.add(id);
      ensureById(id, loader).catch(() => {});
    }
  }, [userIds.join(','), oxyServices, ensureById, loader]);
}

// --- Reusable utility functions for displaying user info ---

/**
 * Get a human-readable display name from a user profile entity.
 * Falls back to a truncated userId if profile isn't loaded yet.
 */
export function getDisplayName(
  userProfile: UserEntity | undefined,
  userId: string,
  isCurrentUser?: boolean
): string {
  if (isCurrentUser) return 'You';
  if (!userProfile) return userId.slice(0, 10);
  const name = userProfile.name;
  if (typeof name === 'object' && name?.full) return name.full;
  if (typeof name === 'string' && name) return name;
  return userProfile.username || userId.slice(0, 10);
}

/**
 * Get a CDN avatar URL from a user profile entity.
 * Returns undefined if no avatar is set or oxyServices isn't available.
 */
export function getAvatarUrl(
  userProfile: UserEntity | undefined,
  oxyServices: any
): string | undefined {
  if (!userProfile?.avatar || !oxyServices) return undefined;
  return getCachedFileDownloadUrlSync(oxyServices, userProfile.avatar, 'thumb');
}
