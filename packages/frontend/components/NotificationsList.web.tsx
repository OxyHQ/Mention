import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useScrollRestoration } from '@oxyhq/bloom/scroll';
import { Loading } from '@oxyhq/bloom/loading';
import { LoadMoreSentinel } from '@/components/common/LoadMoreSentinel';
import type { GroupedNotification } from '@/utils/groupNotifications';

export interface NotificationsListProps {
    items: GroupedNotification[];
    renderRow: (item: GroupedNotification) => React.ReactElement;
    header: React.ReactElement | null;
    emptyState: React.ReactElement;
    tabKey: string;
    refreshing: boolean;
    onRefresh: () => void;
    /** Fired when the list nears its end and another page can be loaded. */
    onEndReached?: () => void;
    /** Gates the load-more trigger — no next page ⇒ no trigger. */
    hasMore?: boolean;
    /** True while the next page is in flight (renders a footer spinner). */
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
export function NotificationsList({ items, renderRow, header, emptyState, tabKey, onEndReached, hasMore, isFetchingMore }: NotificationsListProps) {
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    useLayoutEffect(() => {
        const node = wrapperRef.current;
        if (!node) return;
        const top = node.getBoundingClientRect().top + window.scrollY;
        setScrollMargin((prev) => (prev !== top ? top : prev));
        // `tabKey` is a dep so the measurement re-runs when the active tab (and
        // the content above the list) changes.
    }, [items.length, tabKey]);

    const virtualizer = useWindowVirtualizer<HTMLDivElement>({
        count: items.length,
        estimateSize: () => ESTIMATED_ROW_HEIGHT,
        overscan: OVERSCAN_ROWS,
        scrollMargin,
        getItemKey: (index) => items[index].key,
    });

    // Per-row ref factory: returns a STABLE callback (cached per row key) that
    // wires the virtualizer's measurement ref on the row node. Stability matters —
    // a fresh inline `virtualizer.measureElement` each render makes React
    // detach/re-attach the ref on every render, tearing down and rebuilding the
    // ResizeObserver `measureElement` installs. That drops the resize
    // notification when a grouped row grows from its short first mount (~71px) to
    // its settled height (~158px), so the next row keeps its stale position and
    // overlaps the grown row. Caching one callback per key (so the ref only fires
    // on real mount/unmount, and the ResizeObserver stays attached) is the same
    // robustness the posts feed uses in `components/Feed/Feed.web.tsx`.
    // `measureElement` is stable for the lifetime of this virtualizer.
    const measureElement = virtualizer.measureElement;
    const rowRefCallbacks = useRef(new Map<string, (node: HTMLDivElement | null) => void>());
    const getRowRef = useCallback((key: string) => {
        const cache = rowRefCallbacks.current;
        const existing = cache.get(key);
        if (existing) return existing;
        // Bound the cache so a long scroll session doesn't accumulate one closure
        // per row forever. Only rows in the virtual window are ever mounted, so a
        // modest cap covers the live set; evicting the rest just recreates a
        // row's callback once on a future re-scroll.
        if (cache.size > 500) cache.clear();
        const cb = (node: HTMLDivElement | null) => {
            measureElement(node);
        };
        cache.set(key, cb);
        return cb;
    }, [measureElement]);

    useScrollRestoration('window', { enabled: true, key: `notifications-${tabKey}` });

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
    const lastItemEnd = lastItem ? lastItem.start + lastItem.size - virtualizer.options.scrollMargin : 0;
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
                            // Stable per-key ref (cached) so the ResizeObserver
                            // `measureElement` installs survives re-renders and
                            // catches a grouped row growing after first paint.
                            ref={getRowRef(item.key)}
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
            {onEndReached ? (
                <LoadMoreSentinel onLoadMore={onEndReached} enabled={!!hasMore} />
            ) : null}
            {isFetchingMore ? (
                <View style={{ paddingVertical: 16, alignItems: 'center' }}>
                    <Loading />
                </View>
            ) : null}
        </View>
    );
}
