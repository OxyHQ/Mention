import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    FlatList,
    RefreshControl,
    ActivityIndicator,
    Alert,
    Platform
} from 'react-native';
import { useRouter } from 'expo-router';
import { Share } from 'react-native';
import { usePostsStore, useFeedSelector, useFeedLoading, useFeedError, useFeedHasMore } from '../../stores/postsStore';
import { FeedType, PostAction } from '@mention/shared-types';
import PostItem from './PostItem';
import ErrorBoundary from '../ErrorBoundary';
import LoadingTopSpinner from '../LoadingTopSpinner';
import { useOxy } from '@oxyhq/services';

interface FeedProps {
    type: FeedType;
    onPostAction?: (action: PostAction, postId: string) => void;
    showComposeButton?: boolean;
    onComposePress?: () => void;
    userId?: string; // For user profile feeds
    autoRefresh?: boolean; // Enable auto-refresh
    refreshInterval?: number; // Auto-refresh interval in ms
    onSavePress?: (postId: string) => void;
}

const Feed: React.FC<FeedProps> = ({
    type,
    onPostAction,
    showComposeButton = false,
    onComposePress,
    userId,
    autoRefresh = false,
    refreshInterval = 30000, // 30 seconds default
    onSavePress
}) => {
    const router = useRouter();
    const { user, isAuthenticated } = useOxy();
    const flatListRef = useRef<FlatList>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [_autoRefreshTimer, setAutoRefreshTimer] = useState<NodeJS.Timeout | null>(null);

    // Get feed data from store
    const feedData = useFeedSelector(type);
    const isLoading = useFeedLoading(type);
    const error = useFeedError(type);
    const hasMore = useFeedHasMore(type);

    const {
        fetchFeed,
        fetchUserFeed,
        refreshFeed,
        loadMoreFeed,
        clearError,
        likePost,
        unlikePost
    } = usePostsStore();

    // Auto-refresh effect
    useEffect(() => {
        if (autoRefresh && refreshInterval > 0) {
            const timer = setInterval(() => {
                if (userId) {
                    fetchUserFeed(userId, { type, limit: 20 });
                } else {
                    refreshFeed(type);
                }
            }, refreshInterval);

            setAutoRefreshTimer(timer);

            return () => {
                if (timer) clearInterval(timer);
            };
        }
    }, [autoRefresh, refreshInterval, type, userId, fetchUserFeed, refreshFeed]);

    // Initial feed fetch
    useEffect(() => {
        const fetchInitialFeed = async () => {
            console.log('🔄 Feed useEffect triggered - isAuthenticated:', isAuthenticated, 'user:', user?.id);

            if (!isAuthenticated) {
                console.log('⏳ User not authenticated, skipping feed fetch');
                return;
            }

            try {
                if (userId) {
                    console.log('👤 Fetching user feed for userId:', userId);
                    await fetchUserFeed(userId, { type, limit: 20 });
                } else {
                    console.log('📰 Fetching main feed for type:', type);
                    await fetchFeed({ type, limit: 20 });
                }
            } catch (error) {
                console.error('❌ Error fetching initial feed:', error);
            }
        };

        fetchInitialFeed();
    }, [type, userId, fetchFeed, fetchUserFeed, isAuthenticated, user?.id]);

    // Handle pull-to-refresh
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
    }, [type, userId, fetchUserFeed, refreshFeed]);

    // Handle infinite scroll
    const handleLoadMore = useCallback(async () => {
        if (!hasMore || isLoading) return;

        try {
            if (userId) {
                // For user feeds, we need to implement loadMore for user feeds
                // For now, just fetch more with current cursor
                await fetchUserFeed(userId, { type, limit: 20 });
            } else {
                await loadMoreFeed(type);
            }
        } catch (error) {
            console.error('Error loading more feed:', error);
        }
    }, [hasMore, isLoading, type, userId, loadMoreFeed, fetchUserFeed]);

    // Handle share
    const handleShare = useCallback(async (postId: string) => {
        try {
            const post = feedData?.items.find(item => item.id === postId);
            if (!post) return;

            const shareUrl = `https://mention.earth/post/${postId}`;
            const shareMessage = post.content
                ? `${post.user.name} (@${post.user.handle}): ${post.content}`
                : `${post.user.name} (@${post.user.handle})`;

            if (Platform.OS === 'web') {
                // Web sharing
                if (navigator.share) {
                    await navigator.share({
                        title: `${post.user.name} on Mention`,
                        text: shareMessage,
                        url: shareUrl
                    });
                } else {
                    // Fallback to copying to clipboard
                    await navigator.clipboard.writeText(`${shareMessage}\n\n${shareUrl}`);
                    Alert.alert('Link copied', 'Post link has been copied to clipboard');
                }
            } else {
                // Native sharing
                await Share.share({
                    message: `${shareMessage}\n\n${shareUrl}`,
                    url: shareUrl,
                    title: `${post.user.name} on Mention`
                });
            }
        } catch (error) {
            console.error('Error sharing post:', error);
            Alert.alert('Error', 'Failed to share post');
        }
    }, [feedData]);

    // Handle post actions
    const handlePostAction = useCallback(async (action: PostAction, postId: string) => {
        try {
            switch (action) {
                case 'like':
                    await likePost({ postId, type: 'post' });
                    break;
                case 'reply':
                    router.push(`/reply?postId=${postId}`);
                    break;
                case 'repost':
                    router.push(`/repost?postId=${postId}`);
                    break;
                case 'share':
                    await handleShare(postId);
                    break;
            }

            onPostAction?.(action, postId);
        } catch (error) {
            console.error(`Error handling ${action} action:`, error);
            Alert.alert('Error', `Failed to ${action} post`);
        }
    }, [likePost, router, onPostAction, handleShare]);



    // Render post item
    const renderPostItem = useCallback(({ item }: { item: any }) => {
        const handleLike = async () => {
            if (item.isLiked) {
                await unlikePost({ postId: item.id, type: 'post' });
            } else {
                await likePost({ postId: item.id, type: 'post' });
            }
        };

        return (
            <PostItem
                post={item}
                onReply={() => handlePostAction('reply', item.id)}
                onRepost={() => handlePostAction('repost', item.id)}
                onLike={handleLike}
                onShare={() => handlePostAction('share', item.id)}
                onSave={() => onSavePress?.(item.id)}
            />
        );
    }, [handlePostAction, likePost, unlikePost, onSavePress]);

    // Render empty state
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
                <Text style={styles.emptyStateText}>No posts yet</Text>
                <Text style={styles.emptyStateSubtext}>
                    {type === 'posts' ? 'Be the first to share something!' :
                        type === 'media' ? 'No media posts found' :
                            type === 'replies' ? 'No replies yet' :
                                type === 'reposts' ? 'No reposts yet' :
                                    'Start following people to see their posts'}
                </Text>
            </View>
        );
    }, [isLoading, error, type, userId, clearError, fetchFeed, fetchUserFeed]);

    // Render footer (loading indicator for infinite scroll)
    const renderFooter = useCallback(() => {
        if (!hasMore) return null;

        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color="#1DA1F2" />
                <Text style={styles.footerText}>Loading more posts...</Text>
            </View>
        );
    }, [hasMore]);

    // Render header (compose button if enabled)
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

    // Key extractor for FlatList
    const keyExtractor = useCallback((item: any) => item.id, []);

    // Get item layout for better performance
    const getItemLayout = useCallback((data: any, index: number) => ({
        length: 200, // Approximate height of post items
        offset: 200 * index,
        index,
    }), []);

    return (
        <ErrorBoundary>
            <View style={styles.container}>
                {/* Loading spinner at top */}
                {isLoading && !refreshing && <LoadingTopSpinner />}

                {/* Feed content */}
                < FlatList
                    ref={flatListRef}
                    data={feedData?.items || []}
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

export default Feed; 