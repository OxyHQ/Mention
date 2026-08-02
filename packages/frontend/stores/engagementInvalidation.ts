import type { FeedType } from '@mention/shared-types';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The single authority for "an engagement write changed which posts a list
 * contains".
 *
 * Liking, boosting and saving all do two things: they change the post itself
 * (handled optimistically by `postsStore.updatePostEverywhere`, which is why the
 * button flips instantly everywhere) and they change the MEMBERSHIP of a list on
 * another surface — the viewer's likes tab, boosts tab, and saved screen. The
 * second half has no optimistic path: those lists are server-ordered and paged,
 * so the only correct response is to let their caches know they are out of date.
 *
 * Mention holds those lists in TWO read caches, and neither can see the other:
 *
 *   * React Query owns the saved screen (`app/(app)/saved.tsx`).
 *   * The feed store owns every `<Feed>` surface, including the profile likes
 *     and boosts tabs, and warm-starts them from a retained slice on remount.
 *
 * So a write has to speak to both, and it must do so from ONE place or the two
 * will drift — which is exactly how this broke: the saved screen was told and
 * the likes/boosts tabs were not. `invalidateEngagementLists` is that place, and
 * `postsStore` calls it from every engagement write that succeeds.
 *
 * Nothing here needs the viewer's id. Only the acting viewer's own lists can
 * change, and an account switch already drops the previous viewer's React Query
 * namespace (`clearViewerQueryCache`) and every retained feed slice
 * (`clearAllFeedMemoryCaches`), so "this family, whoever it belongs to" and
 * "this family, for the signed-in viewer" describe the same entries.
 *
 * This module is the authority for ENGAGEMENT writes only. A lane write — moving
 * a post between lanes, changing a lane's `displayMode`, muting one — changes
 * list membership too, but it is a different write class reaching different
 * surfaces, and `stores/laneInvalidation` owns it. Both must be consulted by any
 * feed deciding whether its retained slice is still good; neither subsumes the
 * other.
 */
export type EngagementKind = 'like' | 'boost' | 'save';

/**
 * When each kind of engagement last changed a list, in `Date.now()` terms. A
 * feed cache retained before that moment is out of date; one retained after it
 * already reflects the write.
 */
const changedAt: Record<EngagementKind, number> = {
  like: 0,
  boost: 0,
  save: 0,
};

/**
 * The engagement whose writes change this feed's membership, or `null` when no
 * engagement can.
 *
 * A likes or boosts feed lists what ONE account engaged with, so only that
 * account's own writes change it — which is why the viewer has to match the
 * profile being read. The saved feed is private to the viewer and carries no
 * subject at all.
 */
export function engagementKindForFeed(
  type: FeedType,
  userId: string | undefined,
  viewerId: string | undefined,
): EngagementKind | null {
  if (type === 'saved') return 'save';
  const isOwnList = Boolean(viewerId) && userId === viewerId;
  if (!isOwnList) return null;
  if (type === 'likes') return 'like';
  if (type === 'boosts') return 'boost';
  return null;
}

/** Whether a feed cache retained at `retainedAt` predates the write it must show. */
export function isFeedCacheStale(
  type: FeedType,
  userId: string | undefined,
  viewerId: string | undefined,
  retainedAt: number,
): boolean {
  const kind = engagementKindForFeed(type, userId, viewerId);
  return kind === null ? false : retainedAt < changedAt[kind];
}

/**
 * Record that an engagement write landed, and tell React Query about the lists
 * it owns. Call this only after the server has accepted the write: a failed
 * command leaves every list exactly as the caches already have it.
 */
export function invalidateEngagementLists(kind: EngagementKind): void {
  changedAt[kind] = Date.now();

  // The saved screen is the one engagement list React Query owns; the likes and
  // boosts tabs are `<Feed>` surfaces and read the timestamp above instead.
  if (kind === 'save') {
    void queryClient.invalidateQueries({
      predicate: (query) => viewerQueryKeys.isFamily(query.queryKey, 'saved-posts'),
    });
  }
}

/** Drop the recorded writes. For tests, and for a viewer switch that clears both caches. */
export function resetEngagementInvalidation(): void {
  changedAt.like = 0;
  changedAt.boost = 0;
  changedAt.save = 0;
}
