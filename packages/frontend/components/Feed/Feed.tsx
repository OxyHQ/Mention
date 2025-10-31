import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    RefreshControl,
    ActivityIndicator
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { usePostsStore, useFeedSelector, useUserFeedSelector } from '../../stores/postsStore';
import { FeedType } from '@mention/shared-types';
import PostItem from './PostItem';
import ErrorBoundary from '../ErrorBoundary';
import LoadingTopSpinner from '../LoadingTopSpinner';
import { colors } from '../../styles/colors';
import { useOxy } from '@oxyhq/services';
import { feedService } from '../../services/feedService';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { Platform } from 'react-native';

interface FeedProps {
    type: FeedType;
    userId?: string;
    showComposeButton?: boolean;
    onComposePress?: () => void;
    hideHeader?: boolean;
    hideRefreshControl?: boolean;
    scrollEnabled?: boolean;
    showOnlySaved?: boolean;
    filters?: Record<string, any>;
    reloadKey?: string | number;
    autoRefresh?: boolean;
    refreshInterval?: number;
    onSavePress?: (postId: string) => void;
    style?: any;
    contentContainerStyle?: any;
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

const Feed = (props: FeedProps) => {
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
    const isScreenNotMobile = useIsScreenNotMobile();
    const flatListRef = useRef<any>(null);
    const unregisterScrollableRef = useRef<(() => void) | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const { handleScroll, scrollEventThrottle, registerScrollable, forwardWheelEvent } = useLayoutScroll();

    // When filters are provided, scope the feed locally to avoid clashes
    const useScoped = !!(filters && Object.keys(filters || {}).length);

    // Local state for scoped (filtered) feeds
    const [localItems, setLocalItems] = useState<any[]>([]);
    const [localHasMore, setLocalHasMore] = useState<boolean>(true);
    const [localNextCursor, setLocalNextCursor] = useState<string | undefined>(undefined);
    const [localLoading, setLocalLoading] = useState<boolean>(false);
    const [localError, setLocalError] = useState<string | null>(null);

    const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
    const globalFeed = useFeedSelector(effectiveType);
    const userFeed = useUserFeedSelector(userId || '', effectiveType);
    const feedData = showOnlySaved ? globalFeed : (userId ? userFeed : globalFeed);
    const isLoading = useScoped ? localLoading : !!feedData?.isLoading;
    const error = useScoped ? localError : feedData?.error;
    const hasMore = useScoped ? localHasMore : !!feedData?.hasMore;

    const filteredFeedData = useMemo(() => showOnlySaved
        ? {
            ...feedData,
            items: feedData?.items?.filter(item => {
                return item.isSaved === true;
            }) || []
        }
        : feedData, [showOnlySaved, feedData]);


    const {
        fetchFeed,
        fetchUserFeed,
        fetchSavedPosts,
        refreshFeed,
        loadMoreFeed,
        clearError
    } = usePostsStore();

    const filtersKey = useMemo(() => JSON.stringify(filters || {}), [filters]);
    const { user: currentUser, isAuthenticated } = useOxy();
    const isFetchingRef = useRef(false);

    const itemKey = useCallback((it: any): string => {
        // Try id first (should be string), then _id (could be ObjectId or string)
        let normalizedId = '';
        if (it?.id) {
            normalizedId = String(it.id);
        } else if (it?._id) {
            const _id = it._id;
            normalizedId = typeof _id === 'object' && _id.toString
                ? _id.toString()
                : String(_id);
        } else if (it?._id_str) {
            normalizedId = String(it._id_str);
        } else if (it?.postId) {
            normalizedId = String(it.postId);
        } else if (it?.post?.id) {
            normalizedId = String(it.post.id);
        } else if (it?.post?._id) {
            const _id = it.post._id;
            normalizedId = typeof _id === 'object' && _id.toString
                ? _id.toString()
                : String(_id);
        }

        if (normalizedId && normalizedId !== 'undefined' && normalizedId !== 'null' && normalizedId !== '') {
            return normalizedId;
        }

        const fallback = it?.username || JSON.stringify(it);
        return String(fallback);
    }, []);

    const isInitialMountRef = useRef(true);

    const fetchInitialFeed = useCallback(async () => {
        if (isFetchingRef.current) return;
        if (isAuthenticated && !currentUser?.id) return;

        const shouldRefresh = isInitialMountRef.current || (reloadKey !== undefined && reloadKey !== null);

        if (!useScoped && !shouldRefresh) {
            const currentFeed = usePostsStore.getState().feeds[type];
            if (currentFeed?.items && currentFeed.items.length > 0) {
                return;
            }
        }

        isFetchingRef.current = true;

        try {
            if (!useScoped) {
                clearError();
            } else {
                setLocalError(null);
            }

            if (showOnlySaved) {
                await fetchSavedPosts({ page: 1, limit: 50 });
                return;
            }

            if (useScoped) {
                setLocalLoading(true);
                const resp = await feedService.getFeed({ type, limit: 20, filters } as any);
                let items = resp.items || [];

                const pid = (filters || {}).postId || (filters || {}).parentPostId;
                if (pid) {
                    items = items.filter((it: any) => String(it.postId || it.parentPostId) === String(pid));
                }

                // Deduplicate scoped items using Map for O(1) lookup
                const seen = new Map<string, any>();
                for (const item of items) {
                    const key = itemKey(item);
                    if (!seen.has(key)) {
                        seen.set(key, item);
                    }
                }

                setLocalItems(Array.from(seen.values()));
                setLocalHasMore(!!resp.hasMore);
                setLocalNextCursor(resp.nextCursor);
            } else if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, filters });
            } else {
                if (shouldRefresh) {
                    await refreshFeed(type, filters);
                } else {
                    await fetchFeed({ type, limit: 20, filters });
                }
            }
        } catch (error) {
            console.error('Feed: Error fetching initial feed:', error);
            if (useScoped) {
                setLocalError('Failed to load');
            }
        } finally {
            if (useScoped) setLocalLoading(false);
            isFetchingRef.current = false;
            isInitialMountRef.current = false;
        }
    }, [type, userId, showOnlySaved, useScoped, filters, filtersKey, reloadKey, isAuthenticated, currentUser?.id, fetchFeed, fetchUserFeed, fetchSavedPosts, refreshFeed, clearError, itemKey]);

    useEffect(() => {
        fetchInitialFeed();
    }, [fetchInitialFeed]);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            if (!useScoped) {
                clearError();
            }

            if (showOnlySaved) {
                await fetchSavedPosts({ page: 1, limit: 50 });
            } else if (useScoped) {
                try {
                    setLocalError(null);
                    const resp = await feedService.getFeed({ type, limit: 20, filters } as any);
                    const items = resp.items || []; // Use items directly since backend returns proper schema
                    setLocalItems(items);
                    setLocalHasMore(!!resp.hasMore);
                    setLocalNextCursor(resp.nextCursor);
                } catch (error) {
                    console.error('Error refreshing scoped feed:', error);
                    setLocalError('Failed to refresh');
                } finally {
                    setLocalLoading(false);
                }
            } else if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, filters });
            } else {
                await refreshFeed(type, filters);
            }
        } catch (error) {
            console.error('Error refreshing feed:', error);
            if (useScoped) {
                setLocalError('Failed to refresh');
            }
        } finally {
            setRefreshing(false);
        }
    }, [type, effectiveType, userId, showOnlySaved, refreshFeed, fetchUserFeed, fetchSavedPosts, filters, useScoped, clearError]);

    const handleLoadMore = useCallback(async () => {
        if (showOnlySaved) return;
        if (!hasMore || isLoading || isLoadingMore) return;

        setIsLoadingMore(true);
        try {
            if (useScoped) {
                if (!localHasMore || localLoading) return;
                setLocalLoading(true);
                setLocalError(null);

                const resp = await feedService.getFeed({
                    type,
                    limit: 20,
                    cursor: localNextCursor,
                    filters
                });

                let items = resp.items || [];
                const pid = (filters || {}).postId || (filters || {}).parentPostId;
                if (pid) {
                    items = items.filter((item: any) =>
                        String(item.postId || item.parentPostId) === String(pid)
                    );
                }

                setLocalItems(prev => {
                    const seen = new Map<string, boolean>();
                    prev.forEach(p => {
                        const key = itemKey(p);
                        if (key) seen.set(key, true);
                    });

                    const uniqueNew = items.filter((p: any) => {
                        const key = itemKey(p);
                        return key && !seen.has(key);
                    });

                    const newSeen = new Map<string, any>();
                    uniqueNew.forEach(p => {
                        const key = itemKey(p);
                        if (key && !newSeen.has(key)) {
                            newSeen.set(key, p);
                        }
                    });

                    return prev.concat(Array.from(newSeen.values()));
                });
                const prevCursor = localNextCursor;
                const nextCursor = resp.nextCursor;
                const cursorAdvanced = !!nextCursor && nextCursor !== prevCursor;
                setLocalHasMore(!!resp.hasMore && cursorAdvanced);
                setLocalNextCursor(nextCursor);
            } else if (userId) {
                await fetchUserFeed(userId, {
                    type: effectiveType,
                    limit: 20,
                    cursor: feedData?.nextCursor,
                    filters
                });
            } else {
                await loadMoreFeed(effectiveType, filters);
            }
        } catch (error) {
            console.error('Error loading more feed:', error);
            const errorMessage = error instanceof Error ? error.message : 'Failed to load more posts';
            if (useScoped) {
                setLocalError(errorMessage);
            }
        } finally {
            if (useScoped) {
                setLocalLoading(false);
            }
            setIsLoadingMore(false);
        }
    }, [showOnlySaved, hasMore, isLoading, isLoadingMore, type, effectiveType, userId, loadMoreFeed, fetchUserFeed, feedData?.nextCursor, filters, useScoped, localHasMore, localLoading, localNextCursor, localItems, itemKey]);

    const renderPostItem = useCallback(({ item }: { item: any; index: number }) => {
        return <PostItem post={item} />;
    }, []);

    const displayItems = useMemo(() => {
        const src = (useScoped ? localItems : (filteredFeedData?.items || [])) as any[];
        if (src.length === 0) return [];

        const seen = new Map<string, any>();
        for (const item of src) {
            const key = itemKey(item);
            if (key && key !== 'undefined' && key !== 'null' && key !== '' && !seen.has(key)) {
                seen.set(key, item);
            }
        }

        const deduped = Array.from(seen.values());

        if (effectiveType === 'for_you' && currentUser?.id && deduped.length > 0) {
            const now = Date.now();
            const THRESHOLD_MS = 60 * 1000;
            const mineNow: any[] = [];
            const others: any[] = [];

            for (const item of deduped) {
                const ownerId = item?.user?.id;
                if (item?.isLocalNew || (ownerId === currentUser.id)) {
                    const d = item?.date || item?.createdAt;
                    const ts = d ? Date.parse(d) : 0;
                    if (ts && (now - ts) <= THRESHOLD_MS) {
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
                return [...mineNow.map(x => x.item), ...others];
            }
        }

        return deduped;
    }, [useScoped, localItems, filteredFeedData?.items, effectiveType, currentUser?.id, itemKey]);

    const renderEmptyState = useCallback(() => {
        if (isLoading) return null;

        const hasError = error || (useScoped && localError);
        const hasNoItems = displayItems.length === 0;

        if (hasError && hasNoItems) {
            return (
                <View style={[styles.emptyState, { backgroundColor: theme.colors.background }]}>
                    <Text style={[styles.errorText, { color: theme.colors.error }]}>Failed to load posts</Text>
                    <TouchableOpacity
                        style={[styles.retryButton, { backgroundColor: theme.colors.primary, shadowColor: theme.colors.shadow }]}
                        onPress={async () => {
                            clearError();
                            if (useScoped) setLocalError(null);
                            try {
                                if (showOnlySaved) {
                                    await fetchSavedPosts({ page: 1, limit: 50 });
                                } else if (userId) {
                                    await fetchUserFeed(userId, { type, limit: 20, filters });
                                } else {
                                    await fetchFeed({ type: effectiveType, limit: 20, filters });
                                }
                            } catch (retryError) {
                                console.error('Retry failed:', retryError);
                            }
                        }}
                    >
                        <Text style={[styles.retryButtonText, { color: theme.colors.card }]}>Retry</Text>
                    </TouchableOpacity>
                </View>
            );
        }

        return (
            <View style={[styles.emptyState, { backgroundColor: theme.colors.background }]}>
                <Text style={[styles.emptyStateText, { color: theme.colors.text }]}>
                    {showOnlySaved ? 'No saved posts yet' : 'No posts yet'}
                </Text>
                <Text style={[styles.emptyStateSubtext, { color: theme.colors.textSecondary }]}>
                    {showOnlySaved
                        ? 'Posts you save will appear here. Tap the bookmark icon on any post to save it.'
                        : type === 'posts' ? 'Be the first to share something!' :
                            type === 'media' ? 'No media posts found' :
                                type === 'replies' ? 'No replies yet' :
                                    type === 'reposts' ? 'No reposts yet' :
                                        'Start following people to see their posts'}
                </Text>
            </View>
        );
    }, [isLoading, error, localError, useScoped, type, effectiveType, userId, clearError, fetchFeed, fetchUserFeed, fetchSavedPosts, showOnlySaved, displayItems.length, filters, theme]);

    const renderFooter = useCallback(() => {
        if (showOnlySaved || !hasMore || !isLoadingMore) return null;

        const hasItems = useScoped ? (localItems.length > 0) : !!(filteredFeedData?.items && filteredFeedData.items.length > 0);
        if (!hasItems) return null;

        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
            </View>
        );
    }, [showOnlySaved, hasMore, isLoadingMore, filteredFeedData?.items, useScoped, localItems.length, theme]);

    const renderHeader = useCallback(() => {
        if (!showComposeButton || hideHeader) return null;

        return (
            <View style={{ backgroundColor: theme.colors.background }}>
                <TouchableOpacity
                    style={[styles.composeButton, { backgroundColor: theme.colors.backgroundSecondary, borderColor: theme.colors.border, shadowColor: theme.colors.shadow }]}
                    onPress={onComposePress}
                >
                    <Text style={[styles.composeButtonText, { color: theme.colors.textSecondary }]}>What&apos;s happening?</Text>
                </TouchableOpacity>
            </View>
        );
    }, [showComposeButton, onComposePress, hideHeader, theme]);

    const keyExtractor = useCallback((item: any) => itemKey(item), [itemKey]);

    const dataHash = useMemo(() => {
        const count = displayItems.length;
        if (count === 0) return 'empty';
        const firstKey = itemKey(displayItems[0]);
        const lastKey = itemKey(displayItems[count - 1]);
        return `${count}-${firstKey}-${lastKey}`;
    }, [displayItems, itemKey]);

    const finalRenderItems = displayItems;

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

    return (
        <ErrorBoundary>
            <View 
                style={[styles.container, { backgroundColor: theme.colors.background }]}
                {...(Platform.OS === 'web' && dataSetForWeb ? { 'data-layoutscroll': 'true' } : {})}
            >
                <LoadingTopSpinner showLoading={isLoading && !refreshing && !isLoadingMore && displayItems.length === 0} />
                <FlashList
                    ref={assignListRef}
                    data={finalRenderItems}
                    renderItem={renderPostItem}
                    keyExtractor={keyExtractor}
                    {...({
                        estimatedItemSize: 250,
                        extraData: dataHash,
                        ListHeaderComponent: listHeaderComponent ?? renderHeader,
                        ListEmptyComponent: renderEmptyState,
                        ListFooterComponent: renderFooter,
                        scrollEnabled: scrollEnabled,
                        refreshControl: hideRefreshControl ? undefined : (
                            <RefreshControl
                                refreshing={refreshing}
                                onRefresh={handleRefresh}
                                colors={[theme.colors.primary]}
                                tintColor={theme.colors.primary}
                            />
                        ),
                        onEndReached: handleLoadMore,
                        onEndReachedThreshold: 0.5,
                        showsVerticalScrollIndicator: false,
                        onScroll: scrollEnabled === false ? undefined : handleScrollEvent,
                        scrollEventThrottle: scrollEnabled === false ? undefined : scrollEventThrottle,
                        onWheel: Platform.OS === 'web' ? handleWheelEvent : undefined,
                        contentContainerStyle: [
                            styles.listContent,
                            { backgroundColor: theme.colors.background },
                            contentContainerStyle
                        ],
                        style: [
                            styles.list,
                            { backgroundColor: theme.colors.background },
                            style
                        ],
                        drawDistance: 500,
                    } as any)}
                />
            </View>
        </ErrorBoundary>
    );
};

export default Feed;

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
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 80,
        paddingHorizontal: 32,
    },
    emptyStateText: {
        fontSize: 20,
        fontWeight: '700',
        marginTop: 24,
        textAlign: 'center',
        letterSpacing: -0.5,
    },
    emptyStateSubtext: {
        fontSize: 16,
        marginTop: 12,
        textAlign: 'center',
        lineHeight: 24,
        maxWidth: 280,
    },
    errorText: {
        fontSize: 16,
        marginBottom: 20,
        textAlign: 'center',
        fontWeight: '500',
    },
    retryButton: {
        paddingHorizontal: 28,
        paddingVertical: 14,
        borderRadius: 24,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    retryButtonText: {
        fontSize: 16,
        fontWeight: '600',
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 8,
    },
    footerText: {
        fontSize: 14,
        fontWeight: '500',
    },
    composeButton: {
        marginHorizontal: 16,
        marginVertical: 12,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 1,
    },
    composeButtonText: {
        fontSize: 16,
        fontWeight: '400',
    },
});
