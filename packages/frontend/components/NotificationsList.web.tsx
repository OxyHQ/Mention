import { NotificationSkeleton } from '@/components/notifications/NotificationSkeleton';
import { usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';
import { useScrollMarginOrigin } from '@/components/Feed/useScrollMarginOrigin';
import type React from 'react';
import { useRef } from 'react';
import { View } from 'react-native';
import { useOwnerVirtualizer } from '@/hooks/useOwnerVirtualizer.web';
import { useScrollRestoration } from '@oxy.so/bloom/scroll';
import { LoadMoreSentinel } from '@/components/common/LoadMoreSentinel';
import type { NotificationListItem } from '@/utils/groupNotifications';

export interface NotificationsListProps {
  items: NotificationListItem[];
  renderRow: (item: NotificationListItem) => React.ReactElement;
  header: React.ReactElement | null;
  emptyState: React.ReactElement;
  tabKey: string;
  refreshing: boolean;
  onRefresh: () => void;
  /** Fired when the list nears its end and another page can be loaded. */
  onEndReached?: () => void;
  /** Gates the load-more trigger — no next page ⇒ no trigger. */
  hasMore?: boolean;
  /** True while the next page is in flight (renders a footer skeleton). */
  isFetchingMore?: boolean;
}

// First-paint size guess before a row is measured. Single-actor rows land around
// ~71px and grouped rows (avatar strip + "Show all" + preview) around ~158px, so
// the mix skews toward the single row. The estimate is biased slightly ABOVE the
// common single-row height: an estimate under a grouped row's real height would
// position the next row against the shorter guess and overlap it for a frame,
// whereas a slightly-high guess only yields a transient gap that measurement
// closes. `measureElement` (a ResizeObserver, wired via a stable ref below)
// replaces this with the real height as each row mounts and as its grouped
// content settles.
const ESTIMATED_ROW_HEIGHT = 96;
const OVERSCAN_ROWS = 8;

/**
 * WEB notifications list: window-virtualized against the DOCUMENT scroller, so
 * the body scrolls from anywhere (no inner overflow region, no wheel bridge) and
 * only the rows in the virtual window are mounted (bounded DOM). Window-offset
 * scroll restoration is keyed per active tab.
 */
export function NotificationsList({
  items,
  renderRow,
  header,
  emptyState,
  tabKey,
  onEndReached,
  hasMore,
  isFetchingMore,
}: NotificationsListProps) {
  // A window-virtualized list must be opted out of the React Compiler
  // EXPLICITLY — see `docs/frontend-compiler-notes.md`. `useWindowVirtualizer`
  // returns an instance whose identity is stable for this component's lifetime
  // and re-renders through a reducer internal to the hook, so nothing this
  // function can see changes on scroll and a memoizing compiler serves the
  // first `getVirtualItems()`/`getTotalSize()` forever. Dev hides it (fast
  // refresh clears the cache on every edit); production does not.
  //
  // This file was opted out only ACCIDENTALLY, by reading a ref during render.
  // `ProfileGridList.web.tsx` had the same shape, compiled, and shipped frozen
  // — 8 rows and ~550px of blank below them. Stating it is the difference
  // between a guarantee and a coincidence.
  'use no memo';

  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const panel = usePanelScrollContainer<HTMLElement>();
  const scrollMargin = useScrollMarginOrigin(wrapperRef);

  const virtualizer = useOwnerVirtualizer<HTMLDivElement>({
    count: items.length,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
    scrollMargin,
    getItemKey: (index) => items[index].key,
  });

  // TanStack supplies a stable ref per virtualizer. Passing it directly lets
  // React reattach mounted rows when their document/panel owner changes.
  const measureElement = virtualizer.measureElement;

  useScrollRestoration('window', { enabled: !panel, key: `notifications-${tabKey}` });

  if (items.length === 0) {
    return (
      <View style={{ minHeight: 0 }}>
        {header}
        {emptyState}
      </View>
    );
  }

  const virtualItems = virtualizer.getVirtualItems();
  const totalSize = virtualizer.getTotalSize();

  // The measured spacer height MUST contain every absolutely-positioned row.
  // Because rows are `position: absolute`, an overflow does NOT grow the
  // spacer — so if `getTotalSize()` momentarily disagrees with the rows' real
  // extent (e.g. `scrollMargin` is stale after content above the list grows)
  // the list column stops short and any sticky containing block scrolls away.
  // Sizing the spacer to the MAX of `totalSize` and the last row's real end
  // (in spacer space) guarantees the spacer always contains its rows. Ported
  // from `components/Feed/Feed.web.tsx`.
  const lastItem = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1] : undefined;
  const lastItemEnd = lastItem
    ? lastItem.start + lastItem.size - virtualizer.options.scrollMargin
    : 0;
  const spacerHeight = Math.max(totalSize, lastItemEnd);

  return (
    <View style={{ minHeight: 0 }}>
      {header}
      <div ref={wrapperRef} style={{ height: spacerHeight, width: '100%', position: 'relative' }}>
        {virtualItems.map((virtualRow) => {
          const item = items[virtualRow.index];
          return (
            <div
              key={virtualRow.key as React.Key}
              ref={measureElement}
              data-index={virtualRow.index}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {renderRow(item)}
            </div>
          );
        })}
      </div>
      {onEndReached ? <LoadMoreSentinel onLoadMore={onEndReached} enabled={!!hasMore} /> : null}
      {isFetchingMore ? (
        <View style={{ paddingVertical: 16, alignItems: 'center' }}>
          <NotificationSkeleton count={2} />
        </View>
      ) : null}
    </View>
  );
}
