import React, { useCallback } from 'react';
import { RefreshControl, View } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { Loading } from '@oxy.so/bloom/loading';
import { FocusedFlashList } from '@/components/common/FocusedFlashList';
import type { NotificationListItem } from '@/utils/groupNotifications';

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

const EMPTY_CONTENT = { flexGrow: 1 } as const;
const LIST_STYLE = { flex: 1 } as const;

/**
 * NATIVE notifications list: a `FocusedFlashList`, so it owns the screen's
 * scroll while the notifications tab is in front.
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
            <FocusedFlashList
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
                // No fill of its own. The list used to paint `colors.background`,
                // which is darker than the panel fill every other tab shows
                // through (`StackScene` / `useSurfaceFill`), so the Notifications
                // body read as a different surface from its own header.
                //
                // Empty, the content grows to the viewport: the empty state is
                // the whole page, and a pull that starts anywhere on it reaches
                // the refresh control instead of landing below a short content box.
                contentContainerStyle={items.length === 0 ? EMPTY_CONTENT : undefined}
                style={LIST_STYLE}
                drawDistance={400}
                key={`notifications-${tabKey}`}
            />
        </View>
    );
}
