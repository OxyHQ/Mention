import React, { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import {
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    RefreshControl,
    ActivityIndicator
} from 'react-native';
import LegendList from '../../components/LegendList';
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

// Improved interface with better organization and type safety
interface FeedProps {
    // Core props
    type: FeedType;
    userId?: string;

    // UI Configuration
    showComposeButton?: boolean;
    onComposePress?: () => void;
    hideHeader?: boolean;
    hideRefreshControl?: boolean;
    scrollEnabled?: boolean;

    // Data configuration
    showOnlySaved?: boolean;
    filters?: Record<string, any>;
    reloadKey?: string | number;

    // Auto-refresh (currently unused - keeping for future)
    autoRefresh?: boolean;
    refreshInterval?: number;
    onSavePress?: (postId: string) => void;

    // Style props
    style?: any;
    contentContainerStyle?: any;
    listHeaderComponent?: React.ReactElement | null;

    // Legend List specific options with better defaults
    recycleItems?: boolean;
    maintainScrollAtEnd?: boolean;
    maintainScrollAtEndThreshold?: number;
    alignItemsAtEnd?: boolean;
    maintainVisibleContentPosition?: boolean;
}

// Default props for better maintainability
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
    // Merge with defaults for cleaner code
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
        autoRefresh: _autoRefresh, // Unused but kept for API compatibility
        refreshInterval: _refreshInterval, // Unused but kept for API compatibility
        onSavePress: _onSavePress, // Unused but kept for API compatibility
        style,
        contentContainerStyle,
        listHeaderComponent,
        recycleItems,
        maintainScrollAtEnd,
        maintainScrollAtEndThreshold,
        alignItemsAtEnd,
        maintainVisibleContentPosition,
    } = { ...DEFAULT_FEED_PROPS, ...props };
    const theme = useTheme();
    const flatListRef = useRef<any>(null);
    const [refreshing, setRefreshing] = useState(false);

    // When filters are provided, scope the feed locally to avoid clashes
    const useScoped = !!(filters && Object.keys(filters || {}).length);

    // Local state for scoped (filtered) feeds
    const [localItems, setLocalItems] = useState<any[]>([]);
    const [localHasMore, setLocalHasMore] = useState<boolean>(true);
    const [localNextCursor, setLocalNextCursor] = useState<string | undefined>(undefined);
    const [localLoading, setLocalLoading] = useState<boolean>(false);
    const [localError, setLocalError] = useState<string | null>(null);

    // Determine which feed slice to use (saved feed bypasses user feeds)
    const effectiveType = (showOnlySaved ? 'saved' : type) as FeedType;
    const globalFeed = useFeedSelector(effectiveType);
    // Always call hooks in a stable order; pass empty string when no userId
    const userFeed = useUserFeedSelector(userId || '', effectiveType);
    const feedData = showOnlySaved ? globalFeed : (userId ? userFeed : globalFeed);
    const isLoading = useScoped ? localLoading : !!feedData?.isLoading;
    const error = useScoped ? localError : feedData?.error;
    const hasMore = useScoped ? localHasMore : !!feedData?.hasMore;

    // Filter posts to show only saved ones if showOnlySaved is true
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

    // Initial feed fetch - memoize to avoid recreating on every render
    const filtersKey = useMemo(() => JSON.stringify(filters || {}), [filters]);

    // Get authentication state
    const { user: currentUser, isAuthenticated } = useOxy();

    useEffect(() => {
        const fetchInitialFeed = async (retryCount = 0) => {
            // Don't fetch if user is authenticated but user data isn't ready yet
            if (isAuthenticated && !currentUser?.id) {
                console.log('Waiting for user data to be available...');
                return;
            }

            try {
                // Clear any previous errors
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
                    let items = resp.items || []; // Use items directly since backend returns proper schema

                    // debug logs removed for production

                    const pid = (filters || {}).postId || (filters || {}).parentPostId;
                    if (pid) {
                        items = items.filter((it: any) => String(it.postId || it.parentPostId) === String(pid));
                    }
                    setLocalItems(items);
                    setLocalHasMore(!!resp.hasMore);
                    setLocalNextCursor(resp.nextCursor);
                } else if (userId) {
                    await fetchUserFeed(userId, { type, limit: 20, filters });
                } else {
                    await fetchFeed({ type, limit: 20, filters });
                }
            } catch (error) {
                console.error('Error fetching initial feed:', error);

                // Retry logic - automatically retry once after a short delay
                if (retryCount < 1) {
                    console.log('Retrying feed fetch...');
                    // Don't set error state yet, just retry
                    setTimeout(() => {
                        fetchInitialFeed(retryCount + 1);
                    }, 1000);
                    return;
                }

                // Only set error after all retries fail
                if (useScoped) {
                    setLocalError('Failed to load');
                } else {
                    // For store-based feeds, the error is already set in the store
                    // We just need to ensure it's not showing during the retry
                }
            } finally {
                if (useScoped) setLocalLoading(false);
            }
        };

        fetchInitialFeed();
    }, [type, effectiveType, userId, showOnlySaved, fetchFeed, fetchUserFeed, fetchSavedPosts, filtersKey, filters, useScoped, reloadKey, clearError, isAuthenticated, currentUser?.id]);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            // Clear errors on refresh
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
        // Saved posts currently load as a single page; skip infinite scroll
        if (showOnlySaved) return;
        if (!hasMore || isLoading) return;

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
                // Dedupe against localItems and decide hasMore by cursor advance
                setLocalItems(prev => {
                    const seen = new Set(prev.map((p: any) => String(p.id || p._id || p.postId)));
                    const uniqueNew = items.filter((p: any) => !seen.has(String(p.id || p._id || p.postId)));
                    return prev.concat(uniqueNew);
                });
                const prevCursor = localNextCursor;
                const nextCursor = resp.nextCursor;
                const cursorAdvanced = !!nextCursor && nextCursor !== prevCursor;
                // If no unique items and no cursor advance, stop
                const uniqueNewCount = (() => {
                    const seen = new Set(localItems.map((p: any) => String(p.id || p._id || p.postId)));
                    return items.filter((p: any) => !seen.has(String(p.id || p._id || p.postId))).length;
                })();
                const hasMoreSafe = (uniqueNewCount > 0 || cursorAdvanced) ? (!!resp.hasMore || cursorAdvanced) : false;
                setLocalHasMore(hasMoreSafe);
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
            // Global store errors are handled by the store itself
        } finally {
            if (useScoped) {
                setLocalLoading(false);
            }
        }
    }, [showOnlySaved, hasMore, isLoading, type, effectiveType, userId, loadMoreFeed, fetchUserFeed, feedData?.nextCursor, filters, useScoped, localHasMore, localLoading, localNextCursor, localItems]);

    const renderPostItem = useCallback(({ item }: { item: any }) => (
        <PostItem post={item} />
    ), []);

    // Prioritize current user's fresh posts at the top (For You only)
    // currentUser is already available from above

    // Create a stable key for posts and use the same logic for deduping and keyExtractor
    const itemKey = useCallback((it: any): string => (
        String(
            it?.id || it?._id || it?._id_str || it?.postId || it?.post?.id || it?.post?._id || it?.username || JSON.stringify(it)
        )
    ), []);

    const displayItems = useMemo(() => {
        const src = (useScoped ? localItems : (filteredFeedData?.items || [])) as any[];

        // debug logs removed for production

        if (effectiveType !== 'for_you' || !currentUser?.id) {
            // Deduplicate by key in case upstream merged duplicates
            const seen = new Set<string>();
            const deduped: any[] = [];
            for (const it of src) {
                const k = itemKey(it);
                if (seen.has(k)) continue;
                seen.add(k);
                deduped.push(it);
            }
            return deduped;
        }

        const now = Date.now();
        const THRESHOLD_MS = 60 * 1000; // consider "posted now" within 60s

        const mineNow: any[] = [];
        const others: any[] = [];
        for (const it of src) {
            const ownerId = it?.user?.id;
            const d = it?.date || it?.createdAt;
            const ts = d ? Date.parse(d) : NaN;
            const isRecent = Number.isFinite(ts) && (now - ts) <= THRESHOLD_MS;
            if ((it?.isLocalNew || (ownerId && ownerId === currentUser.id && isRecent))) {
                mineNow.push(it);
            } else {
                others.push(it);
            }
        }
        // Sort "now" posts by newest first
        const mineNowSorted = mineNow.sort((a: any, b: any) => {
            const tb = Date.parse(b?.date || b?.createdAt || '') || 0;
            const ta = Date.parse(a?.date || a?.createdAt || '') || 0;
            return tb - ta;
        });
        // Merge and dedupe to avoid overlapping keys in the list
        const merged = [...mineNowSorted, ...others];
        const seen = new Set<string>();
        const deduped: any[] = [];
        for (const it of merged) {
            const k = itemKey(it);
            if (seen.has(k)) continue;
            seen.add(k);
            deduped.push(it);
        }
        return deduped;
    }, [useScoped, localItems, filteredFeedData?.items, effectiveType, currentUser?.id, itemKey]);

    const renderEmptyState = useCallback(() => {
        // Avoid double loading UI; top spinner handles initial load
        if (isLoading) return null;

        // Only show error if there's an error AND no items to display
        const hasError = error || (useScoped && localError);
        const hasNoItems = displayItems.length === 0;

        if (hasError && hasNoItems) {
            return (
                <View style={[styles.emptyState, { backgroundColor: theme.colors.background }]}>
                    <Text style={[styles.errorText, { color: theme.colors.error }]}>Failed to load posts</Text>
                    <TouchableOpacity
                        style={[styles.retryButton, { backgroundColor: theme.colors.primary }]}
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
        if (showOnlySaved) return null;
        if (!hasMore) return null;

        // Don't show any footer during initial load when the list is empty
        const hasItems = useScoped ? (localItems.length > 0) : !!(filteredFeedData?.items && filteredFeedData.items.length > 0);
        if (!hasItems) return null;

        // Only show the loading footer when an actual load-more request is in progress
        if (!isLoading) return null;

        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
                <Text style={[styles.footerText, { color: theme.colors.textSecondary }]}>Loading more posts...</Text>
            </View>
        );
    }, [showOnlySaved, hasMore, isLoading, filteredFeedData?.items, useScoped, localItems.length]);

    const renderHeader = useCallback(() => {
        if (!showComposeButton || hideHeader) return null;

        return (
            <TouchableOpacity
                style={[styles.composeButton, { backgroundColor: theme.colors.backgroundSecondary }]}
                onPress={onComposePress}
            >
                <Text style={[styles.composeButtonText, { color: theme.colors.textSecondary }]}>What&apos;s happening?</Text>
            </TouchableOpacity>
        );
    }, [showComposeButton, onComposePress, hideHeader, theme]);

    const keyExtractor = useCallback((item: any) => itemKey(item), [itemKey]);

    const getItemLayout = useCallback((data: any, index: number) => ({
        length: 200,
        offset: 200 * index,
        index,
    }), []);

    return (
        <ErrorBoundary>
            <View style={styles.container}>
                <LoadingTopSpinner showLoading={isLoading && !refreshing} />
                <LegendList
                    ref={flatListRef}
                    data={displayItems}
                    renderItem={renderPostItem}
                    keyExtractor={keyExtractor}
                    getItemLayout={getItemLayout}
                    ListHeaderComponent={listHeaderComponent ?? renderHeader}
                    ListEmptyComponent={renderEmptyState}
                    ListFooterComponent={renderFooter}
                    scrollEnabled={scrollEnabled}
                    refreshControl={
                        hideRefreshControl ? undefined : (
                            <RefreshControl
                                refreshing={refreshing}
                                onRefresh={handleRefresh}
                                colors={[theme.colors.primary]}
                                tintColor={theme.colors.primary}
                            />
                        )
                    }
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={0.1}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={[styles.listContent, contentContainerStyle]}
                    style={[styles.list, style]}
                    removeClippedSubviews={true}
                    maxToRenderPerBatch={10}
                    windowSize={10}
                    initialNumToRender={10}
                    // LegendList specific props (forwarded)
                    recycleItems={recycleItems}
                    maintainScrollAtEnd={maintainScrollAtEnd}
                    maintainScrollAtEndThreshold={maintainScrollAtEndThreshold}
                    alignItemsAtEnd={alignItemsAtEnd}
                    maintainVisibleContentPosition={maintainVisibleContentPosition}
                />
            </View>
        </ErrorBoundary>
    );
};

export default Feed;

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    list: {
        flex: 1,
    },
    listContent: {
        flexGrow: 1,
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
        color: "#E7E9EA",
        marginTop: 24,
        textAlign: 'center',
        letterSpacing: -0.5,
    },
    emptyStateSubtext: {
        fontSize: 16,
        color: "#71767B",
        marginTop: 12,
        textAlign: 'center',
        lineHeight: 24,
        maxWidth: 280,
    },
    errorText: {
        fontSize: 16,
        color: "#FFA500",
        marginBottom: 20,
        textAlign: 'center',
        fontWeight: '500',
    },
    retryButton: {
        backgroundColor: "#d169e5",
        paddingHorizontal: 28,
        paddingVertical: 14,
        borderRadius: 24,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    retryButtonText: {
        color: "#FFFFFF",
        fontSize: 16,
        fontWeight: '600',
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 24,
        gap: 8,
    },
    footerText: {
        fontSize: 14,
        color: "#71767B",
        fontWeight: '500',
    },
    composeButton: {
        backgroundColor: "#FFFFFF",
        marginHorizontal: 16,
        marginVertical: 12,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: "#2F3336",
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 1,
    },
    composeButtonText: {
        fontSize: 16,
        color: "#71767B",
        fontWeight: '400',
    },
});
