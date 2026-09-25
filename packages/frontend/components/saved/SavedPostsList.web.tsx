import { useRef } from 'react';
import { Pressable } from 'react-native';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';
import { LoadMoreSentinel } from '@/components/common/LoadMoreSentinel';
import PostItem from '@/components/Feed/PostItem';
import { useScrollMarginOrigin } from '@/components/Feed/useScrollMarginOrigin';
import type { SavedPostsListProps } from './SavedPostsList.types';

const ESTIMATED_POST_HEIGHT = 280;
const OVERSCAN_POSTS = 6;

/**
 * Saved posts participate in Mention's document-scroll shell on web. The rows
 * are virtualized against `window`; no nested overflow container is introduced.
 */
export default function SavedPostsList({
  posts,
  empty,
  footer,
  hasNextPage,
  onEndReached,
  onLongPress,
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
  // containing block — stops short and the rails scroll away. There is no
  // `subscribe` on the virtualizer to drive `useSyncExternalStore` from.
  'use no memo';

  const spacerRef = useRef<HTMLDivElement | null>(null);
  const scrollMargin = useScrollMarginOrigin(spacerRef);

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

  useScrollRestoration('window', { enabled: true });

  // The spacer stays mounted while the list is empty: it is the element the
  // scroll-margin origin measures, and that measurement binds once, on mount.
  return (
    <div style={{ width: '100%' }}>
      {posts.length === 0 ? empty : null}
      <div
        ref={spacerRef}
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
      </div>
      <LoadMoreSentinel onLoadMore={onEndReached} enabled={hasNextPage && posts.length > 0} />
      {footer}
    </div>
  );
}
