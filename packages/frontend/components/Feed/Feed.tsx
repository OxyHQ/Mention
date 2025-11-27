import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
    StyleSheet,
    View,
    RefreshControl,
    Platform,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { FeedType, UIPost, Reply, FeedRepost as Repost } from '@mention/shared-types';
import PostItem from './PostItem';

// Type alias for feed items (what PostItem expects)
type FeedItem = UIPost | Reply | Repost;
import ErrorBoundary from '../ErrorBoundary';
import { LoadingTopSpinner } from '@/components/ui/Loading';
import { useOxy } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { flattenStyleArray } from '@/utils/theme';
import { createScopedLogger } from '@/utils/logger';
import { useFeedState } from '@/hooks/useFeedState';
import { useDeepCompareMemo } from '@/hooks/useDeepCompare';
import { FeedFilters, getItemKey, deduplicateItems, deepEqual } from '@/utils/feedUtils';
import { FeedHeader } from './FeedHeader';
import { FeedFooter } from './FeedFooter';
import { FeedEmptyState } from './FeedEmptyState';
import { usePrivacyControls } from '@/hooks/usePrivacyControls';
import { extractAuthorId } from '@/utils/postUtils';

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
    style?: React.ComponentProps<typeof View>['style'];
    contentContainerStyle?: React.ComponentProps<typeof View>['style'];
    listHeaderComponent?: React.ReactElement | null;
}

const DEFAULT_FEED_PROPS = {
    showComposeButton: false,
    hideHeader: false,
    hideRefreshControl: false,
    scrollEnabled: true,
    showOnlySaved: false,
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
        style,
        contentContainerStyle,
        listHeaderComponent,
    } = { ...DEFAULT_FEED_PROPS, ...props };

    const theme = useTheme();
    const flatListRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent } = useLayoutScroll();

    // Determine if we should use scoped (local) feed state
    const useScoped = !!(filters && Object.keys(filters).length) && !showOnlySaved;

    const { user: currentUser, isAuthenticated, showBottomSheet } = useOxy();
    const { blockedSet } = usePrivacyControls();

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

    // Handle load more - debounced in hook
    // For unauthenticated users, show sign-in prompt instead of loading more
    const handleLoadMore = useCallback(() => {
        if (!feedState.hasMore || feedState.isLoading) return;

        // If user is not authenticated, show sign-in prompt instead of loading more
        if (!isAuthenticated) {
            showBottomSheet?.('SignIn');
            return;
        }

        feedState.loadMore();
    }, [feedState.hasMore, feedState.isLoading, feedState.loadMore, isAuthenticated, showBottomSheet]);

    // Process items with single-pass deduplication and sorting
    const finalRenderItems = useDeepCompareMemo(() => {
        const src = feedState.items;
        if (src.length === 0) return [];

        // Single deduplication pass using utility
        const deduped = deduplicateItems(src, getItemKey);

        // Fast privacy filtering using Set lookup (O(1) vs O(n) function call)
        const filteredByPrivacy = blockedSet.size > 0
            ? deduped.filter((item) => {
                const authorId = extractAuthorId(item);
                return authorId ? !blockedSet.has(authorId) : true;
            })
            : deduped;

        // Only apply sorting for 'for_you' feed if user is authenticated
        const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
        if (effectiveType === 'for_you' && currentUser?.id && filteredByPrivacy.length > 0) {
            const now = Date.now();
            const THRESHOLD_MS = 60 * 1000;
            const mineNow: Array<{ item: FeedItem; ts: number }> = [];
            const others: FeedItem[] = [];

            // Single pass to separate items
            for (const item of filteredByPrivacy) {
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

        return filteredByPrivacy;
    }, [feedState.items, type, showOnlySaved, currentUser?.id, blockedSet]);

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

    // Optimized data hash for FlashList extraData - only recalculate when items change
    const dataHash = useMemo(() => {
        const count = finalRenderItems.length;
        if (count === 0) return 'empty';
        // Use first, middle, and last IDs for hash - faster than processing all items
        const firstKey = getItemKey(finalRenderItems[0]);
        const lastKey = getItemKey(finalRenderItems[count - 1]);
        const midKey = count > 2 ? getItemKey(finalRenderItems[Math.floor(count / 2)]) : '';
        return `${count}-${firstKey}-${midKey}-${lastKey}`;
    }, [finalRenderItems]);

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

    // Web-specific dataSet for scroll detection - memoized once
    const dataSetForWeb = Platform.OS === 'web' ? { layoutscroll: 'true' } : undefined;

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

    // Memoize empty state retry handler
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

    // Show footer for loading more or sign-in prompt for unauthenticated users
    const showFooter = isLoadingMore || (!isAuthenticated && finalRenderItems.length > 0);

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
                        ListFooterComponent: showFooter ? footerComponent : null,
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
                        overrideItemLayout: (layout: any) => {
                            layout.size = 250; // Estimated item size for better recycling
                        },
                    } as any)}
                />
            </View>
        </ErrorBoundary>
    );
});

Feed.displayName = 'Feed';

/**
 * Optimized props comparison to prevent unnecessary re-renders
 * Uses deep comparison for filters to avoid re-renders when filter objects change by reference only
 */
const arePropsEqual = (prevProps: FeedProps, nextProps: FeedProps): boolean => {
    // Fast path checks - most common changes
    if (
        prevProps.reloadKey !== nextProps.reloadKey ||
        prevProps.type !== nextProps.type ||
        prevProps.userId !== nextProps.userId ||
        prevProps.showOnlySaved !== nextProps.showOnlySaved ||
        prevProps.scrollEnabled !== nextProps.scrollEnabled
    ) {
        return false;
    }

    // Deep comparison for filters using utility
    if (!deepEqual(prevProps.filters, nextProps.filters)) {
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
