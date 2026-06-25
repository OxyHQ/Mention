import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@oxyhq/services';
import { useAgoraConfig } from '../context/AgoraConfigContext';
import type { UserEntity } from '../types';

export function useRoomUsers(userIds: string[]) {
  const { oxyServices } = useAuth();
  const { ensureUserById } = useAgoraConfig();
  const resolvedRef = useRef<Set<string>>(new Set());

  const loader = useCallback(
    async (id: string) => {
      if (!oxyServices) return null;
      try {
        return await oxyServices.getUserById(id);
      } catch {
        return null;
      }
    },
    [oxyServices]
  );

  useEffect(() => {
    if (!userIds.length || !oxyServices) return;
    for (const id of userIds) {
      if (!id || resolvedRef.current.has(id)) continue;
      resolvedRef.current.add(id);
      ensureUserById(id, loader).catch(() => {});
    }
  }, [userIds.join(','), oxyServices, ensureUserById, loader]);
}

export function getDisplayName(userProfile: UserEntity | undefined, userId: string, isCurrentUser?: boolean): string {
  if (isCurrentUser) return 'You';
  // The user source is always an Oxy user DTO (resolved via `oxyServices.getUserById`
  // in `useRoomUsers` → `ensureUserById`), so `name.displayName` is the canonical,
  // API-owned display string and is rendered directly. The `userId` slice is a
  // not-yet-resolved loading fallback, NOT a name recompute.
  if (!userProfile) return userId.slice(0, 10);
  const name = userProfile.name;
  if (typeof name === 'object' && name?.displayName) return name.displayName;
  return userId.slice(0, 10);
}

export function getAvatarUrl(
  userProfile: UserEntity | undefined,
  oxyServices: unknown,
  getCachedFileDownloadUrlSync: (oxyServices: unknown, fileId: string, variant?: string) => string
): string | undefined {
  if (!userProfile?.avatar || !oxyServices) return undefined;
  return getCachedFileDownloadUrlSync(oxyServices, userProfile.avatar, 'thumb');
}
