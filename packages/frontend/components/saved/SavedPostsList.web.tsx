import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Pressable } from 'react-native';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useScrollRestoration } from '@oxyhq/bloom/scroll';
import PostItem from '@/components/Feed/PostItem';
import type { SavedPostsListProps } from './SavedPostsList.types';

const ESTIMATED_POST_HEIGHT = 280;
const OVERSCAN_POSTS = 6;
const LOAD_MORE_ROOT_MARGIN = '600px';

/**
 * Saved posts participate in Mention's document-scroll shell on web. The rows
 * are virtualized against `window`; no nested overflow container is introduced.
 */
export default function SavedPostsList({
  posts,
  header,
  empty,
  footer,
  hasNextPage,
  onEndReached,
  onLongPress,
  backgroundColor,
}: SavedPostsListProps) {
  // REQUIRED — without it `getTotalSize()` below is called once and cached
  // forever, so the spacer stops tracking the content. `useWindowVirtualizer`
  // returns an instance whose identity is stable for this component's lifetime,
  // and the compiler keys the cached call on exactly that (`$[11] !==
  // virtualizer`), which never changes. Rows are taller than the 280px estimate,
  // so the real total grows as they measure and the frozen value does not:
  // measured against this component, the spacer stayed at 5600px where it should
  // have reached 8400px. A spacer shorter than its absolutely-positioned rows
  // does not grow to contain them, so the column — and the sticky side rails'
  // containing block — stops short and the rails scroll away.
  //
  // The `useEffect` below deliberately avoids a "latest ref" written during
  // render, which is correct and is also why this function compiles at all;
  // `Feed.web.tsx` is safe from this only because it does the illegal thing and
  // gets refused. Opting out is the honest version of that accident. There is no
  // `subscribe` on the virtualizer to drive `useSyncExternalStore` from.
  'use no memo';

  const headerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const measureScrollMargin = useCallback(() => {
    const node = wrapperRef.current;
    if (!node || typeof window === 'undefined') return;
    const top = node.getBoundingClientRect().top + window.scrollY;
    setScrollMargin((current) => (current === top ? current : top));
  }, []);

  useLayoutEffect(() => {
    measureScrollMargin();
    if (typeof window === 'undefined') return;

    window.addEventListener('resize', measureScrollMargin);
    const headerNode = headerRef.current;
    const resizeObserver = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measureScrollMargin);
    if (headerNode) resizeObserver?.observe(headerNode);

    return () => {
      window.removeEventListener('resize', measureScrollMargin);
      resizeObserver?.disconnect();
    };
  }, [header, measureScrollMargin, posts.length]);

  const virtualizer = useWindowVirtualizer<HTMLDivElement>({
    count: posts.length,
    estimateSize: () => ESTIMATED_POST_HEIGHT,
    overscan: OVERSCAN_POSTS,
    scrollMargin,
    getItemKey: (index) => posts[index].id,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();
  const lastItem = virtualItems.length > 0
    ? virtualItems[virtualItems.length - 1]
    : undefined;
  const lastItemEnd = lastItem
    ? lastItem.start + lastItem.size - virtualizer.options.scrollMargin
    : 0;
  const spacerHeight = Math.max(totalSize, lastItemEnd);

  // The observer closes over `onEndReached` and re-subscribes when its identity
  // changes, rather than reading it from a ref. A "latest ref" written during
  // render is illegal input for the React Compiler (enabled for this app), which
  // is free to memoize past the write and leave the ref on a stale callback — and
  // a stale callback here means infinite scroll silently stops fetching. The
  // re-subscribe is cheap and already happens per page: `posts.length` is a dep.
  useEffect(() => {
    const node = sentinelRef.current;
    if (
      !node ||
      posts.length === 0 ||
      !hasNextPage ||
      typeof IntersectionObserver === 'undefined'
    ) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onEndReached();
        }
      },
      { root: null, rootMargin: LOAD_MORE_ROOT_MARGIN },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasNextPage, onEndReached, posts.length]);

  useScrollRestoration('window', { enabled: true });

  return (
    <div style={{ width: '100%', backgroundColor }}>
      <div ref={headerRef}>{header}</div>
      {posts.length === 0 ? (
        empty
      ) : (
        <div
          ref={wrapperRef}
          style={{
            height: spacerHeight,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualRow) => {
            const post = posts[virtualRow.index];
            return (
              <div
                key={virtualRow.key as React.Key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
                }}
              >
                <Pressable
                  onLongPress={() => onLongPress(post.id)}
                  delayLongPress={500}
                >
                  <PostItem post={post} />
                </Pressable>
              </div>
            );
          })}
          <div
            ref={sentinelRef}
            aria-hidden
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0,
              width: '100%',
              height: 1,
            }}
          />
        </div>
      )}
      {footer}
    </div>
  );
}
