import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The single authority for "a lane write changed which posts a list contains".
 *
 * A lane is a lens, not a destination — so a lane write never changes a post,
 * only which LIST shows it. That is the whole difference from
 * `stores/engagementInvalidation`, which owns the same job for likes, boosts and
 * saves: those have an optimistic path for the post itself and need help only
 * with list membership, whereas a lane write is list membership and nothing else.
 * The two are deliberately separate modules — a lane write is a different write
 * CLASS, with different surfaces and a different reach — but they share the same
 * hard constraint, so read that file's docstring first if this one is new to you.
 *
 * Mention holds post lists in TWO kinds of read cache, which answer a write
 * differently:
 *
 *   * The lane COLLECTIONS (the management screen, the muted list, a profile's
 *     tab list) are ordinary React Query lists, invalidated like them.
 *   * Every `<Feed>` surface — the profile tabs, the lane tabs, Following, For
 *     You — is a feed cache (a feed query, or SQLite on native) that warm-starts
 *     a remount from the pages it holds rather than refetching page 1. It has no
 *     age-based staleness, so absent a signal it serves those pages until a full
 *     reload.
 *
 * Invalidating the lane collections is therefore a NO-OP on every `<Feed>`
 * surface, which is precisely the half a lane write needs most.
 *
 * Two write classes, because they reach different feeds:
 *
 *   * `mute` — the reader's own filter. It applies to EVERY feed they read
 *     (Following, For You, an author feed, a lane tab), so every feed read that
 *     predates it is stale.
 *   * `assignment` — a post moved between lanes, or a lane's `displayMode`
 *     changed. Both only move posts between the OWNER's own surfaces: their
 *     profile tabs and their lane tabs. The owner is always the acting viewer
 *     (the server scopes both writes by `oxyUserId`), so a feed about somebody
 *     else cannot have changed and is left alone.
 */
export type LaneWriteKind = 'assignment' | 'mute';

/**
 * When each kind of lane write last changed a list, in `Date.now()` terms. A
 * feed cache retained before that moment is out of date; one retained after it
 * already reflects the write.
 */
const changedAt: Record<LaneWriteKind, number> = {
  assignment: 0,
  mute: 0,
};

/**
 * Whether a feed cache retained at `retainedAt` predates a lane write that
 * changed what it contains.
 *
 * `laneId` is the filter the feed was fetched with — set only on a lane tab —
 * and `userId`/`viewerId` are the feed's subject and its reader, exactly as
 * `isFeedCacheStale` receives them.
 */
export function isLaneFeedCacheStale(
  userId: string | undefined,
  viewerId: string | undefined,
  laneId: string | undefined,
  retainedAt: number,
): boolean {
  if (retainedAt < changedAt.mute) return true;
  if (retainedAt >= changedAt.assignment) return false;
  // An assignment reaches the acting viewer's own showcase only: a lane tab
  // (whoever's it is — only the owner can write one) or their own profile.
  return Boolean(laneId) || (Boolean(viewerId) && userId === viewerId);
}

/**
 * Record that a lane write landed, and tell React Query about the collections it
 * owns. Call this only after the server has accepted the write: a failed command
 * leaves every list exactly as the caches already have it.
 *
 * The React Query half is the lane COLLECTIONS, not a post list — no query key
 * holds a list whose post membership a lane changes (the saved screen keeps a
 * saved post whatever lane it moves to). Every post-list surface a lane write
 * reaches is a `<Feed>`, and reads the timestamp above instead.
 */
export function noteLaneListsChanged(kind: LaneWriteKind): void {
  changedAt[kind] = Date.now();
  void queryClient.invalidateQueries({
    predicate: (query) => viewerQueryKeys.isFamily(query.queryKey, 'lanes'),
  });
}

/** Drop the recorded writes. For tests, and for a viewer switch that clears both caches. */
export function resetLaneInvalidation(): void {
  changedAt.assignment = 0;
  changedAt.mute = 0;
}
