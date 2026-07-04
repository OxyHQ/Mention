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
}

/**
 * The writable slice of the state. The /videos screen pushes a partial update
 * through `setRailState`; everything not provided is preserved.
 */
type VideosRailPatch = Partial<VideosRailState>;

interface VideosRailContextValue extends VideosRailState {
  /** The /videos screen is the SOLE writer. Merges a partial into the state. */
  setRailState: (patch: VideosRailPatch) => void;
}

const NOOP = () => {};

const DEFAULT_STATE: VideosRailState = {
  active: false,
  activePost: null,
  onCommentPosted: NOOP,
};

const VideosRailContext = createContext<VideosRailContextValue>({
  ...DEFAULT_STATE,
  setRailState: NOOP,
});

export function VideosRailProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<VideosRailState>(DEFAULT_STATE);

  const setRailState = useCallback((patch: VideosRailPatch) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  const value = useMemo<VideosRailContextValue>(
    () => ({ ...state, setRailState }),
    [state, setRailState],
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
