import React, { useLayoutEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useWindowVirtualizer } from '@tanstack/react-virtual';

/**
 * WEB LegendList: a window-virtualized list under the DOCUMENT scroller.
 *
 * The native LegendList wraps `@legendapp/list` and injects the LayoutScroll
 * wheel bridge (`forwardWheelEvent` / `registerScrollable` / `data-layoutscroll`
 * + an inner overflow lock). Under the web document-scroll model none of that
 * exists — the BODY scrolls from anywhere — so this variant drops the bridge
 * entirely and simply flows its rows in the document while keeping the DOM
 * bounded via `useWindowVirtualizer`.
 *
 * All three consumers (connections, WhoToFollowTab, StarterPacksTab) render this
 * as the scroll-owning content of their screen (never embedded inside a parent
 * scroller), so window virtualization is the correct host here.
 */

interface LegendListWebProps<T> {
    data?: readonly T[];
    renderItem?: (info: { item: T; index: number }) => React.ReactElement | null;
    keyExtractor?: (item: T, index: number) => string;
    ListHeaderComponent?: React.ReactElement | (() => React.ReactElement) | null;
    ListEmptyComponent?: React.ReactElement | (() => React.ReactElement) | null;
    contentContainerStyle?: React.ComponentProps<typeof View>['style'];
    style?: React.ComponentProps<typeof View>['style'];
    // FlatList/Legend tuning props are accepted but inert on web.
    refreshing?: boolean;
    onRefresh?: () => void;
    removeClippedSubviews?: boolean;
    maxToRenderPerBatch?: number;
    windowSize?: number;
    initialNumToRender?: number;
    recycleItems?: boolean;
    maintainVisibleContentPosition?: boolean;
    [key: string]: unknown;
}

// Rows in these lists (user rows, pack cards) are short and uniform-ish; a small
// estimate + per-row measurement keeps the mounted node count bounded.
const ESTIMATED_ROW_HEIGHT = 72;
const OVERSCAN_ROWS = 8;

function renderSlot(
    slot: React.ReactElement | (() => React.ReactElement) | null | undefined
): React.ReactElement | null {
    if (!slot) return null;
    if (typeof slot === 'function') return slot();
    return slot;
}

function LegendListWeb<T>(props: LegendListWebProps<T>, ref: React.Ref<unknown>) {
    const {
        data,
        renderItem,
        keyExtractor,
        ListHeaderComponent,
        ListEmptyComponent,
        contentContainerStyle,
        style,
    } = props;

    const items = data ?? [];
    const header = renderSlot(ListHeaderComponent);

    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    useLayoutEffect(() => {
        const node = wrapperRef.current;
        if (!node) return;
        const top = node.getBoundingClientRect().top + window.scrollY;
        setScrollMargin((prev) => (prev !== top ? top : prev));
    }, [items.length]);

    const virtualizer = useWindowVirtualizer<HTMLDivElement>({
        count: items.length,
        estimateSize: () => ESTIMATED_ROW_HEIGHT,
        overscan: OVERSCAN_ROWS,
        scrollMargin,
        getItemKey: keyExtractor
            ? (index) => keyExtractor(items[index], index)
            : undefined,
    });

    // Expose a minimal scroll-to-top handle so a consumer holding a ref keeps a
    // working imperative API under the document scroller.
    React.useImperativeHandle(ref, () => ({
        scrollToOffset: () => {
            if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
        },
        scrollTo: () => {
            if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
        },
    }), []);

    const flatStyle = StyleSheet.flatten(style);
    const flatContentStyle = StyleSheet.flatten(contentContainerStyle) as React.CSSProperties | undefined;

    if (items.length === 0) {
        return (
            <View style={[{ minHeight: 0 }, flatStyle]}>
                {header}
                {renderSlot(ListEmptyComponent)}
            </View>
        );
    }

    const virtualItems = virtualizer.getVirtualItems();

    return (
        <View style={[{ minHeight: 0 }, flatStyle]}>
            {header}
            <div style={flatContentStyle}>
                <div ref={wrapperRef} style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
                    {virtualItems.map((virtualRow) => (
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
                            {renderItem ? renderItem({ item: items[virtualRow.index], index: virtualRow.index }) : null}
                        </div>
                    ))}
                </div>
            </div>
        </View>
    );
}

export default React.forwardRef(LegendListWeb) as <T>(
    props: LegendListWebProps<T> & { ref?: React.Ref<unknown> }
) => React.ReactElement;
