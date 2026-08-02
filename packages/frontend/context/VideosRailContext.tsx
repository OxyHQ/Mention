import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

/**
 * Reference to the currently-active video post, published by the /videos screen
 * and consumed by the desktop replies panel (rendered inside RightBar). The
 * screen owns the canonical post list; this is a read-only projection carrying
 * only the id the replies panel keys off.
 */
export interface VideosRailActivePost {
  id: string;
}

export interface VideosRailState {
  /** True ONLY while the /videos screen is mounted. */
  active: boolean;
  activePost: VideosRailActivePost | null;
  onCommentPosted: (postId: string) => void;
  /**
   * Bumped every time the screen asks the replies column to take the caret —
   * what the on-video comment button does on desktop, where the column is
   * already open and there is nothing to toggle. A counter rather than a
   * boolean: two presses in a row must both land, and a flag that is already
   * true would swallow the second.
   */
  focusComposerNonce: number;
}

/**
 * The writable slice of the state. The /videos screen pushes a partial update
 * through `setRailState`; everything not provided is preserved.
 */
type VideosRailPatch = Partial<Omit<VideosRailState, 'focusComposerNonce'>>;

interface VideosRailContextValue extends VideosRailState {
  /** The /videos screen is the SOLE writer. Merges a partial into the state. */
  setRailState: (patch: VideosRailPatch) => void;
  /** Ask the replies column's composer to take the caret. */
  requestComposerFocus: () => void;
}

const NOOP = () => {};

const DEFAULT_STATE: VideosRailState = {
  active: false,
  activePost: null,
  onCommentPosted: NOOP,
  focusComposerNonce: 0,
};

const VideosRailContext = createContext<VideosRailContextValue>({
  ...DEFAULT_STATE,
  setRailState: NOOP,
  requestComposerFocus: NOOP,
});

export function VideosRailProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<VideosRailState>(DEFAULT_STATE);

  const setRailState = useCallback((patch: VideosRailPatch) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  // The nonce is incremented HERE rather than patched by the screen, so the
  // caller stays identity-stable: reading the current value to add one would put
  // it in the screen's press handler's dependencies, and that handler is a
  // dependency of the reel's `renderItem`.
  const requestComposerFocus = useCallback(() => {
    setState((prev) => ({ ...prev, focusComposerNonce: prev.focusComposerNonce + 1 }));
  }, []);

  const value = useMemo<VideosRailContextValue>(
    () => ({ ...state, setRailState, requestComposerFocus }),
    [state, setRailState, requestComposerFocus],
  );

  return (
    <VideosRailContext.Provider value={value}>
      {children}
    </VideosRailContext.Provider>
  );
}

export function useVideosRail() {
  return useContext(VideosRailContext);
}
