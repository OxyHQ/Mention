import type React from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';
import { usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';
import type { ReselectScroller } from '@/context/ScreenReselectContext';

type DocumentScrollValue = {
  /** The document's (or the bounded panel's) scroll offset, mirrored from its scroll events. */
  scrollPosition: SharedValue<number>;
  /** Scroll the document (or the bounded panel) to an offset. */
  scrollToOffset: (offset: number, animated?: boolean) => void;
};

const DocumentScrollContext = createContext<DocumentScrollValue | null>(null);

/**
 * WEB: the page scrolls the document — or, in a bounded panel layout, the panel
 * surface — rather than a list, so one listener here mirrors its offset for the
 * chrome that follows it (the bottom bar's auto-hide) and for a reselect.
 * Native lists bind their own Screen instead (`DocumentScroll.tsx`).
 */
export function DocumentScrollProvider({ children }: { children: React.ReactNode }) {
  const panel = usePanelScrollContainer<HTMLElement>();
  const scrollPosition = useSharedValue(0);

  // Subscribing to an external mutable store (the document's scroll) is a
  // legitimate effect. Primed once so a restored offset is reflected at once.
  useEffect(() => {
    const owner = panel?.current ?? window;
    const onScroll = () => {
      scrollPosition.value = owner instanceof Window ? owner.scrollY : owner.scrollTop;
    };
    onScroll();
    owner.addEventListener('scroll', onScroll, { passive: true });
    return () => owner.removeEventListener('scroll', onScroll);
  }, [panel, scrollPosition]);

  const scrollToOffset = useCallback(
    (offset: number, animated = true) => {
      (panel?.current ?? window).scrollTo({
        top: Math.max(0, offset),
        behavior: animated ? 'smooth' : 'auto',
      });
    },
    [panel],
  );

  const value = useMemo(
    () => ({ scrollPosition, scrollToOffset }),
    [scrollPosition, scrollToOffset],
  );
  return <DocumentScrollContext.Provider value={value}>{children}</DocumentScrollContext.Provider>;
}

export function useDocumentScroll(): DocumentScrollValue {
  const ctx = useContext(DocumentScrollContext);
  if (!ctx) throw new Error('useDocumentScroll must be used within a DocumentScrollProvider');
  return ctx;
}

/** The document is the scroller in front when no list is. */
export function useDocumentScroller(): ReselectScroller | null {
  const { scrollPosition, scrollToOffset } = useDocumentScroll();
  return useMemo(
    () => ({ offset: () => scrollPosition.value, scrollToOffset }),
    [scrollPosition, scrollToOffset],
  );
}
