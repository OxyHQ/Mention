import { useQuery } from '@tanstack/react-query';
import type { BlockedUser, RestrictedUser } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import { useAuth } from '@oxy.so/services/ui/client';
import { queryClient } from '@/lib/queryClient';
import { type ViewerId, viewerQueryKeys } from '@/lib/viewerQueryKeys';

/** Blocks and restrictions change rarely and every write updates the entry. */
const PRIVACY_LISTS_STALE_TIME_MS = 2 * 60 * 1000;

interface PrivacyLists {
  blockedIds: string[];
  restrictedIds: string[];
}

export interface PrivacySets {
  blockedSet: ReadonlySet<string>;
  restrictedSet: ReadonlySet<string>;
}

const EMPTY_LISTS: PrivacyLists = { blockedIds: [], restrictedIds: [] };
const EMPTY_SETS: PrivacySets = { blockedSet: new Set(), restrictedSet: new Set() };

function extractListId(entry: BlockedUser | RestrictedUser): string | undefined {
  const target = 'blockedId' in entry ? entry.blockedId : entry.restrictedId;
  if (target) {
    return typeof target === 'string' ? target : target._id;
  }
  return entry._id ?? entry.userId;
}

function toIds(entries: (BlockedUser | RestrictedUser)[] | undefined): string[] {
  return Array.isArray(entries)
    ? entries.map(extractListId).filter((id): id is string => Boolean(id))
    : [];
}

// Module-level so React Query memoizes the Sets per fetched list: a refetch
// whose ids are unchanged keeps the same arrays (structural sharing) and so
// the same Sets, and the feeds filtering on them do not recompute.
function toSets(lists: PrivacyLists): PrivacySets {
  return { blockedSet: new Set(lists.blockedIds), restrictedSet: new Set(lists.restrictedIds) };
}

/**
 * The viewer's Oxy block and restrict lists, read once per viewer for the whole
 * app and kept for two minutes. Keyed by the viewer, so an account switch never
 * reads the previous account's lists, and gated on `canUsePrivateApi`, so cold
 * boot never fires the read before a usable session exists.
 */
export function usePrivacyControls(): PrivacySets {
  const { oxyServices, canUsePrivateApi, user } = useAuth();
  const viewerId = user?.id;

  const { data } = useQuery({
    queryKey: viewerQueryKeys.privacyLists(viewerId),
    queryFn: async (): Promise<PrivacyLists> => {
      try {
        const [blocked, restricted] = await Promise.all([
          oxyServices.privacy.blocked(),
          oxyServices.privacy.restricted(),
        ]);
        return { blockedIds: toIds(blocked), restrictedIds: toIds(restricted) };
      } catch (error) {
        // Fail quietly and hold the empty answer for the stale window: the
        // server filters blocked accounts itself, and a failing read retried on
        // every feed mount is the request storm this replaced.
        logger.error('[usePrivacyControls] Unable to load privacy lists', error);
        return EMPTY_LISTS;
      }
    },
    enabled: canUsePrivateApi && Boolean(viewerId) && Boolean(oxyServices),
    staleTime: PRIVACY_LISTS_STALE_TIME_MS,
    select: toSets,
  });

  return data ?? EMPTY_SETS;
}

/**
 * Records a block or restriction the viewer just wrote, so every feed acts on it
 * now instead of when the held lists go stale.
 */
export function setPrivacyListMembership(
  viewerId: ViewerId,
  list: 'blocked' | 'restricted',
  userId: string,
  member: boolean,
): void {
  queryClient.setQueryData<PrivacyLists>(viewerQueryKeys.privacyLists(viewerId), (current) => {
    if (!current) return current;
    const key = list === 'blocked' ? 'blockedIds' : 'restrictedIds';
    const ids = current[key].filter((id) => id !== userId);
    return { ...current, [key]: member ? [...ids, userId] : ids };
  });
}
