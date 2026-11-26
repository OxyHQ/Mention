import { useEffect } from 'react';
import type { OxyServices, User } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services/ui/client';
import { prewarmUsersByIds } from '@/utils/userEnrichment';

type RoomUser = Pick<User, 'id' | 'name' | 'username' | 'avatar'>;

/**
 * Warms the SDK's `User` for room participants (one batch, only the ids it
 * does not hold) without importing the LiveKit-backed Syra package. Rendering
 * reads the same records (`useEntities(User, ids)`, `useUserById`).
 */
export function useRoomUsers(userIds: string[]) {
  const { oxyServices } = useAuth();
  const stableIds = [...new Set(userIds.filter(Boolean))].sort().join(',');

  useEffect(() => {
    if (!stableIds || !oxyServices) return;
    void prewarmUsersByIds(stableIds.split(','), (ids) => oxyServices.users.getMany(ids));
  }, [stableIds, oxyServices]);
}

export function getDisplayName(
  userProfile: RoomUser | undefined,
  userId: string,
  isCurrentUser?: boolean,
): string {
  if (isCurrentUser) return 'You';
  return userProfile?.name?.displayName || userId.slice(0, 10);
}

export function getAvatarUrl(
  userProfile: RoomUser | undefined,
  oxyServices: Pick<OxyServices, 'assets'> | null | undefined,
): string | undefined {
  if (!userProfile?.avatar || !oxyServices) return undefined;
  return oxyServices.assets.renderUrl(userProfile.avatar, 'thumb');
}
