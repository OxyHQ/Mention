import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    RefreshControl,
    ActivityIndicator
} from 'react-native';
import LegendList from '../../components/LegendList';
import { usePostsStore, useFeedSelector, useFeedLoading, useFeedError, useFeedHasMore, useUserFeedSelector } from '../../stores/postsStore';
import { FeedType } from '@mention/shared-types';
import PostItem from './PostItem';
import ErrorBoundary from '../ErrorBoundary';
import LoadingTopSpinner from '../LoadingTopSpinner';
import { colors } from '../../styles/colors';
import { useOxy } from '@oxyhq/services';
import { feedService } from '../../services/feedService';

interface FeedProps {
    type: FeedType;
    showComposeButton?: boolean;
    onComposePress?: () => void;
    userId?: string;
    autoRefresh?: boolean;
    refreshInterval?: number;
    onSavePress?: (postId: string) => void;
    showOnlySaved?: boolean;
    // New configuration options for better reusability
    hideHeader?: boolean;
    hideRefreshControl?: boolean;
    style?: any;
    contentContainerStyle?: any;
    scrollEnabled?: boolean;
    filters?: Record<string, any>;
    reloadKey?: string | number;
    // Optional: external header for embedding screens (e.g., Profile)
    listHeaderComponent?: React.ReactElement | null;
}

const Feed = ({
    type,
    showComposeButton = false,
    onComposePress,
    userId,
    autoRefresh: _autoRefresh = false,
    refreshInterval: _refreshInterval = 30000,
    onSavePress: _onSavePress,
    showOnlySaved = false,
    hideHeader = false,
    hideRefreshControl = false,
    style,
    contentContainerStyle,
    scrollEnabled = true,
    filters,
    reloadKey,
    listHeaderComponent,
}: FeedProps) => {
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

    // Select appropriate feed slice (global vs user profile)
    const globalFeed = useFeedSelector(type);
    const userFeed = userId ? useUserFeedSelector(userId, type) : undefined;
    const feedData = userId ? userFeed : globalFeed;
    const isLoading = useScoped ? localLoading : !!feedData?.isLoading;
    const error = useScoped ? localError : feedData?.error;
    const hasMore = useScoped ? localHasMore : !!feedData?.hasMore;

    // Filter posts to show only saved ones if showOnlySaved is true
    const filteredFeedData = showOnlySaved
        ? {
            ...feedData,
            items: feedData?.items?.filter(item => {
                return item.isSaved === true;
            }) || []
        }
        : feedData;


    const {
        fetchFeed,
        fetchUserFeed,
        fetchSavedPosts,
        refreshFeed,
        loadMoreFeed,
        clearError
    } = usePostsStore();

    // Initial feed fetch
    useEffect(() => {
        const fetchInitialFeed = async () => {
            try {
                if (showOnlySaved) {
                    await fetchSavedPosts({ page: 1, limit: 50 });
                    return;
                }
                if (useScoped) {
                    setLocalLoading(true);
                    setLocalError(null);
                    const resp = await feedService.getFeed({ type, limit: 20, filters } as any);
                    let items = (resp.items || []).map((it: any) => (it?.data ? it.data : it));
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
                if (useScoped) setLocalError('Failed to load');
            } finally {
                if (useScoped) setLocalLoading(false);
            }
        };

        fetchInitialFeed();
    }, [type, userId, showOnlySaved, fetchFeed, fetchUserFeed, fetchSavedPosts, JSON.stringify(filters), useScoped, reloadKey]);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            if (showOnlySaved) {
                await fetchSavedPosts({ page: 1, limit: 50 });
            } else if (useScoped) {
                try {
                    setLocalLoading(true);
                    const resp = await feedService.getFeed({ type, limit: 20, filters } as any);
                    const items = (resp.items || []).map((it: any) => (it?.data ? it.data : it));
                    setLocalItems(items);
                    setLocalHasMore(!!resp.hasMore);
                    setLocalNextCursor(resp.nextCursor);
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
        } finally {
            setRefreshing(false);
        }
    }, [type, userId, showOnlySaved, refreshFeed, fetchUserFeed, fetchSavedPosts, JSON.stringify(filters), useScoped]);

    const handleLoadMore = useCallback(async () => {
        // Saved posts currently load as a single page; skip infinite scroll
        if (showOnlySaved) return;
        if (!hasMore || isLoading) return;

        try {
            if (useScoped) {
                if (!localHasMore || localLoading) return;
                setLocalLoading(true);
                const resp = await feedService.getFeed({ type, limit: 20, cursor: localNextCursor, filters } as any);
                let items = (resp.items || []).map((it: any) => (it?.data ? it.data : it));
                const pid = (filters || {}).postId || (filters || {}).parentPostId;
                if (pid) {
                    items = items.filter((it: any) => String(it.postId || it.parentPostId) === String(pid));
                }
                setLocalItems(prev => [...prev, ...items]);
                setLocalHasMore(!!resp.hasMore);
                setLocalNextCursor(resp.nextCursor);
                setLocalLoading(false);
            } else if (userId) {
                await fetchUserFeed(userId, { type, limit: 20, cursor: feedData?.nextCursor, filters });
            } else {
                await loadMoreFeed(type, filters);
            }
        } catch (error) {
            console.error('Error loading more feed:', error);
        }
    }, [showOnlySaved, hasMore, isLoading, type, userId, loadMoreFeed, fetchUserFeed, feedData?.nextCursor, JSON.stringify(filters), useScoped, localHasMore, localLoading, localNextCursor]);

    const renderPostItem = useCallback(({ item }: { item: any }) => (
        <PostItem post={item} />
    ), []);

    // Prioritize current user's fresh posts at the top (For You only)
    const { user: currentUser } = useOxy();
    const computeDisplayItems = useCallback(() => {
        const src = (useScoped ? localItems : (filteredFeedData?.items || [])) as any[];
        if (type !== 'for_you' || !currentUser?.id) return src;

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
        return [...mineNowSorted, ...others];
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [useScoped, localItems, filteredFeedData?.items, type, currentUser?.id]);

    const renderEmptyState = useCallback(() => {
        // Avoid double loading UI; top spinner handles initial load
        if (isLoading) return null;

        if (error) {
            return (
                <View style={styles.emptyState}>
                    <Text style={styles.errorText}>Failed to load posts</Text>
                    <TouchableOpacity
                        style={styles.retryButton}
                        onPress={() => {
                            clearError();
                            if (userId) {
                                fetchUserFeed(userId, { type, limit: 20 });
                            } else {
                                fetchFeed({ type, limit: 20 });
                            }
                        }}
                    >
                        <Text style={styles.retryButtonText}>Retry</Text>
                    </TouchableOpacity>
                </View>
            );
        }

        return (
            <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>
                    {showOnlySaved ? 'No saved posts yet' : 'No posts yet'}
                </Text>
                <Text style={styles.emptyStateSubtext}>
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
    }, [isLoading, error, type, userId, clearError, fetchFeed, fetchUserFeed, showOnlySaved]);

    const renderFooter = useCallback(() => {
        if (showOnlySaved) return null;
        if (!hasMore) return null;

        // Don't show "Loading more posts..." during initial load when the list is empty
        const hasItems = useScoped ? (localItems.length > 0) : !!(filteredFeedData?.items && filteredFeedData.items.length > 0);
        if (isLoading && !hasItems) return null;

        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color={colors.primaryColor} />
                <Text style={styles.footerText}>Loading more posts...</Text>
            </View>
        );
    }, [showOnlySaved, hasMore, isLoading, filteredFeedData?.items, useScoped, localItems.length]);

    const renderHeader = useCallback(() => {
        if (!showComposeButton || hideHeader) return null;

        return (
            <TouchableOpacity
                style={styles.composeButton}
                onPress={onComposePress}
            >
                <Text style={styles.composeButtonText}>What&apos;s happening?</Text>
            </TouchableOpacity>
        );
    }, [showComposeButton, onComposePress, hideHeader]);

    const keyExtractor = useCallback((item: any) => item.id, []);

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
                    data={computeDisplayItems()}
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
                                colors={[colors.primaryColor]}
                                tintColor={colors.primaryColor}
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
                />
            </View>
        </ErrorBoundary>
    );
};

export default Feed;

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
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
        paddingVertical: 60,
        paddingHorizontal: 20,
    },
    emptyStateText: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginTop: 16,
        textAlign: 'center',
    },
    emptyStateSubtext: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 8,
        textAlign: 'center',
        lineHeight: 20,
    },
    errorText: {
        fontSize: 16,
        color: colors.busy,
        marginBottom: 16,
        textAlign: 'center',
    },
    retryButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 20,
    },
    retryButtonText: {
        color: colors.primaryLight,
        fontSize: 14,
        fontWeight: '600',
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 20,
    },
    footerText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginLeft: 8,
    },
    composeButton: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 12,
        marginHorizontal: 16,
        marginVertical: 12,
    },
    composeButtonText: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
        textAlign: 'center',
    },
});
