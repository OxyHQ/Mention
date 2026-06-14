/**
 * List mutation propagation.
 *
 * Custom lists power two things that must update the instant a list changes:
 *   1. React Query caches keyed `['list', id]` / `['lists']` (list UIs).
 *   2. List-backed feeds. These feeds are NOT React Query — `lists/[id].tsx`
 *      and the custom feeds in `feeds/[id].tsx` imperatively fetch the list,
 *      derive `memberOxyUserIds`, and pass them to `<Feed filters={{ authors }} />`.
 *      The feed only re-fetches when its `authors` filter changes, so after a
 *      membership change the *list* must be re-fetched to produce new authors.
 *
 * `notifyListChanged` is the single choke point every list mutation calls. It
 * invalidates the React Query caches AND broadcasts to imperative subscribers
 * (the list-backed feed screens) so they re-fetch the list → new `authors` →
 * `<Feed>` re-fetches automatically. No manual refresh, no TTL wait.
 *
 * This is intentionally NOT a Zustand slice — subscribers are imperative screen
 * effects, mirroring `subscribeToNewLocalPosts` in `feedScrollStore`.
 */

import { queryClient } from '@/lib/queryClient';
import { queryKeys } from '@/hooks/useOptimizedQuery';

/** Fired with the id of the list that changed, or `null` for create/delete that
 *  has no single relevant id to a viewing screen (the list collection changed). */
export type ListChangeListener = (listId: string | null) => void;

const listChangeListeners = new Set<ListChangeListener>();

/**
 * Subscribe to list mutations. A list-backed screen uses this to re-fetch its
 * list (and therefore its feed authors) when membership/metadata changes.
 * Returns an unsubscribe function.
 */
export function subscribeToListChanges(listener: ListChangeListener): () => void {
  listChangeListeners.add(listener);
  return () => {
    listChangeListeners.delete(listener);
  };
}

/**
 * Announce that a list changed (members added/removed, created, renamed,
 * deleted). Invalidates the React Query caches the list UIs read, the feed
 * caches, and notifies the imperative list-backed feed screens to re-fetch.
 *
 * @param listId The affected list id, or `null` when the change is to the list
 *   collection as a whole (create/delete) with no specific viewing target.
 */
export function notifyListChanged(listId: string | null): void {
  // 1. React Query: the list detail + the user's list collection.
  if (listId) {
    queryClient.invalidateQueries({ queryKey: queryKeys.list(listId) });
  }
  queryClient.invalidateQueries({ queryKey: queryKeys.lists() });

  // 2. React Query: any feed query (custom feeds backed by this list read the
  //    feed cache). The list-backed `<Feed>` itself is memory-mode and is
  //    handled by the imperative broadcast below, but custom feeds and any
  //    React-Query-driven feed consumers are refreshed here.
  queryClient.invalidateQueries({ queryKey: queryKeys.feed('custom') });

  // 3. Imperative subscribers: list-backed feed screens re-fetch the list,
  //    producing a new `authors` filter that makes `<Feed>` re-fetch.
  for (const listener of listChangeListeners) {
    listener(listId);
  }
}
