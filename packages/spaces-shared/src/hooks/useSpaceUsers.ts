import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@oxyhq/services';
import { useSpacesConfig } from '../context/SpacesConfigContext';
import type { UserEntity } from '../types';

export function useSpaceUsers(userIds: string[]) {
  const { oxyServices } = useAuth();
  const { ensureUserById } = useSpacesConfig();
  const resolvedRef = useRef<Set<string>>(new Set());

  const loader = useCallback(
    async (id: string) => {
      const svc = oxyServices as any;
      if (typeof svc?.getProfileById === 'function') { try { return await svc.getProfileById(id); } catch {} }
      if (typeof svc?.getProfile === 'function') { try { return await svc.getProfile(id); } catch {} }
      if (typeof svc?.getUserById === 'function') { try { return await svc.getUserById(id); } catch {} }
      if (typeof svc?.getUser === 'function') { try { return await svc.getUser(id); } catch {} }
      return null;
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
  if (!userProfile) return userId.slice(0, 10);
  const name = userProfile.name;
  if (typeof name === 'object' && name?.full) return name.full;
  if (typeof name === 'string' && name) return name;
  return userProfile.username || userId.slice(0, 10);
}

export function getAvatarUrl(
  userProfile: UserEntity | undefined,
  oxyServices: any,
  getCachedFileDownloadUrlSync: (oxyServices: any, fileId: string, variant?: string) => string
): string | undefined {
  if (!userProfile?.avatar || !oxyServices) return undefined;
  return getCachedFileDownloadUrlSync(oxyServices, userProfile.avatar, 'thumb');
}
