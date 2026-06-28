import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform, useWindowDimensions } from 'react-native';

/**
 * "Only the on-screen video plays" coordinator — a faithful port of Bluesky's
 * web `ActiveVideoWebContext`. One shared context tracks which feed video is the
 * single active one: each video reports its viewport center-Y and the one
 * closest to `windowHeight / 2.5` wins. A video the viewer manually pressed play
 * on keeps priority while it stays within the viewport.
 *
 * Web-centric: the position-driven selection only runs on web (where consumers
 * attach an `IntersectionObserver` and call `sendPosition`). On native — and
 * whenever NO `ActiveVideoProvider` is mounted above a consumer (e.g. the reels
 * screen or any `VideoPlayer` used outside the feed) — `useActiveVideo` returns
 * `active: true` so playback falls back to today's autoplay behavior.
 */

const IS_WEB = Platform.OS === 'web';

interface ActiveVideoContextValue {
  activeViewId: string | null;
  setActiveView: (viewId: string) => void;
  sendViewPosition: (viewId: string, y: number) => void;
}

const ActiveVideoContext = createContext<ActiveVideoContextValue | null>(null);
ActiveVideoContext.displayName = 'ActiveVideoContext';

const NOOP = () => {};

export function ActiveVideoProvider({ children }: { children: React.ReactNode }) {
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const activeViewLocationRef = useRef(Infinity);
  const { height: windowHeight } = useWindowDimensions();

  // Minimise re-renders by reading the active id through a ref inside the
  // position handler instead of adding it to the callback deps.
  const manuallySetRef = useRef(false);
  const activeViewIdRef = useRef(activeViewId);
  useEffect(() => {
    activeViewIdRef.current = activeViewId;
  }, [activeViewId]);

  const setActiveView = useCallback(
    (viewId: string) => {
      setActiveViewId(viewId);
      manuallySetRef.current = true;
      // We don't know the exact position, but it's definitely on screen — so
      // guess the middle. Any value works so long as it's not offscreen.
      activeViewLocationRef.current = windowHeight / 2;
    },
    [windowHeight],
  );

  const sendViewPosition = useCallback(
    (viewId: string, y: number) => {
      if (!IS_WEB) return;

      if (viewId === activeViewIdRef.current) {
        activeViewLocationRef.current = y;
      } else if (
        distanceToIdealPosition(y) <
        distanceToIdealPosition(activeViewLocationRef.current)
      ) {
        // If the old view was manually set, only usurp it once it's offscreen.
        if (
          manuallySetRef.current &&
          withinViewport(activeViewLocationRef.current)
        ) {
          return;
        }

        setActiveViewId(viewId);
        activeViewLocationRef.current = y;
        manuallySetRef.current = false;
      }

      function distanceToIdealPosition(yPos: number) {
        return Math.abs(yPos - windowHeight / 2.5);
      }

      function withinViewport(yPos: number) {
        return yPos > 0 && yPos < windowHeight;
      }
    },
    [windowHeight],
  );

  const value = useMemo(
    () => ({ activeViewId, setActiveView, sendViewPosition }),
    [activeViewId, setActiveView, sendViewPosition],
  );

  return (
    <ActiveVideoContext.Provider value={value}>
      {children}
    </ActiveVideoContext.Provider>
  );
}

export interface UseActiveVideoResult {
  /** True when this consumer is the single active (on-screen) video. */
  active: boolean;
  /** Claim active status (manual play wins while still in the viewport). */
  setActive: () => void;
  /** Report this consumer's viewport center-Y so it can compete to be active. */
  sendPosition: (y: number) => void;
}

export function useActiveVideo(): UseActiveVideoResult {
  const context = useContext(ActiveVideoContext);
  const id = useId();

  const setActiveView = context?.setActiveView;
  const sendViewPosition = context?.sendViewPosition;

  const setActive = useCallback(() => {
    setActiveView?.(id);
  }, [setActiveView, id]);

  const sendPosition = useCallback(
    (y: number) => {
      sendViewPosition?.(id, y);
    },
    [sendViewPosition, id],
  );

  // No Provider above (VideoPlayer outside the feed) or native: keep today's
  // autoplay — every video is "active" and nothing reports position.
  if (!context || !IS_WEB) {
    return { active: true, setActive: NOOP, sendPosition: NOOP };
  }

  return {
    active: context.activeViewId === id,
    setActive,
    sendPosition,
  };
}
