import { useEffect } from 'react';
import type { OxyServices } from '@oxy.so/core';
import { useAuth } from '@oxy.so/services/ui/client';
import type { HeldUser } from '@/data/users';
import { prewarmUsersByIds } from '@/utils/userEnrichment';

type RoomUser = Pick<HeldUser, 'id' | 'name' | 'username' | 'avatar'>;

/**
 * Stores a room's people in the Oxy SDK's `User` in one bulk read (the ones it
 * does not hold yet), without importing the LiveKit-backed Syra package. Rows
 * read them from there (`data/users`).
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
