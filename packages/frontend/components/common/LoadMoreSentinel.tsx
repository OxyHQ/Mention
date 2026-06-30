import React, { useEffect, useRef } from 'react';
import { Platform, View } from 'react-native';

interface LoadMoreSentinelProps {
  /** Fired when the sentinel nears the viewport (web) — wire to `fetchNextPage`. */
  onLoadMore: () => void;
  /** Only observe while there is more to load (no next page ⇒ no trigger). */
  enabled: boolean;
  /** Pre-fetch distance ahead of the viewport bottom (web IntersectionObserver rootMargin). */
  rootMargin?: string;
}

const SENTINEL_STYLE = { height: 1 } as const;

/**
 * Web infinite-scroll trigger for document-scroll virtualized lists. Bloom's
 * `VirtualList` on web is a window virtualizer with no `onEndReached`, so a list
 * that paginates renders this 1px marker in its footer: when it enters the
 * viewport (`rootMargin` px early) `onLoadMore` fires. Inert on native, where
 * lists paginate via `onEndReached` instead — so a list wires BOTH (this for
 * web, `onEndReached` for native) and each platform uses the one that applies.
 */
export function LoadMoreSentinel({ onLoadMore, enabled, rootMargin = '600px' }: LoadMoreSentinelProps) {
  const viewRef = useRef<View>(null);
  // Keep the latest callback without re-subscribing the observer every render.
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      return;
    }
    if (!enabled) return;

    // react-native-web exposes the underlying DOM node via `_nativeNode`/
    // `getNode()` (neither is on the typed View ref), with the ref itself as a
    // last resort. Narrow structurally instead of `as any` — mirrors LazyImage.
    const ref = viewRef.current as
      | (View & { _nativeNode?: Element; getNode?: () => Element })
      | null;
    const element: Element | View | null = ref?._nativeNode ?? ref?.getNode?.() ?? ref;
    if (!element || (element as Partial<Element>).nodeType === undefined) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin },
    );
    observer.observe(element as Element);
    return () => observer.disconnect();
  }, [enabled, rootMargin]);

  return <View ref={viewRef} style={SENTINEL_STYLE} />;
}
