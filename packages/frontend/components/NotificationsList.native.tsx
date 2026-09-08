import React, { useCallback, useEffect, useRef } from 'react';
import { RefreshControl, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import type { FlashListProps, FlashListRef } from '@shopify/flash-list';
import Animated, {
    useAnimatedScrollHandler,
    type AnimatedProps,
} from 'react-native-reanimated';
import { useTheme } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import type { NotificationListItem } from '@/utils/groupNotifications';

/**
 * The list as a reanimated component, so its `onScroll` can be a worklet — see
 * the handler below. Built once at module scope because
 * `createAnimatedComponent` returns a new component type per call, and a new
 * type per render would remount the list on every render.
 *
 * The row type is named again because `createAnimatedComponent` erases the
 * component's own generic, taking `renderItem` and `keyExtractor` with it.
 */
const AnimatedFlashList = Animated.createAnimatedComponent(
    FlashList as React.ComponentType<FlashListProps<NotificationListItem>>,
) as React.ComponentType<
    AnimatedProps<FlashListProps<NotificationListItem>> & {
        ref?: React.Ref<FlashListRef<NotificationListItem>>;
    }
>;

export interface NotificationsListProps {
    items: NotificationListItem[];
    renderRow: (item: NotificationListItem) => React.ReactElement;
    header: React.ReactElement | null;
    emptyState: React.ReactElement;
    /** Re-keys the list when the active tab changes (mirrors the previous `key`). */
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

/**
 * NATIVE notifications list. Byte-for-byte the previous notifications.tsx
 * FlashList block, including the LayoutScroll wheel/registration bridge —
 * native behavior is unchanged.
 */
export function NotificationsList({
    items,
    renderRow,
    header,
    emptyState,
    tabKey,
    refreshing,
    onRefresh,
    onEndReached,
    hasMore,
    isFetchingMore,
}: NotificationsListProps) {
    const theme = useTheme();
    const listRef = useRef<FlashListRef<NotificationListItem> | null>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const { scrollPosition, scrollEventThrottle, registerScrollable } = useLayoutScroll();

    const clearScrollableRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignListRef = useCallback((node: FlashListRef<NotificationListItem> | null) => {
        listRef.current = node;
        clearScrollableRegistration();
        if (node) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearScrollableRegistration, registerScrollable]);

    useEffect(() => {
        if (listRef.current && !unregisterScrollableRef.current) {
            unregisterScrollableRef.current = registerScrollable(listRef.current);
        }
    }, [registerScrollable]);

    useEffect(() => () => {
        clearScrollableRegistration();
    }, [clearScrollableRegistration]);

    /**
     * This list's scroll exists for ONE reason: the auto-hiding chrome, which
     * integrates its position from `scrollPosition` in a UI-thread worklet. So
     * the offset never needs to reach the JS thread at all, and as a JS callback
     * it could only arrive when the JS thread was free — which, on the tab whose
     * rows carry avatars and text, is exactly when it is not.
     */
    const handleScrollEvent = useAnimatedScrollHandler({
        onScroll: (event) => {
            'worklet';
            scrollPosition.value = event.contentOffset.y;
        },
    });

    const renderItem = useCallback(({ item }: { item: NotificationListItem }) => renderRow(item), [renderRow]);
    const getItemKey = useCallback((item: NotificationListItem) => item.key, []);
    // Distinct recycling pool per row shape: section headers recycle among
    // themselves; notification rows recycle by their notification type.
    const getItemType = useCallback(
        (item: NotificationListItem) => (item.kind === 'header' ? 'header' : item.type),
        [],
    );

    const handleEndReached = useCallback(() => {
        if (hasMore && onEndReached) {
            onEndReached();
        }
    }, [hasMore, onEndReached]);

    const listFooter = isFetchingMore ? (
        <View style={{ paddingVertical: 16 }}>
            <Loading />
        </View>
    ) : null;

    return (
        <View style={{ flex: 1, minHeight: 0 }}>
            <AnimatedFlashList
                ref={assignListRef}
                data={items}
                keyExtractor={getItemKey}
                renderItem={renderItem}
                getItemType={getItemType}
                ListHeaderComponent={header}
                ListEmptyComponent={emptyState}
                ListFooterComponent={listFooter}
                onEndReached={handleEndReached}
                onEndReachedThreshold={0.5}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={onRefresh}
                        colors={[theme.colors.primary]}
                        tintColor={theme.colors.primary}
                    />
                }
                showsVerticalScrollIndicator={false}
                onScroll={handleScrollEvent}
                scrollEventThrottle={scrollEventThrottle}
                contentContainerStyle={{
                    backgroundColor: theme.colors.background,
                }}
                style={{
                    flex: 1,
                    backgroundColor: theme.colors.background,
                }}
                drawDistance={400}
                key={`notifications-${tabKey}`}
            />
        </View>
    );
}
