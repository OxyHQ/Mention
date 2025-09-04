import React, { useEffect, useCallback, useState } from 'react';
import {
    View,
    Text,
    FlatList,
    RefreshControl,
    ActivityIndicator,
    StyleSheet,
    TouchableOpacity,
    Alert
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { usePostsStore, useFeedSelector, useFeedLoading, useFeedError, useFeedHasMore } from '../stores/postsStore';
import { FeedType, FeedRequest } from '@mention/shared-types';
import PostCard from './PostCard';
import { colors } from '../styles/colors';

interface FeedProps {
    type?: FeedType;
    userId?: string;
    onPostPress?: (postId: string) => void;
    onUserPress?: (userId: string) => void;
    onReplyPress?: (postId: string) => void;
    onRepostPress?: (postId: string) => void;
    onLikePress?: (postId: string) => void;
    onSharePress?: (postId: string) => void;
    onSavePress?: (postId: string) => void;
}

const Feed: React.FC<FeedProps> = ({
    type = 'mixed',
    userId,
    onPostPress,
    onUserPress,
    onReplyPress,
    onRepostPress,
    onLikePress,
    onSharePress,
    onSavePress
}) => {
    const insets = useSafeAreaInsets();
    const {
        fetchFeed,
        fetchUserFeed,
        refreshFeed,
        loadMoreFeed,
        clearError
    } = usePostsStore();

    const feedData = useFeedSelector(type);
    const isLoading = useFeedLoading(type);
    const error = useFeedError(type);
    const hasMore = useFeedHasMore(type);

    const [isRefreshing, setIsRefreshing] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);

    // Initial fetch
    useEffect(() => {
        const fetchData = async () => {
            try {
                const request: FeedRequest = {
                    type,
                    limit: 20
                };

                if (userId) {
                    await fetchUserFeed(userId, request);
                } else {
                    await fetchFeed(request);
                }
            } catch (error) {
                console.error('Error fetching initial feed:', error);
            }
        };

        fetchData();
    }, [type, userId, fetchFeed, fetchUserFeed]);

    // Handle pull to refresh
    const handleRefresh = useCallback(async () => {
        if (isRefreshing) return;

        setIsRefreshing(true);
        try {
            await refreshFeed(type);
        } catch (error) {
            console.error('Error refreshing feed:', error);
        } finally {
            setIsRefreshing(false);
        }
    }, [type, refreshFeed, isRefreshing]);

    // Handle load more (infinite scroll)
    const handleLoadMore = useCallback(async () => {
        if (isLoadingMore || !hasMore || isLoading) return;

        setIsLoadingMore(true);
        try {
            await loadMoreFeed(type);
        } catch (error) {
            console.error('Error loading more feed:', error);
        } finally {
            setIsLoadingMore(false);
        }
    }, [type, loadMoreFeed, hasMore, isLoading, isLoadingMore]);

    // Handle post actions
    const handlePostAction = useCallback((action: string, postId: string) => {
        switch (action) {
            case 'post':
                onPostPress?.(postId);
                break;
            case 'user':
                onUserPress?.(postId);
                break;
            case 'reply':
                onReplyPress?.(postId);
                break;
            case 'repost':
                onRepostPress?.(postId);
                break;
            case 'like':
                onLikePress?.(postId);
                break;
            case 'share':
                onSharePress?.(postId);
                break;
            case 'save':
                onSavePress?.(postId);
                break;
        }
    }, [onPostPress, onUserPress, onReplyPress, onRepostPress, onLikePress, onSharePress, onSavePress]);

    // Render post item
    const renderPostItem = useCallback(({ item }: { item: any }) => (
        <PostCard
            post={item}
            onPostPress={() => handlePostAction('post', item.id)}
            onUserPress={() => handlePostAction('user', item.user.handle)}
            onReplyPress={() => handlePostAction('reply', item.id)}
            onRepostPress={() => handlePostAction('repost', item.id)}
            onLikePress={() => handlePostAction('like', item.id)}
            onSharePress={() => handlePostAction('share', item.id)}
            onSavePress={() => handlePostAction('save', item.id)}
        />
    ), [handlePostAction]);

    // Render footer (loading more indicator)
    const renderFooter = useCallback(() => {
        if (!isLoadingMore) return null;

        return (
            <View style={styles.footer}>
                <ActivityIndicator size="small" color={colors.primaryColor} />
                <Text style={styles.footerText}>Loading more posts...</Text>
            </View>
        );
    }, [isLoadingMore]);

    // Render empty state
    const renderEmptyState = useCallback(() => {
        if (isLoading) return null;

        return (
            <View style={styles.emptyState}>
                <Ionicons name="chatbubble-outline" size={48} color={colors.COLOR_BLACK_LIGHT_5} />
                <Text style={styles.emptyStateTitle}>No posts yet</Text>
                <Text style={styles.emptyStateSubtitle}>
                    {type === 'mixed' ? 'Follow some users to see their posts here' :
                        type === 'posts' ? 'No posts to show' :
                            type === 'replies' ? 'No replies yet' :
                                type === 'reposts' ? 'No reposts yet' :
                                    type === 'media' ? 'No media posts yet' :
                                        type === 'likes' ? 'No liked posts yet' : 'No content to show'}
                </Text>
            </View>
        );
    }, [isLoading, type]);

    // Render error state
    const renderErrorState = useCallback(() => {
        if (!error) return null;

        return (
            <View style={styles.errorState}>
                <Ionicons name="alert-circle-outline" size={48} color={colors.busy} />
                <Text style={styles.errorStateTitle}>Something went wrong</Text>
                <Text style={styles.errorStateSubtitle}>{error}</Text>
                <TouchableOpacity
                    style={styles.retryButton}
                    onPress={() => {
                        clearError();
                        handleRefresh();
                    }}
                >
                    <Text style={styles.retryButtonText}>Try Again</Text>
                </TouchableOpacity>
            </View>
        );
    }, [error, clearError, handleRefresh]);

    // Handle retry on error
    const handleRetry = useCallback(() => {
        clearError();
        handleRefresh();
    }, [clearError, handleRefresh]);

    if (error) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                {renderErrorState()}
            </View>
        );
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <FlatList
                data={feedData?.items || []}
                renderItem={renderPostItem}
                keyExtractor={(item) => item.id}
                contentContainerStyle={styles.listContent}
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={isRefreshing}
                        onRefresh={handleRefresh}
                        tintColor={colors.primaryColor}
                        colors={[colors.primaryColor]}
                    />
                }
                onEndReached={handleLoadMore}
                onEndReachedThreshold={0.1}
                ListFooterComponent={renderFooter}
                ListEmptyComponent={renderEmptyState}
                ListHeaderComponent={
                    isLoading && !isRefreshing ? (
                        <View style={styles.headerLoader}>
                            <ActivityIndicator size="large" color={colors.primaryColor} />
                            <Text style={styles.headerLoaderText}>Loading posts...</Text>
                        </View>
                    ) : null
                }
            />
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    listContent: {
        flexGrow: 1,
    },
    headerLoader: {
        padding: 20,
        alignItems: 'center',
    },
    headerLoaderText: {
        marginTop: 8,
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    footer: {
        padding: 20,
        alignItems: 'center',
        flexDirection: 'row',
        justifyContent: 'center',
    },
    footerText: {
        marginLeft: 8,
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 40,
    },
    emptyStateTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginTop: 16,
        marginBottom: 8,
    },
    emptyStateSubtitle: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
        textAlign: 'center',
        lineHeight: 22,
    },
    errorState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 40,
    },
    errorStateTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginTop: 16,
        marginBottom: 8,
    },
    errorStateSubtitle: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
        textAlign: 'center',
        lineHeight: 22,
        marginBottom: 24,
    },
    retryButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 24,
    },
    retryButtonText: {
        color: colors.COLOR_BLACK_LIGHT_9,
        fontSize: 16,
        fontWeight: '600',
    },
});

export default Feed;
