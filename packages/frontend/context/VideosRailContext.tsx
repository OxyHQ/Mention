import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

/**
 * Snapshot of the currently-active video post, published by the /videos screen
 * and consumed by the desktop rail (rendered inside RightBar). The screen owns
 * the canonical post list and engagement state; this is a read-only projection.
 */
export interface VideosRailActivePost {
  id: string;
  authorId?: string;
  /** True when the viewer authored this post → the rail hides the follow button. */
  authorIsViewer: boolean;
  isLiked: boolean;
  isBoosted: boolean;
  likesCount: number;
  commentsCount: number;
  boostsCount: number;
  viewsCount: number;
}

export interface VideosRailState {
  /** True ONLY while the /videos screen is mounted. */
  active: boolean;
  index: number;
  total: number;
  activePost: VideosRailActivePost | null;
  commentsOpen: boolean;
  commentsPostId: string | null;
  prev: () => void;
  next: () => void;
  onCommentPosted: (postId: string) => void;
}

/**
 * The writable slice of the rail state. The /videos screen pushes a partial
 * update through `setRailState`; everything not provided is preserved.
 */
type VideosRailPatch = Partial<Omit<VideosRailState, never>>;

interface VideosRailContextValue extends VideosRailState {
  /** The /videos screen is the SOLE writer. Merges a partial into the state. */
  setRailState: (patch: VideosRailPatch) => void;
}

const NOOP = () => {};

const DEFAULT_STATE: VideosRailState = {
  active: false,
  index: 0,
  total: 0,
  activePost: null,
  commentsOpen: false,
  commentsPostId: null,
  prev: NOOP,
  next: NOOP,
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
