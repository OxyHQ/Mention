import { useEffect } from 'react';
import type { User } from '@oxyhq/core';
import { queryKeys } from '@oxyhq/services';
import { useAuth } from '@oxyhq/services/ui/client';
import { queryClient } from '@/lib/queryClient';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';

type RoomUser = Pick<User, 'id' | 'name' | 'username' | 'avatar'>;

/**
 * Warms the shared Oxy user cache for room participants without importing the
 * LiveKit-backed Syra package. Rendering reads the same cache via useUserById.
 */
export function useRoomUsers(userIds: string[]) {
  const { oxyServices } = useAuth();
  const stableIds = [...new Set(userIds.filter(Boolean))].sort().join(',');

  useEffect(() => {
    if (!stableIds || !oxyServices) return;
    const ids = stableIds.split(',');
    void Promise.allSettled(
      ids.map((id) =>
        queryClient.prefetchQuery({
          queryKey: queryKeys.users.detail(id),
          queryFn: () => oxyServices.getUserById(id),
          staleTime: 5 * 60 * 1000,
        }),
      ),
    );
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
  oxyServices: unknown,
): string | undefined {
  if (!userProfile?.avatar || !oxyServices) return undefined;
  return getCachedFileDownloadUrlSync(oxyServices, userProfile.avatar, 'thumb');
}
