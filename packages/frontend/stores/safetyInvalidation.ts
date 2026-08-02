import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * The single authority for "the viewer changed a safety rule, so what they are
 * allowed to be shown has changed".
 *
 * Two rules sit behind this: the muted words and hashtags
 * (`app/(app)/settings/privacy/hidden-words.tsx`) and the show-sensitive-content
 * toggle (`app/(app)/settings/privacy.tsx`). Both are applied ENTIRELY on the
 * server — a muted post is dropped from the response, a sensitive one never
 * enters the query — so a cache filled before the change keeps showing exactly
 * what the viewer just asked not to see, and no client-held state can correct it.
 *
 * Why this is a refetch signal and not a client-side filter, the way the blocked
 * author list is. Two of the four transitions need content the client was NEVER
 * SENT: unmuting a word and turning sensitive content on both have to ask the
 * server for what it previously withheld, so a filter cannot serve them at all.
 * And the flags the client does hold are not the whole rule — hydration emits
 * `metadata.isSensitive` alone, while the server's verdict is that OR the
 * classifier's OR the federating instance's OR an NSFW hashtag — so a local
 * predicate would hide some sensitive posts and leave others up, which is worse
 * than a filter that does not exist.
 *
 * Mention holds gated content in TWO read caches, and neither can see the other
 * (the same seam `engagementInvalidation` documents):
 *
 *   * React Query owns search results and the notifications list. The server
 *     gates both with these exact two rules.
 *   * The feed store owns every `<Feed>` surface, and warm-starts a remount from
 *     a retained slice rather than refetching.
 *
 * A feed also differs from the engagement lists in one way that decides the
 * design: the viewer changes a safety rule from a settings screen pushed OVER
 * the feed, so the feed is usually still MOUNTED and would never reach its
 * warm-start check. Hence both halves — {@link subscribeToSafetyFilterChanges}
 * converges the feeds already on screen, {@link isFeedCacheStaleForSafety}
 * converges the rest on their next mount.
 */

/** When the viewer last changed a safety rule, in `Date.now()` terms. */
let changedAt = 0;

/** Notified when a safety rule changes, so a mounted feed can refetch. */
type SafetyFilterListener = () => void;

const listeners = new Set<SafetyFilterListener>();

/**
 * Whether a feed cache retained at `retainedAt` predates the viewer's current
 * safety rules — in which case it may still hold content those rules exclude, or
 * still be missing content they now allow.
 *
 * Inclusive for the reason `isFeedCacheStale` in `engagementInvalidation`
 * documents at length: two `Date.now()` stamps can share a millisecond, and a
 * slice retained no later than the change cannot be known to reflect it. Nothing
 * has caught this half yet — a safety rule is changed from a settings screen, so
 * the two stamps are a human apart rather than a millisecond — but the shape is
 * identical and leaving it `<` is choosing to be surprised later. Here the
 * wrong answer is also worse: it leaves up content the viewer just asked not to
 * see.
 */
export function isFeedCacheStaleForSafety(retainedAt: number): boolean {
  return retainedAt <= changedAt;
}

/**
 * Subscribe a mounted feed to safety-rule changes so it refetches without
 * waiting for a remount. Returns an unsubscribe function.
 */
export function subscribeToSafetyFilterChanges(
  listener: SafetyFilterListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Record that the viewer changed a muted word or the sensitive-content toggle,
 * and tell both caches. Call this only after the server has accepted the write:
 * a change that failed leaves every surface exactly as the caches already have
 * it.
 */
export function invalidateSafetyFilters(): void {
  changedAt = Date.now();

  // The two React Query families the server filters with these rules. Search
  // excludes sensitive at the query level and drops muted results after
  // hydration; notifications withhold a gated preview and remove a muted row.
  void queryClient.invalidateQueries({
    predicate: (query) =>
      viewerQueryKeys.isFamily(query.queryKey, 'search')
      || viewerQueryKeys.isFamily(query.queryKey, 'notifications'),
  });

  for (const listener of listeners) {
    listener();
  }
}

/**
 * Drop the recorded change. For tests, and for a viewer switch that clears both
 * caches. Subscriptions belong to mounted feeds and are left alone — a viewer
 * switch unmounts them itself.
 */
export function resetSafetyInvalidation(): void {
  changedAt = 0;
}
