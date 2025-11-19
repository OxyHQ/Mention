import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
    StyleSheet,
    View,
    RefreshControl,
    Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { FeedType, FeedItem } from '@mention/shared-types';
import PostItem from './PostItem';
import ErrorBoundary from '../ErrorBoundary';
import LoadingTopSpinner from '../LoadingTopSpinner';
import { useOxy } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { flattenStyleArray } from '@/utils/theme';
import { createScopedLogger } from '@/utils/logger';
import { useFeedState } from '@/hooks/useFeedState';
import { useDeepCompareMemo } from '@/hooks/useDeepCompare';
import { FeedFilters, getItemKey, deduplicateItems, normalizeItemId } from '@/utils/feedUtils';
import { FeedHeader } from './FeedHeader';
import { FeedFooter } from './FeedFooter';
import { FeedEmptyState } from './FeedEmptyState';

const logger = createScopedLogger('Feed');

interface FeedProps {
    type: FeedType;
    userId?: string;
    showComposeButton?: boolean;
    onComposePress?: () => void;
    hideHeader?: boolean;
    hideRefreshControl?: boolean;
    scrollEnabled?: boolean;
    showOnlySaved?: boolean;
    filters?: FeedFilters;
    reloadKey?: string | number;
    autoRefresh?: boolean;
    refreshInterval?: number;
    onSavePress?: (postId: string) => void;
    style?: React.ComponentProps<typeof View>['style'];
    contentContainerStyle?: React.ComponentProps<typeof View>['style'];
    listHeaderComponent?: React.ReactElement | null;
    recycleItems?: boolean;
    maintainScrollAtEnd?: boolean;
    maintainScrollAtEndThreshold?: number;
    alignItemsAtEnd?: boolean;
    maintainVisibleContentPosition?: boolean;
}

const DEFAULT_FEED_PROPS = {
    showComposeButton: false,
    hideHeader: false,
    hideRefreshControl: false,
    scrollEnabled: true,
    showOnlySaved: false,
    autoRefresh: false,
    refreshInterval: 30000,
    recycleItems: true,
    maintainScrollAtEnd: false,
    maintainScrollAtEndThreshold: 0.1,
    alignItemsAtEnd: false,
    maintainVisibleContentPosition: true,
} as const;

const Feed = memo((props: FeedProps) => {
    const {
        type,
        userId,
        showComposeButton,
        onComposePress,
        hideHeader,
        hideRefreshControl,
        scrollEnabled,
        showOnlySaved,
        filters,
        reloadKey,
        autoRefresh: _autoRefresh,
        refreshInterval: _refreshInterval,
        onSavePress: _onSavePress,
        style,
        contentContainerStyle,
        listHeaderComponent,
        recycleItems: _recycleItems,
        maintainScrollAtEnd,
        maintainScrollAtEndThreshold,
        alignItemsAtEnd,
        maintainVisibleContentPosition,
    } = { ...DEFAULT_FEED_PROPS, ...props };

    const theme = useTheme();
    const flatListRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent } = useLayoutScroll();

    // Determine if we should use scoped (local) feed state
    const useScoped = !!(filters && Object.keys(filters).length) && !showOnlySaved;

    const { user: currentUser, isAuthenticated } = useOxy();

    // Use the feed state hook for all feed operations
    const feedState = useFeedState({
        type,
        userId,
        showOnlySaved,
        filters,
        useScoped,
        reloadKey,
        isAuthenticated,
        currentUserId: currentUser?.id,
    });

    // Handle refresh with loading state
    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await feedState.refresh();
        } catch (err) {
            logger.error('Error refreshing feed', err);
        } finally {
            setRefreshing(false);
        }
    }, [feedState]);

    // Handle load more
    const handleLoadMore = useCallback(async () => {
        if (!feedState.hasMore || feedState.isLoading) return;
        await feedState.loadMore();
    }, [feedState]);

    // Process display items with deduplication and sorting
    const displayItems = useDeepCompareMemo(() => {
        const src = feedState.items;
        if (src.length === 0) return [];

        // Fast deduplication using utility function
        const deduped = deduplicateItems(src, getItemKey);

        // Log duplicates in development only
        if (process.env.NODE_ENV === 'development') {
            const seen = new Set<string>();
            const duplicateIds: string[] = [];
            for (const item of src) {
                const id = normalizeItemId(item);
                if (id && id !== 'undefined' && id !== 'null' && id !== '') {
                    if (!seen.has(id)) {
                        seen.add(id);
                    } else {
                        duplicateIds.push(id);
                    }
                }
            }

            if (duplicateIds.length > 0) {
                logger.error(`Found ${duplicateIds.length} duplicates in feed items`, {
                    duplicates: [...new Set(duplicateIds)].slice(0, 10),
                    feedType: type,
                    totalItems: src.length,
                    uniqueItems: deduped.length,
                });
            }
        }

        // Only apply sorting for 'for_you' feed if user is authenticated
        const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
        if (effectiveType === 'for_you' && currentUser?.id && deduped.length > 0) {
            const now = Date.now();
            const THRESHOLD_MS = 60 * 1000;
            const mineNow: Array<{ item: FeedItem; ts: number }> = [];
            const others: FeedItem[] = [];

            // Single pass to separate items
            for (const item of deduped) {
                const ownerId = (item as any)?.user?.id;
                if ((item as any)?.isLocalNew || ownerId === currentUser.id) {
                    const d = (item as any)?.date || (item as any)?.createdAt;
                    const ts = d ? Date.parse(d) : 0;
                    if (ts && now - ts <= THRESHOLD_MS) {
                        mineNow.push({ item, ts });
                    } else {
                        others.push(item);
                    }
                } else {
                    others.push(item);
                }
            }

            // Sort only if we have recent items from user
            if (mineNow.length > 0) {
                mineNow.sort((a, b) => b.ts - a.ts);
                return [...mineNow.map((x) => x.item), ...others];
            }
        }

        return deduped;
    }, [feedState.items, type, showOnlySaved, currentUser?.id]);

    // Final deduplication layer - optimized using Map for better performance
    const finalRenderItems = useMemo(() => {
        if (displayItems.length === 0) return [];
        
        // Use Map instead of Set + Array for single-pass deduplication
        const seen = new Map<string, FeedItem>();
        for (const item of displayItems) {
            const key = getItemKey(item);
            if (key && !seen.has(key)) {
                seen.set(key, item);
            }
        }
        return Array.from(seen.values());
    }, [displayItems]);

    // Memoize renderPostItem to prevent recreating on every render
    const renderPostItem = useCallback(({ item }: { item: FeedItem; index: number }) => {
        // Validate item before rendering to prevent crashes
        if (!item || !item.id) {
            logger.warn('Invalid post item', item);
            return null;
        }

        // CRITICAL: Don't add key prop here - FlashList handles keys via keyExtractor
        // PostItem is already memoized with arePropsEqual, so it will only rerender when needed
        return <PostItem post={item} />;
    }, []);

    const keyExtractor = useCallback((item: FeedItem) => getItemKey(item), []);

    // CRITICAL: getItemType helps FlashList properly recycle components
    const getItemType = useCallback((item: FeedItem) => {
        // Return item type based on post structure to help FlashList recycle correctly
        if ((item as any)?.original || (item as any)?.repostOf) return 'repost';
        if ((item as any)?.quoted || (item as any)?.quoteOf) return 'quote';
        if ((item as any)?.parentPostId || (item as any)?.replyTo) return 'reply';
        return 'post'; // Default type
    }, []);

    // Optimized data hash - only recalculate when items actually change
    const dataHash = useMemo(() => {
        const count = displayItems.length;
        if (count === 0) return 'empty';
        // Use first few and last few IDs for hash - faster than all items
        const firstKey = getItemKey(displayItems[0]);
        const lastKey = getItemKey(displayItems[count - 1]);
        // Include count and a few middle items for better uniqueness
        const midKey = count > 2 ? getItemKey(displayItems[Math.floor(count / 2)]) : '';
        return `${count}-${firstKey}-${midKey}-${lastKey}`;
    }, [displayItems.length, displayItems]);

    // Register scrollable with LayoutScrollContext
    const clearScrollableRegistration = useCallback(() => {
        if (unregisterScrollableRef.current) {
            unregisterScrollableRef.current();
            unregisterScrollableRef.current = null;
        }
    }, []);

    const assignListRef = useCallback((node: any) => {
        flatListRef.current = node;
        clearScrollableRegistration();
        if (scrollEnabled === false) return;
        if (node) {
            unregisterScrollableRef.current = registerScrollable(node);
        }
    }, [clearScrollableRegistration, registerScrollable, scrollEnabled]);

    useEffect(() => {
        if (scrollEnabled === false) {
            clearScrollableRegistration();
            return;
        }
        if (flatListRef.current && !unregisterScrollableRef.current) {
            unregisterScrollableRef.current = registerScrollable(flatListRef.current);
        }
    }, [clearScrollableRegistration, registerScrollable, scrollEnabled]);

    useEffect(() => () => {
        clearScrollableRegistration();
    }, [clearScrollableRegistration]);

    // Handle scroll events
    const handleScrollEvent = useCallback((event: any) => {
        if (scrollEnabled !== false && handleScroll) {
            handleScroll(event);
        }
    }, [handleScroll, scrollEnabled]);

    // Handle wheel events
    const handleWheelEvent = useCallback((event: any) => {
        if (forwardWheelEvent) {
            forwardWheelEvent(event);
        }
    }, [forwardWheelEvent]);

    // Web-specific dataSet for scroll detection
    const dataSetForWeb = useMemo(() => {
        if (Platform.OS !== 'web') return undefined;
        return { layoutscroll: 'true' };
    }, []);

    // Memoize RefreshControl to prevent recreation on every render
    const refreshControl = useMemo(() => {
        if (hideRefreshControl) return undefined;
        return (
            <RefreshControl
                refreshing={refreshing}
                onRefresh={handleRefresh}
                colors={[theme.colors.primary]}
                tintColor={theme.colors.primary}
            />
        );
    }, [hideRefreshControl, refreshing, handleRefresh, theme.colors.primary]);

    // Memoize container style
    const containerStyle = useMemo(
        () => flattenStyleArray([styles.container, { backgroundColor: theme.colors.background }]),
        [theme.colors.background]
    );

    // Memoize list content style
    const listContentStyle = useMemo(
        () =>
            flattenStyleArray([
                styles.listContent,
                { backgroundColor: theme.colors.background },
                contentContainerStyle,
            ]),
        [theme.colors.background, contentContainerStyle]
    );

    // Memoize list style
    const listStyle = useMemo(
        () =>
            flattenStyleArray([
                styles.list,
                { backgroundColor: theme.colors.background },
                style,
            ]),
        [theme.colors.background, style]
    );

    // Memoize header component
    const headerComponent = useMemo(
        () => listHeaderComponent ?? <FeedHeader showComposeButton={showComposeButton} onComposePress={onComposePress} hideHeader={hideHeader} />,
        [listHeaderComponent, showComposeButton, onComposePress, hideHeader]
    );

    // Memoize empty state handler
    const handleRetry = useCallback(async () => {
        feedState.clearError();
        try {
            await feedState.fetchInitial(true);
        } catch (retryError) {
            logger.error('Retry failed', retryError);
        }
    }, [feedState]);

    const emptyStateComponent = useMemo(
        () => (
            <FeedEmptyState
                isLoading={feedState.isLoading}
                error={feedState.error}
                hasItems={finalRenderItems.length > 0}
                type={type}
                showOnlySaved={showOnlySaved}
                onRetry={handleRetry}
            />
        ),
        [feedState.isLoading, feedState.error, finalRenderItems.length, type, showOnlySaved, handleRetry]
    );

    // Track if we're loading more (loading while we already have items)
    const isLoadingMore = feedState.isLoading && finalRenderItems.length > 0;

    const footerComponent = useMemo(
        () => (
            <FeedFooter
                showOnlySaved={showOnlySaved}
                hasMore={feedState.hasMore}
                isLoadingMore={isLoadingMore}
                hasItems={finalRenderItems.length > 0}
            />
        ),
        [showOnlySaved, feedState.hasMore, isLoadingMore, finalRenderItems.length]
    );

    return (
        <ErrorBoundary>
            <View
                style={containerStyle}
                {...(Platform.OS === 'web' && dataSetForWeb ? { 'data-layoutscroll': 'true' } : {})}
            >
                <LoadingTopSpinner
                    showLoading={feedState.isLoading && !refreshing && !isLoadingMore && finalRenderItems.length === 0}
                />
                <FlashList
                    ref={assignListRef}
                    data={finalRenderItems}
                    renderItem={renderPostItem}
                    keyExtractor={keyExtractor}
                    getItemType={getItemType}
                    {...({
                        estimatedItemSize: 250,
                        extraData: dataHash,
                        ListHeaderComponent: headerComponent,
                        ListEmptyComponent: emptyStateComponent,
                        ListFooterComponent: isLoadingMore ? footerComponent : null,
                        scrollEnabled: scrollEnabled,
                        refreshControl: refreshControl,
                        onEndReached: handleLoadMore,
                        onEndReachedThreshold: 0.7,
                        showsVerticalScrollIndicator: false,
                        onScroll: scrollEnabled === false ? undefined : handleScrollEvent,
                        scrollEventThrottle: scrollEnabled === false ? undefined : scrollEventThrottle,
                        onWheel: Platform.OS === 'web' ? handleWheelEvent : undefined,
                        contentContainerStyle: listContentStyle,
                        style: listStyle,
                        // Performance optimizations for FlashList
                        drawDistance: 600,
                        removeClippedSubviews: true,
                        maxToRenderPerBatch: 10,
                        windowSize: 10,
                        initialNumToRender: 12,
                        updateCellsBatchingPeriod: 50,
                        disableAutoLayout: false,
                        overrideItemLayout: (layout: any, item: any, index: number) => {
                            // Provide layout hints for better performance
                            layout.size = 250; // Estimated item size
                        },
                    } as any)}
                />
            </View>
        </ErrorBoundary>
    );
});

Feed.displayName = 'Feed';

// Custom comparison function to prevent unnecessary re-renders
const arePropsEqual = (prevProps: FeedProps, nextProps: FeedProps) => {
    // Always rerender if reloadKey changes (user pressed same tab)
    if (prevProps.reloadKey !== nextProps.reloadKey) {
        return false;
    }

    // Rerender if feed type changed
    if (prevProps.type !== nextProps.type) {
        return false;
    }

    // Rerender if userId changed
    if (prevProps.userId !== nextProps.userId) {
        return false;
    }

    // Rerender if filters changed (deep comparison using utility)
    if (prevProps.filters !== nextProps.filters) {
        // If both are undefined/null, they're equal
        if (!prevProps.filters && !nextProps.filters) {
            // Continue to next check
        } else {
            // Use JSON.stringify for deep comparison (same as before but clearer)
            const prevFilters = JSON.stringify(prevProps.filters || {});
            const nextFilters = JSON.stringify(nextProps.filters || {});
            if (prevFilters !== nextFilters) {
                return false;
            }
        }
    }

    // Rerender if showOnlySaved changed
    if (prevProps.showOnlySaved !== nextProps.showOnlySaved) {
        return false;
    }

    // Rerender if scrollEnabled changed
    if (prevProps.scrollEnabled !== nextProps.scrollEnabled) {
        return false;
    }

    // Props are equal, skip re-render
    return true;
};

export default memo(Feed, arePropsEqual);

const styles = StyleSheet.create({
    container: {
        flex: 1,
        minHeight: 0,
    },
    list: {
        flex: 1,
        minHeight: 0,
    },
    listContent: {
        flexGrow: 0,
        alignSelf: 'stretch',
    },
});
