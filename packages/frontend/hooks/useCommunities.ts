import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import type { PostUser } from '@mention/shared-types';
import type { User } from '@oxy.so/core';
import { communityService } from '@/services/communityService';
import { refreshPrivacyLists } from '@/services/privacyService';
import { publicQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';

const MODERATORS_STALE_MS = 5 * 60 * 1000;

/** The communities the viewer joined, hosted here or remote — where the composer may post. */
export function useJoinedCommunities(enabled = true) {
  const { user, canUsePrivateApi } = useAuth();
  return useQuery<PostUser[]>({
    queryKey: viewerQueryKeys.joinedCommunities(user?.id),
    queryFn: () => communityService.joined(),
    enabled: canUsePrivateApi && enabled,
  });
}

/**
 * What creating an account of `kind` changed in the viewer's joined
 * communities. Oxy joins a community's creator to it as it is created (the
 * creator now follows it), so after a community this drops Mention's cached
 * copy of the viewer's relations and then the joined list, so the refetch reads
 * the new follow; any other kind changed nothing here.
 */
export function useRefreshJoinedCommunitiesAfterCreate() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  return useCallback(
    async (kind: string) => {
      if (kind !== 'community') return;
      await refreshPrivacyLists();
      await queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.joinedCommunities(user?.id),
      });
    },
    [queryClient, user?.id],
  );
}

/** A community's moderators, as Oxy publishes them (public). */
export function useCommunityModerators(communityId: string | null | undefined) {
  const { oxyServices } = useAuth();
  return useQuery<User[]>({
    queryKey: publicQueryKeys.communityModerators(communityId ?? ''),
    queryFn: () => oxyServices.users.moderators(communityId ?? ''),
    enabled: Boolean(communityId),
    staleTime: MODERATORS_STALE_MS,
  });
}
