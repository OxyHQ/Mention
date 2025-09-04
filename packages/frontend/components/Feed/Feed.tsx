import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    FlatList,
    RefreshControl,
    ActivityIndicator
} from 'react-native';
import { usePostsStore, useFeedSelector, useFeedLoading, useFeedError, useFeedHasMore } from '../../stores/postsStore';
import { FeedType } from '@mention/shared-types';
import PostItem from './PostItem';
import ErrorBoundary from '../ErrorBoundary';
import LoadingTopSpinner from '../LoadingTopSpinner';

interface FeedProps {
    type: FeedType;
    showComposeButton?: boolean;
    onComposePress?: () => void;
    userId?: string;
    autoRefresh?: boolean;
    refreshInterval?: number;
    onSavePress?: (postId: string) => void;
    showOnlySaved?: boolean;
}

const Feed = ({
    type,
    showComposeButton = false,
    onComposePress,
    userId,
    autoRefresh = false,
    refreshInterval = 30000,
    onSavePress,
    showOnlySaved = false
}: FeedProps) => {
    const flatListRef = useRef<FlatList>(null);
    const [refreshing, setRefreshing] = useState(false);

    const feedData = useFeedSelector(type);
    const isLoading = useFeedLoading(type);
    const error = useFeedError(type);
    const hasMore = useFeedHasMore(type);

    // Filter posts to show only saved ones if showOnlySaved is true
    const filteredFeedData = showOnlySaved
        ? {
            ...feedData,
            items: feedData?.items?.filter(item => {
                console.log('Filtering post:', item.id, 'isSaved:', item.isSaved, 'item:', item);
                return item.isSaved;
            }) || []
        }
        : feedData;

    console.log('Feed filtering:', {
        showOnlySaved,
        totalPosts: feedData?.items?.length || 0,
        filteredPosts: filteredFeedData?.items?.length || 0,
        savedPosts: feedData?.items?.filter(item => item.isSaved)?.length || 0
    });

    const {
        fetchFeed,
        fetchUserFeed,
        refreshFeed,
        loadMoreFeed,
        clearError
    } = usePostsStore();

    // Initial feed fetch
    useEffect(() => {
        const fetchInitialFeed = async () => {
            try {
                if (userId) {
                    await fetchUserFeed(userId, { type, limit: 20 });
                } else {
                    await fetchFeed({ type, limit: 20 });
                }
            } catch (error) {
                console.error('Error fetching initial feed:', error);
            }
        };

        fetchInitialFeed();
    }, [type, userId, fetchFeed, fetchUserFeed]);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            if (userId) {
                await fetchUserFeed(userId, { type, limit: 20 });
            } else {
                await refreshFeed(type);
            }
        } catch (error) {
            console.error('Error refreshing feed:', error);
        } finally {
            setRefreshing(false);
        }
    }, [type, userId, refreshFeed, fetchUserFeed]);

    const handleLoadMore = useCallback(async () => {
        if (!hasMore || isLoading) return;

        try {
            if (userId) {
                await fetchUserFeed(userId, { type, limit: 20 });
            } else {
                await loadMoreFeed(type);
            }
        } catch (error) {
            console.error('Error loading more feed:', error);
        }
    }, [hasMore, isLoading, type, userId, loadMoreFeed, fetchUserFeed]);

    const renderPostItem = useCallback(({ item }: { item: any }) => (
        <PostItem post={item} />
    ), []);

    const renderEmptyState = useCallback(() => {
        if (isLoading) {
            return (
                <View style={styles.emptyState}>
                    <ActivityIndicator size="large" color="#1DA1F2" />
                    <Text style={styles.emptyStateText}>Loading posts...</Text>
                </View>
            );
        }

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
    }, [isLoading, error, type, userId, clearError, fetchFeed, fetchUserFeed, filteredFeedData?.items, showOnlySaved]);

    const renderFooter = useCallback(() => {
        if (!hasMore) return null;

        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color="#1DA1F2" />
                <Text style={styles.footerText}>Loading more posts...</Text>
            </View>
        );
    }, [hasMore]);

    const renderHeader = useCallback(() => {
        if (!showComposeButton) return null;

        return (
            <TouchableOpacity
                style={styles.composeButton}
                onPress={onComposePress}
            >
                <Text style={styles.composeButtonText}>What&apos;s happening?</Text>
            </TouchableOpacity>
        );
    }, [showComposeButton, onComposePress]);

    const keyExtractor = useCallback((item: any) => item.id, []);

    const getItemLayout = useCallback((data: any, index: number) => ({
        length: 200,
        offset: 200 * index,
        index,
    }), []);

    return (
        <ErrorBoundary>
            <View style={styles.container}>
                {isLoading && !refreshing && <LoadingTopSpinner />}
                <FlatList
                    ref={flatListRef}
                    data={filteredFeedData?.items || []}
                    renderItem={renderPostItem}
                    keyExtractor={keyExtractor}
                    getItemLayout={getItemLayout}
                    ListHeaderComponent={renderHeader}
                    ListEmptyComponent={renderEmptyState}
                    ListFooterComponent={renderFooter}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            colors={['#1DA1F2']}
                            tintColor="#1DA1F2"
                        />
                    }
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={0.1}
                    showsVerticalScrollIndicator={false}
                    contentContainerStyle={styles.listContent}
                    style={styles.list}
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
        backgroundColor: '#ffffff',
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
        color: '#14171A',
        marginTop: 16,
        textAlign: 'center',
    },
    emptyStateSubtext: {
        fontSize: 14,
        color: '#657786',
        marginTop: 8,
        textAlign: 'center',
        lineHeight: 20,
    },
    errorText: {
        fontSize: 16,
        color: '#E0245E',
        marginBottom: 16,
        textAlign: 'center',
    },
    retryButton: {
        backgroundColor: '#1DA1F2',
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 20,
    },
    retryButtonText: {
        color: '#ffffff',
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
        color: '#657786',
        marginLeft: 8,
    },
    composeButton: {
        backgroundColor: '#f7f9fa',
        borderWidth: 1,
        borderColor: '#e1e8ed',
        borderRadius: 20,
        paddingHorizontal: 16,
        paddingVertical: 12,
        marginHorizontal: 16,
        marginVertical: 12,
    },
    composeButtonText: {
        fontSize: 16,
        color: '#657786',
        textAlign: 'center',
    },
});