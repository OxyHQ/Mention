import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { usePostsStore } from '../stores/postsStore';
import PostCard from '../components/PostCard';
import { colors } from '../styles/colors';
import { router } from 'expo-router';

const SavedPostsScreen: React.FC = () => {
    const insets = useSafeAreaInsets();
    const { feeds, fetchFeed, refreshFeed, loading, error } = usePostsStore();
    const [refreshing, setRefreshing] = useState(false);

    // For now, we'll show all posts and filter saved ones on the frontend
    // In a real implementation, you'd want a dedicated API endpoint for saved posts
    const savedPosts = feeds.posts.items.filter(post => post.isSaved);

    const handleRefresh = useCallback(async () => {
        setRefreshing(true);
        try {
            await refreshFeed('posts');
        } catch (error) {
            console.error('Error refreshing saved posts:', error);
        } finally {
            setRefreshing(false);
        }
    }, [refreshFeed]);

    const handlePostPress = useCallback((postId: string) => {
        router.push(`/p/${postId}`);
    }, []);

    const handleUserPress = useCallback((userId: string) => {
        router.push(`/@${userId}`);
    }, []);

    const handleReplyPress = useCallback((postId: string) => {
        router.push(`/reply?postId=${postId}`);
    }, []);

    const handleRepostPress = useCallback((postId: string) => {
        router.push(`/repost?postId=${postId}`);
    }, []);

    const handleLikePress = useCallback(async (postId: string) => {
        try {
            const { likePost, unlikePost } = usePostsStore.getState();
            const post = savedPosts.find(p => p.id === postId);
            if (post?.isLiked) {
                await unlikePost({ postId });
            } else {
                await likePost({ postId });
            }
        } catch (error) {
            console.error('Error toggling like:', error);
        }
    }, [savedPosts]);

    const handleSharePress = useCallback((postId: string) => {
        // Handle share action
        console.log('Share post:', postId);
    }, []);

    const handleSavePress = useCallback(async (postId: string) => {
        try {
            const { savePost, unsavePost } = usePostsStore.getState();
            const post = savedPosts.find(p => p.id === postId);
            if (post?.isSaved) {
                await unsavePost({ postId });
            } else {
                await savePost({ postId });
            }
        } catch (error) {
            console.error('Error toggling save:', error);
        }
    }, [savedPosts]);

    const renderPostItem = useCallback(({ item }: { item: any }) => (
        <PostCard
            post={item}
            onPostPress={() => handlePostPress(item.id)}
            onUserPress={() => handleUserPress(item.user.id)}
            onReplyPress={() => handleReplyPress(item.id)}
            onRepostPress={() => handleRepostPress(item.id)}
            onLikePress={() => handleLikePress(item.id)}
            onSharePress={() => handleSharePress(item.id)}
            onSavePress={() => handleSavePress(item.id)}
        />
    ), [handlePostPress, handleUserPress, handleReplyPress, handleRepostPress, handleLikePress, handleSharePress, handleSavePress]);

    const renderEmptyState = () => (
        <View style={styles.emptyState}>
            <Text style={styles.emptyStateTitle}>No saved posts yet</Text>
            <Text style={styles.emptyStateSubtitle}>
                Posts you save will appear here. Tap the bookmark icon on any post to save it.
            </Text>
        </View>
    );

    const renderError = () => (
        <View style={styles.errorState}>
            <Text style={styles.errorText}>Failed to load saved posts</Text>
            <Text style={styles.errorSubtext}>{error}</Text>
        </View>
    );

    if (loading && savedPosts.length === 0) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <Stack.Screen
                    options={{
                        title: 'Saved Posts',
                        headerShown: true,
                    }}
                />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primaryColor} />
                    <Text style={styles.loadingText}>Loading saved posts...</Text>
                </View>
            </View>
        );
    }

    if (error && savedPosts.length === 0) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <Stack.Screen
                    options={{
                        title: 'Saved Posts',
                        headerShown: true,
                    }}
                />
                {renderError()}
            </View>
        );
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <Stack.Screen
                options={{
                    title: 'Saved Posts',
                    headerShown: true,
                }}
            />

            {savedPosts.length === 0 ? (
                renderEmptyState()
            ) : (
                <FlatList
                    data={savedPosts}
                    renderItem={renderPostItem}
                    keyExtractor={(item) => item.id}
                    contentContainerStyle={styles.listContainer}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={handleRefresh}
                            colors={[colors.primaryColor]}
                            tintColor={colors.primaryColor}
                        />
                    }
                    showsVerticalScrollIndicator={false}
                />
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    listContainer: {
        paddingBottom: 20,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    emptyStateTitle: {
        fontSize: 24,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginBottom: 8,
        textAlign: 'center',
    },
    emptyStateSubtitle: {
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
        textAlign: 'center',
        lineHeight: 24,
    },
    errorState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    errorText: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.busy,
        marginBottom: 8,
        textAlign: 'center',
    },
    errorSubtext: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        textAlign: 'center',
    },
});

export default SavedPostsScreen;
