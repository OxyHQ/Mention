import type React from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIsFocused } from '@/lib/navigation/router';
import { useDocumentScroller } from '@/context/DocumentScroll';
import { useRefSync } from '@/hooks/useRefSync';

/**
 * What pressing the place you are already on means for one screen — the
 * bottom-bar tab, the sidebar row, the logo, the inner tab that is already
 * selected. The convention every social app shares: the first press takes the
 * reader back to the top, and a press while already there reloads.
 *
 * A screen only says HOW it reloads. Where the top is belongs to whoever owns
 * the scroller: the web document, or the native list in front
 * (`useReselectScroller`). A screen that drives its own scroller (the reel,
 * where the top is the first slide) supplies both halves itself.
 */
export type ReselectHandler = {
  refresh?: () => void | Promise<unknown>;
  scrollToTop?: () => void;
  isAtTop?: () => boolean;
};

/** Within this many points of the top, the reader is at the top. */
export const AT_TOP_THRESHOLD = 4;

/** The scroller in front: where it is, and how to move it. */
export type ReselectScroller = {
  offset: () => number;
  scrollToOffset: (offset: number) => void;
};

type ScreenReselectContextValue = {
  reselect: () => void;
  register: (read: () => ReselectHandler) => () => void;
  registerScroller: (read: () => ReselectScroller) => () => void;
  frontScroller: () => ReselectScroller | null;
};

/**
 * One slot, last registration wins, and a cleanup only clears the slot it
 * filled: a screen that lost focus must not take the next screen's slot with
 * it when it unregisters late.
 */
function useSlot<T>() {
  const activeRef = useRef<{ id: number; read: () => T } | null>(null);
  const counterRef = useRef(0);
  const register = useCallback((read: () => T) => {
    const id = ++counterRef.current;
    activeRef.current = { id, read };
    return () => {
      if (activeRef.current?.id === id) activeRef.current = null;
    };
  }, []);
  const read = useCallback(() => activeRef.current?.read() ?? null, []);
  return [register, read] as const;
}

const ScreenReselectContext = createContext<ScreenReselectContextValue | null>(null);

export function ScreenReselectProvider({ children }: { children: React.ReactNode }) {
  const [register, readHandler] = useSlot<ReselectHandler>();
  const [registerScroller, readScroller] = useSlot<ReselectScroller>();
  const documentScroller = useDocumentScroller();

  const frontScroller = useCallback(
    () => readScroller() ?? documentScroller,
    [readScroller, documentScroller],
  );

  const reselect = useCallback(() => {
    const handler = readHandler();
    const scroller = frontScroller();
    // Away from the top a press only scrolls; at the top it also reloads,
    // and the scroll keeps what arrives in view. A screen with nothing to
    // scroll cannot be anywhere but its top.
    const atTop = handler?.isAtTop
      ? handler.isAtTop()
      : (scroller?.offset() ?? 0) <= AT_TOP_THRESHOLD;
    if (handler?.scrollToTop) handler.scrollToTop();
    else scroller?.scrollToOffset(0);
    if (atTop) void handler?.refresh?.();
  }, [readHandler, frontScroller]);

  const value = useMemo(
    () => ({ reselect, register, registerScroller, frontScroller }),
    [reselect, register, registerScroller, frontScroller],
  );

  return <ScreenReselectContext.Provider value={value}>{children}</ScreenReselectContext.Provider>;
}

function useScreenReselectContext(): ScreenReselectContextValue {
  const ctx = useContext(ScreenReselectContext);
  if (!ctx) throw new Error('Screen reselect hooks must be used within ScreenReselectProvider');
  return ctx;
}

/** Scroll the focused screen to the top, or reload it if it is already there. */
export function useReselect(): () => void {
  return useScreenReselectContext().reselect;
}

/**
 * Declare what reselecting this screen means. Registered only while the screen
 * is focused: the native tab pager keeps every tab mounted, and a background
 * tab must never answer for the one in front of the reader.
 */
export function useScreenReselect(handler: ReselectHandler) {
  const { register } = useScreenReselectContext();
  const isFocused = useIsFocused();
  const handlerRef = useRefSync(handler);

  useEffect(() => {
    if (!isFocused) return;
    return register(() => handlerRef.current);
  }, [isFocused, register, handlerRef]);
}

/**
 * The list in front answers where it is and moves when asked: a reselect takes
 * it to the top, a profile to its tabs. Registered only while its screen is
 * focused, for the same reason as {@link useScreenReselect}, and only by a list
 * that scrolls itself (`enabled`).
 */
export function useReselectScroller(scroller: ReselectScroller, enabled = true) {
  const { registerScroller } = useScreenReselectContext();
  const isFocused = useIsFocused();
  const scrollerRef = useRefSync(scroller);
  useEffect(() => {
    if (!isFocused || !enabled) return;
    return registerScroller(() => scrollerRef.current);
  }, [isFocused, enabled, registerScroller, scrollerRef]);
}

/** The scroller in front of the reader — a focused list, else the web document. */
export function useFrontScroller(): () => ReselectScroller | null {
  return useScreenReselectContext().frontScroller;
}

/**
 * For a screen whose reload is "fetch the feed again from the top": a
 * `reloadKey` for its `<Feed>` that moves each time the screen is reselected
 * at the top. `handler` carries whatever else the screen reloads alongside
 * the feed, or where its own top is.
 */
export function useReselectReloadKey(handler: ReselectHandler = {}): number {
  const [reloadKey, setReloadKey] = useState(0);
  useScreenReselect({
    ...handler,
    refresh: () => {
      setReloadKey((key) => key + 1);
      return handler.refresh?.();
    },
  });
  return reloadKey;
}

/**
 * {@link useReselectReloadKey} for a screen that keeps several inner tabs'
 * feeds mounted: a reselect moves only the `active` tab's key, so a retained
 * tab does not reload behind the reader or again when it is shown.
 */
export function useReselectReloadKeys(active: string): (tab: string) => number {
  const [reloadKeys, setReloadKeys] = useState<Readonly<Record<string, number>>>({});
  useScreenReselect({
    refresh: () => {
      setReloadKeys((keys) => ({ ...keys, [active]: (keys[active] ?? 0) + 1 }));
    },
  });
  return useCallback((tab: string) => reloadKeys[tab] ?? 0, [reloadKeys]);
}

/**
 * An inner tab strip's press handler: the tab already selected is reselected,
 * any other one is selected with `select`.
 */
export function useTabSelect<T>(active: T, select: (tab: T) => void): (tab: T) => void {
  const reselect = useReselect();
  return useCallback(
    (tab: T) => {
      if (tab === active) reselect();
      else select(tab);
    },
    [active, reselect, select],
  );
}
