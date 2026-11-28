/**
 * Session-scoped feed state that is neither a server read nor rendered state.
 *
 * Not persisted: a full reload starts both halves from nothing.
 *
 * Native scroll offsets. Native normally keeps stack screens mounted, but
 * route/tab swaps can still remount a feed, so this keeps a tiny imperative
 * offset map keyed by feed identity (`buildFeedScrollKey`). Web offsets live in
 * Bloom's route-aware scroll primitive.
 *
 * The viewer's local-post revision, which `hooks/useRevealOwnNewPost` answers by
 * scrolling the feed their new post landed in to the top.
 *
 * A feed's loaded pages are not here: on web, and for every scoped feed on
 * native, they live in the React Query cache (`hooks/useFeedQuery`), which is
 * also what a remount warm-starts from.
 */

const nativeFeedScrollOffsets = new Map<string, number>();

/** Read the last native offset observed for a viewer/feed identity. */
export function getFeedScrollOffset(key: string): number {
  return nativeFeedScrollOffsets.get(key) ?? 0;
}

/** Save a native offset without publishing a Zustand update on every scroll. */
export function setFeedScrollOffset(key: string, offset: number): void {
  nativeFeedScrollOffsets.set(key, Math.max(0, offset));
}

/** Drop every remembered offset when the active viewer changes. */
export function clearFeedScrollOffsets(): void {
  nativeFeedScrollOffsets.clear();
}

// How many posts the viewer has published this session, as a revision a feed
// can compare against to know it has a new post of theirs at its top to bring
// into view (`hooks/useRevealOwnNewPost`). Counted for BOTH storage paths, so
// it is advanced by `stores/feedQueryCache.publishNewLocalPost`, which every
// create calls whichever path the feeds read from.
let localPostRevision = 0;
const localPostRevisionListeners = new Set<() => void>();

export function getLocalPostRevision(): number {
  return localPostRevision;
}

export function subscribeToLocalPostRevision(listener: () => void): () => void {
  localPostRevisionListeners.add(listener);
  return () => {
    localPostRevisionListeners.delete(listener);
  };
}

/** Record one more post published by the viewer this session. */
export function advanceLocalPostRevision(): void {
  localPostRevision += 1;
  for (const listener of localPostRevisionListeners) {
    listener();
  }
}
