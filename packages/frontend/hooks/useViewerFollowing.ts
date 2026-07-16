import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services';

/** The viewer's following set stays fresh for 2 minutes — matches the SDK's own
 *  `getViewerGraph()` cache TTL, so this query and the SDK cache expire together. */
const VIEWER_FOLLOWING_STALE_TIME_MS = 2 * 60 * 1000;
const VIEWER_FOLLOWING_GC_TIME_MS = 5 * 60 * 1000;

/**
 * The set of user ids the authenticated viewer follows.
 *
 * Sourced ONCE (per session, then cached) from the SDK's consolidated
 * `getViewerGraph()` — an ids-only, server-bounded (`MAX_FOLLOWING_IDS`, 5000,
 * most-recent first), 2-minute-cached payload. A single shared React Query owner
 * keyed on the viewer id, so every surface that renders follow buttons reads ONE
 * app-wide request instead of each button probing its own status first.
 *
 * Consumers use it to seed each {@link FollowButton}'s `initiallyFollowing`, so a
 * user the viewer already follows renders "Following" on mount instead of
 * flashing "Follow" until the per-button follow-status fetch resolves.
 *
 * Keyed on `viewerId` (and gated on `canUsePrivateApi`) so it stays empty while
 * anonymous and reloads when the cold-boot session lands, per the app's
 * auth-cold-boot reactivity rule.
 */
export function useViewerFollowingSet(): Set<string> {
  const { oxyServices, user, canUsePrivateApi } = useAuth();
  const viewerId = user?.id ?? '';

  const { data } = useQuery({
    queryKey: ['viewerFollowing', viewerId],
    queryFn: () => oxyServices.getViewerGraph(),
    enabled: canUsePrivateApi && viewerId.length > 0,
    staleTime: VIEWER_FOLLOWING_STALE_TIME_MS,
    gcTime: VIEWER_FOLLOWING_GC_TIME_MS,
  });

  return useMemo(() => new Set(data?.followingIds ?? []), [data]);
}
