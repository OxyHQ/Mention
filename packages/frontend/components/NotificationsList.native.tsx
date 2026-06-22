import React, { useCallback, useEffect, useRef } from 'react';
import { Platform, RefreshControl, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import type { FlashListRef } from '@shopify/flash-list';
import { useTheme } from '@oxyhq/bloom/theme';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import type { GroupedNotification } from '@/utils/groupNotifications';

export interface NotificationsListProps {
    items: GroupedNotification[];
    renderRow: (item: GroupedNotification) => React.ReactElement;
    header: React.ReactElement | null;
    emptyState: React.ReactElement;
    /** Re-keys the list when the active tab changes (mirrors the previous `key`). */
    tabKey: string;
    refreshing: boolean;
    onRefresh: () => void;
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
}: NotificationsListProps) {
    const theme = useTheme();
    const listRef = useRef<FlashListRef<GroupedNotification> | null>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent } = useLayoutScroll();

    const clearScrollableRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignListRef = useCallback((node: FlashListRef<GroupedNotification> | null) => {
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

    const handleScrollEvent = useCallback((event: Parameters<typeof handleScroll>[0]) => {
        if (handleScroll) {
            handleScroll(event);
        }
    }, [handleScroll]);

    const handleWheelEvent = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
        if (forwardWheelEvent) {
            forwardWheelEvent({
                deltaY: event.deltaY,
                preventDefault: () => event.preventDefault(),
                target: event.target,
            });
        }
    }, [forwardWheelEvent]);

    const renderItem = useCallback(({ item }: { item: GroupedNotification }) => renderRow(item), [renderRow]);
    const getItemKey = useCallback((item: GroupedNotification) => item.key, []);
    const getItemType = useCallback((item: GroupedNotification) => item.type, []);

    const webEventProps: Record<string, unknown> = Platform.OS === 'web'
        ? { 'data-layoutscroll': 'true', onWheel: handleWheelEvent }
        : {};

    return (
        <View
            style={{ flex: 1, minHeight: 0 }}
            {...webEventProps}
        >
            <FlashList
                ref={assignListRef}
                data={items}
                keyExtractor={getItemKey}
                renderItem={renderItem}
                getItemType={getItemType}
                ListHeaderComponent={header}
                ListEmptyComponent={emptyState}
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
