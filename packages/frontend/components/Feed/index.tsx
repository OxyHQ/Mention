import React, { useEffect, useCallback, useMemo, useRef, Suspense } from 'react';
import { FlatList, ListRenderItemInfo, RefreshControl, StyleSheet, Text, View, ActivityIndicator, Platform } from 'react-native';
import CreatePost from '../Post/CreatePost';
import { usePostsStore, FeedType } from '@/store/postsStore';
import { useTranslation } from 'react-i18next';
import { colors } from '@/styles/colors';
import LoadingSkeleton from './LoadingSkeleton';
import { useOxy } from '@oxyhq/services/full';

// Lazy load the Post component for better initial bundle size
const Post = React.lazy(() => import('../Post'));

interface CustomFeedOptions {
    users?: string[];
    hashtags?: string[];
    keywords?: string[];
    mediaOnly?: boolean;
}

interface FeedProps {
    type?: FeedType;
    parentId?: string;
    showCreatePost?: boolean;
    onCreatePostPress?: () => void;
    customOptions?: CustomFeedOptions;
}

// Performance constants
const MAX_ITEMS_TO_RENDER = 100; // Increased limit for better UX
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes

// Optimized Post Item with lazy loading
const PostItem = React.memo<{
    post: any;
}>(({ post }) => {
    return (
        <View style={styles.postItemContainer}>
            <Suspense fallback={
                <View style={styles.postLoadingFallback}>
                    <ActivityIndicator size="small" color={colors.primaryColor} />
                </View>
            }>
                <Post postData={post} />
            </Suspense>
        </View>
    );
});

PostItem.displayName = 'PostItem';

// Optimized Separator component
const ItemSeparator = React.memo(() => (
    <View style={styles.separator} />
));
ItemSeparator.displayName = 'ItemSeparator';

// Enhanced Footer component
const ListFooter = React.memo<{
    loading: boolean;
    hasMore: boolean;
    error?: string | null;
    onRetry?: () => void;
}>(({ loading, hasMore, error, onRetry }) => {
    if (error) {
        return (
            <View style={styles.footerErrorContainer}>
                <Text style={styles.footerErrorText}>Failed to load more posts</Text>
                <Text style={styles.footerRetryText} onPress={onRetry}>Tap to retry</Text>
            </View>
        );
    }

    if (loading && hasMore) {
        return (
            <View style={styles.footerLoaderContainer}>
                <ActivityIndicator color={colors.primaryColor} size="small" />
                <Text style={styles.footerLoadingText}>Loading more posts...</Text>
            </View>
        );
    }

    if (!hasMore && !loading) {
        return (
            <View style={styles.footerEndContainer}>
                <Text style={styles.footerEndText}>You're all caught up! 🎉</Text>
            </View>
        );
    }

    return null;
});

ListFooter.displayName = 'ListFooter';

// Main optimized Feed Component
const Feed: React.FC<FeedProps> = React.memo(({
    type = 'all',
    parentId,
    showCreatePost = false,
    onCreatePostPress,
    customOptions
}) => {
    const { isAuthenticated, oxyServices, session } = useOxy();
    const { t } = useTranslation();
    const {
        posts,
        feeds,
        fetchFeed,
        clearFeed,
        setFeedRefreshing,
    } = usePostsStore();

    // Refs for performance tracking
    const flatListRef = useRef<FlatList>(null);

    // Calculate feed key
    const feedKey = useMemo(() => {
        if (type === 'custom' && customOptions) {
            return `custom_${JSON.stringify(customOptions)}`;
        }
        return parentId ? `${type}_${parentId}` : type;
    }, [type, parentId, customOptions]);

    const feedType = useMemo(() => {
        return type === 'home' && !isAuthenticated ? 'all' : type;
    }, [type, isAuthenticated]);

    // Zustand feed data
    const feedData = feeds[feedKey] || {
        postIds: [],
        nextCursor: null,
        hasMore: true,
        isLoading: false,
        isRefreshing: false,
        error: null,
        lastFetch: 0,
    };
    const { postIds, isLoading, isRefreshing, error, hasMore, nextCursor } = feedData;
    const feedPosts = postIds.map((id) => posts[id]).filter(Boolean);

    // Limit rendered posts for better performance
    const visiblePosts = useMemo(() => {
        return feedPosts.slice(0, MAX_ITEMS_TO_RENDER);
    }, [feedPosts]);

    // Optimized callbacks
    const fetchInitialFeed = useCallback(() => {
        clearFeed(feedKey);
        fetchFeed({
            type: feedType,
            parentId,
            customOptions,
            oxyServices,
            activeSessionId: session?.id,
        });
    }, [clearFeed, fetchFeed, feedKey, feedType, parentId, customOptions, oxyServices, session]);

    const handleRefresh = useCallback(() => {
        setFeedRefreshing(feedKey, true);
        fetchFeed({
            type: feedType,
            parentId,
            customOptions,
            oxyServices,
            activeSessionId: session?.id,
        });
    }, [setFeedRefreshing, fetchFeed, feedKey, feedType, parentId, customOptions, oxyServices, session]);

    const handleLoadMore = useCallback(() => {
        if (!isLoading && hasMore && nextCursor) {
            fetchFeed({
                type: feedType,
                parentId,
                customOptions,
                cursor: nextCursor,
                oxyServices,
                activeSessionId: session?.id,
            });
        }
    }, [fetchFeed, feedType, parentId, customOptions, nextCursor, isLoading, hasMore, oxyServices, session]);

    const handleCreatePostPress = useCallback(() => {
        if (onCreatePostPress) {
            onCreatePostPress();
        }
    }, [onCreatePostPress]);

    // Optimized render item
    const renderItem = useCallback(({ item }: ListRenderItemInfo<any>) => {
        return (
            <PostItem
                post={item}
            />
        );
    }, []);

    // Better key extractor with fallback
    const keyExtractor = useCallback((item: any, index: number) => {
        return item.id || `post-${index}`;
    }, []);

    // Optimized getItemLayout for better virtualization
    const getItemLayout = useCallback((_: any, index: number) => {
        const ESTIMATED_ITEM_HEIGHT = 200;
        const SEPARATOR_HEIGHT = 6;
        const itemHeight = ESTIMATED_ITEM_HEIGHT + SEPARATOR_HEIGHT;

        return {
            length: itemHeight,
            offset: itemHeight * index,
            index,
        };
    }, []);

    // Memoized refresh control
    const refreshControl = useMemo(() => (
        <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            colors={[colors.primaryColor]}
            tintColor={colors.primaryColor}
            progressBackgroundColor={colors.COLOR_BLACK_LIGHT_8}
        />
    ), [isRefreshing, handleRefresh]);

    // Optimized content container style
    const contentContainerStyle = useMemo(() => [
        styles.container,
        visiblePosts.length === 0 && styles.emptyListContainer
    ], [visiblePosts.length]);

    // Memoized header component
    const ListHeaderComponent = useMemo(() => {
        if (isAuthenticated && showCreatePost) {
            return (
                <CreatePost
                    onPress={handleCreatePostPress}
                    placeholder={t("What's happening?")}
                />
            );
        }
        return null;
    }, [isAuthenticated, showCreatePost, handleCreatePostPress, t]);

    // Enhanced empty component
    const ListEmptyComponent = useMemo(() => {
        if (!isLoading && visiblePosts.length === 0) {
            return (
                <View style={styles.emptyContainer}>
                    <Text style={styles.emptyTitle}>
                        {type === 'following' ? '👥' : '📝'}
                    </Text>
                    <Text style={styles.emptyText}>
                        {type === 'following'
                            ? t('No posts from people you follow yet')
                            : t('No posts available')}
                    </Text>
                    <Text style={styles.emptySubtext}>
                        {t('Pull down to refresh or check back later')}
                    </Text>
                </View>
            );
        }
        return null;
    }, [isLoading, visiblePosts.length, type, t]);

    // Enhanced footer component
    const FooterComponent = useMemo(() => (
        <ListFooter
            loading={isLoading}
            hasMore={hasMore}
            error={error}
            onRetry={fetchInitialFeed}
        />
    ), [isLoading, hasMore, error, fetchInitialFeed]);

    // Smart initial data fetching with cache awareness
    useEffect(() => {
        const now = Date.now();
        const shouldFetch = visiblePosts.length === 0 ||
            (feedData.lastFetch && now - feedData.lastFetch > CACHE_DURATION) ||
            !feedData.lastFetch;

        if (shouldFetch) {
            fetchInitialFeed();
        }
    }, [feedKey, fetchInitialFeed, visiblePosts.length, feedData.lastFetch]);

    // Render error state
    if (error && visiblePosts.length === 0) {
        const isAuthError = error.toLowerCase().includes('authorization') || error.toLowerCase().includes('auth');

        if (isAuthError && !isAuthenticated && type === 'home') {
            return (
                <View style={styles.errorContainer}>
                    <Text style={styles.errorIcon}>🔐</Text>
                    <Text style={styles.errorTitle}>{t('Authentication Required')}</Text>
                    <Text style={styles.errorText}>{t('Sign in to view your personalized feed.')}</Text>
                </View>
            );
        }

        return (
            <View style={styles.errorContainer}>
                <Text style={styles.errorIcon}>⚠️</Text>
                <Text style={styles.errorTitle}>{t('Something went wrong')}</Text>
                <Text style={styles.errorText}>{error}</Text>
                <Text style={styles.retryText} onPress={fetchInitialFeed}>{t('Tap to retry')}</Text>
            </View>
        );
    }

    // Render initial loading state
    if (isLoading && visiblePosts.length === 0 && !isRefreshing) {
        return (
            <View style={styles.loadingContainer}>
                <LoadingSkeleton count={3} />
            </View>
        );
    }

    return (
        <View style={styles.feedContainer}>
            <FlatList
                ref={flatListRef}
                data={visiblePosts}
                keyExtractor={keyExtractor}
                renderItem={renderItem}
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.3}
                refreshControl={refreshControl}
                contentContainerStyle={contentContainerStyle}
                ListHeaderComponent={ListHeaderComponent}
                ListEmptyComponent={ListEmptyComponent}
                ListFooterComponent={FooterComponent}
                ItemSeparatorComponent={ItemSeparator}
                showsVerticalScrollIndicator={false}
                // Advanced virtualization settings
                removeClippedSubviews={true}
                maxToRenderPerBatch={10}
                windowSize={21}
                initialNumToRender={8}
                getItemLayout={getItemLayout}
                updateCellsBatchingPeriod={50}
                disableVirtualization={false}
                // Performance optimizations
                keyboardShouldPersistTaps="handled"
                legacyImplementation={false}
            />
        </View>
    );
});

Feed.displayName = 'Feed';

const styles = StyleSheet.create({
    feedContainer: {
        flex: 1,
        width: '100%',
    },
    container: {
        paddingBottom: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        minHeight: '100%',
        width: '100%',
        flex: 1,
        paddingHorizontal: 0,
    },

    errorContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
    },
    errorIcon: {
        fontSize: 48,
        marginBottom: 16,
    },
    errorTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: colors.primaryDark,
        marginBottom: 8,
        textAlign: 'center',
    },
    errorText: {
        fontSize: 16,
        marginBottom: 10,
        textAlign: 'center',
        color: colors.COLOR_BLACK_LIGHT_3,
        lineHeight: 22,
    },
    retryText: {
        color: colors.primaryColor,
        fontSize: 16,
        fontWeight: '600',
        marginTop: 8,
    },
    emptyContainer: {
        padding: 32,
        alignItems: 'center',
        backgroundColor: 'white',
        marginVertical: 16,
        marginHorizontal: 0,
    },
    emptyTitle: {
        fontSize: 48,
        marginBottom: 16,
    },
    emptyText: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.primaryDark,
        textAlign: 'center',
        marginBottom: 8,
    },
    emptySubtext: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
        textAlign: 'center',
    },
    loadingContainer: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        padding: 16
    },
    separator: {
        height: 0,
    },
    footerLoaderContainer: {
        padding: 20,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
    },
    footerLoadingText: {
        marginLeft: 8,
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    footerErrorContainer: {
        padding: 20,
        alignItems: 'center',
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
        marginVertical: 16,
        marginHorizontal: 0,
    },
    footerErrorText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
        marginBottom: 8,
    },
    footerRetryText: {
        fontSize: 14,
        color: colors.primaryColor,
        fontWeight: '600',
    },
    footerEndContainer: {
        padding: 20,
        alignItems: 'center',
    },
    footerEndText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_3,
        fontStyle: 'italic',
    },
    postItemContainer: {
        backgroundColor: 'white',
        overflow: 'hidden',
        minHeight: 100,
        width: '100%',
        flex: 1,
    },

    postLoadingFallback: {
        height: 100,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyListContainer: {
        paddingVertical: 16
    }
});

export default Feed;
