import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth, useSeedFollowStatuses } from '@oxyhq/services';

/** The viewer's following graph stays fresh for 2 minutes — matches the SDK's own
 *  `getViewerGraph()` cache TTL, so this query and the SDK cache expire together. */
const VIEWER_FOLLOWING_STALE_TIME_MS = 2 * 60 * 1000;
const VIEWER_FOLLOWING_GC_TIME_MS = 5 * 60 * 1000;

/**
 * Seeds the shared follow store with the authenticated viewer's following graph so
 * every {@link FollowButton} in the app paints the correct Follow/Following label
 * on first render with ZERO per-button status fetches.
 *
 * The ids are sourced ONCE (per session, then cached) from the SDK's consolidated
 * `getViewerGraph()` — an ids-only, server-bounded (`MAX_FOLLOWING_IDS`, 5000,
 * most-recent first), 2-minute-cached payload — and handed to the SDK's
 * `useSeedFollowStatuses` seeder. Seeding is seed-only-if-absent, so it never
 * clobbers an optimistic value and is safe to re-run on every graph refresh. The
 * SDK's batched follow-status resolver then skips every seeded id, so the only
 * follow-status network call left is one coalesced `getFollowStatuses` for ids the
 * graph did not cover.
 *
 * Call this ONCE at the app root — it feeds every follow button in the app from a
 * single request. Keyed on `viewerId` and gated on `canUsePrivateApi` so it stays
 * inert while anonymous and re-seeds when the cold-boot session lands, per the
 * app's auth-cold-boot reactivity rule.
 */
export function useSeedViewerFollowStatuses(): void {
  const { oxyServices, user, canUsePrivateApi } = useAuth();
  const viewerId = user?.id ?? '';
  const seedFollowStatuses = useSeedFollowStatuses();

  const { data } = useQuery({
    queryKey: ['viewerFollowing', viewerId],
    queryFn: () => oxyServices.getViewerGraph(),
    enabled: canUsePrivateApi && viewerId.length > 0,
    staleTime: VIEWER_FOLLOWING_STALE_TIME_MS,
    gcTime: VIEWER_FOLLOWING_GC_TIME_MS,
  });

  // React Query hands back a stable `data` reference until the graph refetches, so
  // this effect only re-seeds when the following ids actually change (initial load
  // and when the cold-boot session lands) — not on every render.
  const followingIds = data?.followingIds;
  useEffect(() => {
    if (!followingIds || followingIds.length === 0) return;
    const statuses: Record<string, boolean> = {};
    for (const id of followingIds) {
      statuses[id] = true;
    }
    seedFollowStatuses(statuses);
  }, [followingIds, seedFollowStatuses]);
}
