import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    ActivityIndicator,
    Alert,
    TouchableOpacity
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../styles/colors';
import PostItem from '../../components/Feed/PostItem';
import Feed from '../../components/Feed/Feed';
import { usePostsStore } from '../../stores/postsStore';
import { UIPost, Reply, FeedRepost as Repost } from '@mention/shared-types';

const PostDetailScreen: React.FC = () => {
    const { id } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();
    const { getPostById } = usePostsStore();

    const [post, setPost] = useState<UIPost | Reply | Repost | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const fetchPost = async () => {
            if (!id) {
                setError('Post ID is required');
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                setError(null);

                // Try to get post from feeds first
                const { feeds } = usePostsStore.getState();
                const feedTypes: ('posts' | 'mixed' | 'media' | 'replies' | 'reposts' | 'likes')[] = [
                    'posts', 'mixed', 'media', 'replies', 'reposts', 'likes'
                ];

                let foundPost = null;
                for (const feedType of feedTypes) {
                    const feed = feeds[feedType];
                    if (feed?.items) {
                        foundPost = feed.items.find(p => p.id === id);
                        if (foundPost) break;
                    }
                }

                if (foundPost) {
                    setPost(foundPost);
                } else {
                    // Fetch from API if not in store
                    const response = await getPostById(id);
                    setPost(response);
                }
            } catch (err) {
                console.error('Error fetching post:', err);
                setError('Failed to load post');
            } finally {
                setLoading(false);
            }
        };

        fetchPost();
    }, [id, getPostById]);

    const handleBack = () => {
        router.back();
    };



    if (loading) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={handleBack} style={styles.backButton}>
                        <Ionicons name="arrow-back" size={24} color={colors.COLOR_BLACK_LIGHT_1} />
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>Post</Text>
                </View>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primaryColor} />
                    <Text style={styles.loadingText}>Loading post...</Text>
                </View>
            </View>
        );
    }

    if (error || !post) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <View style={styles.header}>
                    <TouchableOpacity onPress={handleBack} style={styles.backButton}>
                        <Ionicons name="arrow-back" size={24} color={colors.COLOR_BLACK_LIGHT_1} />
                    </TouchableOpacity>
                    <Text style={styles.headerTitle}>Post</Text>
                </View>
                <View style={styles.errorContainer}>
                    <Ionicons name="alert-circle-outline" size={48} color={colors.busy} />
                    <Text style={styles.errorTitle}>Post Not Found</Text>
                    <Text style={styles.errorText}>
                        {error || 'The post you\'re looking for doesn\'t exist or has been deleted.'}
                    </Text>
                    <TouchableOpacity style={styles.retryButton} onPress={() => router.back()}>
                        <Text style={styles.retryButtonText}>Go Back</Text>
                    </TouchableOpacity>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            <View style={styles.header}>
                <TouchableOpacity onPress={handleBack} style={styles.backButton}>
                    <Ionicons name="arrow-back" size={24} color={colors.COLOR_BLACK_LIGHT_1} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Post</Text>
            </View>

            <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
                <View style={styles.postContainer}>
                    <PostItem post={post} />
                </View>

                {/* Replies section with Feed component */}
                <View style={styles.repliesSection}>
                    <Text style={styles.repliesTitle}>Replies</Text>
                    <Feed type="replies" />
                </View>
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    backButton: {
        marginRight: 16,
        padding: 4,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
    },
    scrollView: {
        flex: 1,
    },
    postContainer: {
        padding: 16,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    loadingText: {
        marginTop: 16,
        fontSize: 16,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    errorContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingHorizontal: 32,
    },
    errorTitle: {
        fontSize: 20,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginTop: 16,
        marginBottom: 8,
    },
    errorText: {
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
        borderRadius: 8,
    },
    retryButtonText: {
        color: colors.COLOR_BLACK_LIGHT_9,
        fontSize: 16,
        fontWeight: '600',
    },
    repliesSection: {
        flex: 1,
        borderTopWidth: 1,
        borderTopColor: colors.COLOR_BLACK_LIGHT_6,
    },
    repliesTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginBottom: 12,
        paddingHorizontal: 16,
        paddingTop: 16,
    },
});

export default PostDetailScreen;
