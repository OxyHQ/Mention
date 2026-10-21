import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import type { PostUser } from '@mention/shared-types';
import type { User } from '@oxy.so/core';
import { communityService } from '@/services/communityService';
import { publicQueryKeys, viewerQueryKeys } from '@/lib/viewerQueryKeys';

const MODERATORS_STALE_MS = 5 * 60 * 1000;

/** The communities hosted here the viewer joined — where the composer may post. */
export function useJoinedCommunities(enabled = true) {
  const { user, canUsePrivateApi } = useAuth();
  return useQuery<PostUser[]>({
    queryKey: viewerQueryKeys.joinedCommunities(user?.id),
    queryFn: () => communityService.joined(),
    enabled: canUsePrivateApi && enabled,
  });
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
