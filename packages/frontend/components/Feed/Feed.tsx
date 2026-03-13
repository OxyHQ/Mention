import React, { useCallback, useEffect, useMemo, useRef, useState, memo } from 'react';
import {
    StyleSheet,
    View,
    RefreshControl,
    Platform,
    Pressable,
    Text,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { FeedType, UIPost, Reply, FeedRepost as Repost, FeedPostSlice } from '@mention/shared-types';
import PostItem from './PostItem';

// Type alias for feed items (what PostItem expects)
type FeedItem = UIPost | Reply | Repost;

// Row type for FlashList with thread state
interface FeedRow {
    item: FeedItem;
    sliceKey: string;
    isThreadParent: boolean;
    isThreadChild: boolean;
    isThreadLastChild: boolean;
    isIncompleteThread: boolean;
}
import ErrorBoundary from '../ErrorBoundary';
import { PostErrorBoundary } from './PostErrorBoundary';
import { Loading as LoadingIcon } from '@/assets/icons/loading-icon';
import { useAuth } from '@oxyhq/services';
import { useTheme } from '@/hooks/useTheme';
import { cn } from '@/lib/utils';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { flattenStyleArray } from '@/utils/theme';
import { useRouter } from 'expo-router';
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
    const router = useRouter();
    const flatListRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent } = useLayoutScroll();

    // Determine if we should use scoped (local) feed state
    const useScoped = !!(filters && Object.keys(filters).length) && !showOnlySaved;

    const { user: currentUser, isAuthenticated, signIn } = useAuth();
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
            signIn().catch(() => {});
            return;
        }

        feedState.loadMore();
    }, [feedState.hasMore, feedState.isLoading, feedState.loadMore, isAuthenticated, signIn]);

    // Transform slices (or items) into FeedRows with thread state
    const feedRows = useDeepCompareMemo((): FeedRow[] => {
        const slices = feedState.slices;
        const src = feedState.items;

        // If we have slices, transform them into FeedRows with thread state
        if (slices && slices.length > 0) {
            const rows: FeedRow[] = [];
            for (const slice of slices) {
                for (let i = 0; i < slice.items.length; i++) {
                    const sliceItem = slice.items[i];
                    const post = sliceItem.post as FeedItem;
                    if (!post || !(post as any).id) continue;

                    // Privacy filter
                    if (blockedSet.size > 0) {
                        const authorId = extractAuthorId(post);
                        if (authorId && blockedSet.has(authorId)) continue;
                    }

                    rows.push({
                        item: post,
                        sliceKey: slice._sliceKey,
                        isThreadParent: i < slice.items.length - 1,
                        isThreadChild: i > 0,
                        isThreadLastChild: i === slice.items.length - 1 && i > 0,
                        isIncompleteThread: slice.isIncompleteThread,
                    });
                }
            }
            return rows;
        }

        // Fallback: wrap flat items into single-post FeedRows (no thread state)
        if (src.length === 0) return [];

        const deduped = deduplicateItems(src, getItemKey);
        const filteredByPrivacy = blockedSet.size > 0
            ? deduped.filter((item) => {
                const authorId = extractAuthorId(item);
                return authorId ? !blockedSet.has(authorId) : true;
            })
            : deduped;

        // Sort recent user posts to top for for_you feed
        let finalItems = filteredByPrivacy;
        const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
        if (effectiveType === 'for_you' && currentUser?.id && filteredByPrivacy.length > 0) {
            const now = Date.now();
            const THRESHOLD_MS = 60 * 1000;
            const mineNow: Array<{ item: FeedItem; ts: number }> = [];
            const others: FeedItem[] = [];

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

            if (mineNow.length > 0) {
                mineNow.sort((a, b) => b.ts - a.ts);
                finalItems = [...mineNow.map((x) => x.item), ...others];
            }
        }

        return finalItems.map((item) => ({
            item,
            sliceKey: getItemKey(item),
            isThreadParent: false,
            isThreadChild: false,
            isThreadLastChild: false,
            isIncompleteThread: false,
        }));
    }, [feedState.slices, feedState.items, type, showOnlySaved, currentUser?.id, blockedSet]);

    // Memoize renderPostItem to prevent recreating on every render
    const renderPostItem = useCallback(({ item: row }: { item: FeedRow; index: number }) => {
        const post = row.item;
        if (!post || !post.id) {
            logger.warn('Invalid post item', post);
            return null;
        }

        const showThreadLink = row.isIncompleteThread && row.isThreadLastChild;

        return (
            <PostErrorBoundary postId={post.id}>
                <PostItem
                    post={post}
                    isThreadParent={row.isThreadParent}
                    isThreadChild={row.isThreadChild}
                    isThreadLastChild={row.isThreadLastChild}
                />
                {showThreadLink && (
                    <Pressable
                        className="border-border"
                        style={styles.showThreadLink}
                        onPress={() => router.push(`/p/${post.id}`)}
                    >
                        <Text className="text-primary" style={styles.showThreadLinkText}>
                            Show this thread
                        </Text>
                    </Pressable>
                )}
            </PostErrorBoundary>
        );
    }, [router]);

    const keyExtractor = useCallback((row: FeedRow) => {
        // Use sliceKey + item id for unique key within a slice
        const itemId = getItemKey(row.item);
        return row.sliceKey !== itemId ? `${row.sliceKey}:${itemId}` : itemId;
    }, []);

    // CRITICAL: getItemType helps FlashList properly recycle components
    const getItemType = useCallback((row: FeedRow) => {
        if (row.isThreadParent) return 'threadParent';
        if (row.isThreadChild) return 'threadChild';
        const item = row.item;
        if ((item as any)?.original || (item as any)?.repostOf) return 'repost';
        if ((item as any)?.quoted || (item as any)?.quoteOf) return 'quote';
        if ((item as any)?.parentPostId || (item as any)?.replyTo) return 'reply';
        return 'post';
    }, []);

    // Optimized data hash for FlashList extraData - only recalculate when items change
    const dataHash = useMemo(() => {
        const count = feedRows.length;
        if (count === 0) return 'empty';
        const firstKey = getItemKey(feedRows[0].item);
        const lastKey = getItemKey(feedRows[count - 1].item);
        const midKey = count > 2 ? getItemKey(feedRows[Math.floor(count / 2)].item) : '';
        return `${count}-${firstKey}-${midKey}-${lastKey}`;
    }, [feedRows]);

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
        () => flattenStyleArray([styles.container]),
        []
    );

    // Memoize list content style
    const listContentStyle = useMemo(
        () =>
            flattenStyleArray([
                styles.listContent,
                contentContainerStyle,
            ]),
        [contentContainerStyle]
    );

    // Memoize list style
    const listStyle = useMemo(
        () =>
            flattenStyleArray([
                styles.list,
                style,
            ]),
        [style]
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
                hasItems={feedRows.length > 0}
                type={type}
                showOnlySaved={showOnlySaved}
                onRetry={handleRetry}
            />
        ),
        [feedState.isLoading, feedState.error, feedRows.length, type, showOnlySaved, handleRetry]
    );

    // Track if we're loading more (loading while we already have items)
    const isLoadingMore = feedState.isLoading && feedRows.length > 0;

    // Show footer for loading more or sign-in prompt for unauthenticated users
    const showFooter = isLoadingMore || (!isAuthenticated && feedRows.length > 0);

    const footerComponent = useMemo(
        () => (
            <FeedFooter
                showOnlySaved={showOnlySaved}
                hasMore={feedState.hasMore}
                isLoadingMore={isLoadingMore}
                hasItems={feedRows.length > 0}
            />
        ),
        [showOnlySaved, feedState.hasMore, isLoadingMore, feedRows.length]
    );

    return (
        <ErrorBoundary>
            <View
                className="bg-background"
                style={containerStyle}
                {...(Platform.OS === 'web' && dataSetForWeb ? { 'data-layoutscroll': 'true' } : {})}
            >
                {feedState.isLoading && !refreshing && !isLoadingMore && feedRows.length === 0 ? (
                    <View style={styles.initialLoadingContainer}>
                        <LoadingIcon size={44} color={theme.colors.primary} />
                    </View>
                ) : null}
                <FlashList
                    ref={assignListRef}
                    data={feedRows}
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
    initialLoadingContainer: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1,
    },
    list: {
        flex: 1,
        minHeight: 0,
    },
    listContent: {
        flexGrow: 0,
        alignSelf: 'stretch',
    },
    showThreadLink: {
        paddingVertical: 10,
        paddingLeft: 64, // HPAD + AVATAR_SIZE + AVATAR_GAP
        paddingRight: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    showThreadLinkText: {
        fontSize: 14,
        fontWeight: '500',
    },
});
