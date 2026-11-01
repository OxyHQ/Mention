import { create } from 'zustand';

/**
 * Ephemeral hover state for thread "units" in the feed.
 *
 * A thread (a multi-post slice) renders as several sibling feed rows that all
 * share one `sliceKey`. Hovering any one of those rows should highlight the
 * WHOLE thread — every post plus the "Show this thread" affordance — so the
 * thread reads as a single unit. CSS `group-hover` can't express that (each
 * post is its own `.group`), so the hovered slice key lives here and every
 * thread row reads it via a selector that returns only ITS boolean, keeping
 * re-renders scoped to the rows whose active state actually flips.
 *
 * Not persisted: this is transient UI state for the current pointer position.
 */
interface ThreadHoverStore {
  hoveredSliceKey: string | null;
  owner: object | null;
}

export const useThreadHoverStore = create<ThreadHoverStore>(() => ({
  hoveredSliceKey: null,
  owner: null,
}));

/** Own the current pointer gesture by component instance, not by post id. */
export function enterThreadHover(key: string, owner: object): void {
  useThreadHoverStore.setState({ hoveredSliceKey: key, owner });
}

/** A recycled/unmounted row or a late hover-out must not clear another row's hover. */
export function leaveThreadHover(owner: object, key: string): void {
  useThreadHoverStore.setState((state) =>
    state.owner === owner && state.hoveredSliceKey === key
      ? { hoveredSliceKey: null, owner: null }
      : state,
  );
}
