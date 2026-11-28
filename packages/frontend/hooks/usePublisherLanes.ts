import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import type { Lane } from '@mention/shared-types';
import { lanesService } from '@/services/lanesService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The lanes a post can be put on: the viewer's own, or those of the account it
 * is published AS. A lane belongs to its publisher, and the server refuses a
 * lane whose owner is not the post's author.
 *
 * Only an account's OWNER may read its management list; a mere member gets the
 * public one, which is tab lanes only. The role comes off the account node the
 * caller already holds, so it costs no extra request, and asking the wrong
 * endpoint would answer 403 rather than an empty list.
 */
export function usePublisherLanes(publishAs?: AccountNode | null) {
  const { user, canUsePrivateApi } = useAuth();
  const managesPublisher =
    publishAs != null &&
    (publishAs.relationship === 'owner' || publishAs.callerMembership?.role === 'owner');

  const { data: lanes = [], isLoading } = useQuery<Lane[]>({
    queryKey: publishAs
      ? managesPublisher
        ? viewerQueryKeys.operatedLanes(user?.id, publishAs.accountId)
        : viewerQueryKeys.lanesForOwner(user?.id, publishAs.accountId)
      : viewerQueryKeys.ownedLanes(user?.id),
    queryFn: () => {
      if (!publishAs) return lanesService.listMine();
      return managesPublisher
        ? lanesService.listMine(publishAs.accountId)
        : lanesService.listForOwner(publishAs.accountId);
    },
    enabled: canUsePrivateApi,
  });

  return { lanes, isLoading };
}
