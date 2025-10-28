import React, { useEffect, useState, useRef } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    Alert,
    TouchableOpacity,
    KeyboardAvoidingView,
    Platform,
    TextInput,
    Image
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '../../styles/colors';
import PostItem from '../../components/Feed/PostItem';
import Feed from '../../components/Feed/Feed';
import { usePostsStore } from '../../stores/postsStore';
import { FeedType } from '@mention/shared-types';
import { UIPost, Reply, FeedRepost as Repost } from '@mention/shared-types';
import { useOxy } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
//

const MAX_CHARACTERS = 280;

const PostDetailScreen: React.FC = () => {
    const { id } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();
    const { getPostById, createReply } = usePostsStore();
    const { user } = useOxy();

    const [post, setPost] = useState<UIPost | Reply | Repost | null>(null);
    const [parentPost, setParentPost] = useState<UIPost | Reply | Repost | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const textInputRef = useRef<TextInput>(null);
    const [repliesReloadKey, setRepliesReloadKey] = useState(0);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const canReply = content.trim().length > 0 && !isOverLimit && !isSubmitting;

    // Using Feed component with filters for replies

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
                const feedTypes = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved'] as const;

                let foundPost = null;
                for (const feedType of feedTypes) {
                    const feed = (feeds as any)[feedType];
                    if (feed?.items) {
                        foundPost = feed.items.find((p: any) => p.id === id);
                        if (foundPost) break;
                    }
                }

                if (foundPost) {
                    // If the item from store lacks user data (edge cases), fetch transformed version
                    // @ts-ignore
                    if (!foundPost.user || !foundPost.user.handle) {
                        const response = await getPostById(id);
                        setPost(response);
                    } else {
                        setPost(foundPost as any);
                    }
                } else {
                    // Fetch from API if not in store
                    const response = await getPostById(id);
                    setPost(response);
                }

                // Fetch parent post if this is a reply
                const currentPost = foundPost || await getPostById(id);
                if (currentPost && (currentPost as any).parentPostId) {
                    try {
                        const parentResponse = await getPostById((currentPost as any).parentPostId);
                        setParentPost(parentResponse);
                    } catch (parentErr) {
                        console.error('Error fetching parent post:', parentErr);
                        // Continue without parent post
                    }
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

    const handleReply = async () => {
        if (!canReply || !id) return;
        try {
            setIsSubmitting(true);
            await createReply({
                postId: String(id),
                content: { text: content.trim() } as any,
                mentions: [],
                hashtags: [],
            });
            setContent('');
            Alert.alert('Success', 'Your reply has been posted!');
            // Trigger filtered replies list reload
            setRepliesReloadKey(k => k + 1);
        } catch {
            Alert.alert('Error', 'Failed to post reply. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    // No local replies state; Feed handles loading with filters



    if (loading) {
        return (
            <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
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
            </ThemedView>
        );
    }

    if (error || !post) {
        return (
            <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
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
            </ThemedView>
        );
    }

    return (
        <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top + 56 : 0}
            style={[styles.container, { paddingTop: insets.top }]}
        >
            <ThemedView style={styles.header}>
                <TouchableOpacity onPress={handleBack} style={styles.backButton}>
                    <Ionicons name="arrow-back" size={24} color={colors.COLOR_BLACK_LIGHT_1} />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>{post?.isThread ? 'Thread' : 'Post'}</Text>
            </ThemedView>

            <View style={{ flex: 1 }}>
                {/* Show parent post on top if this is a reply */}
                {parentPost && (post as any)?.parentPostId && (
                    <View style={styles.parentPostContainer}>
                        <Text style={styles.parentPostLabel}>Replying to</Text>
                        <PostItem
                            post={parentPost}
                            onReply={() => {
                                try { textInputRef.current?.focus(); } catch { /* ignore focus errors */ }
                            }}
                        />
                        <View style={styles.replyConnector} />
                    </View>
                )}

                <View style={styles.postContainer}>
                    <PostItem
                        post={post}
                        onReply={() => {
                            try { textInputRef.current?.focus(); } catch { /* ignore focus errors */ }
                        }}
                    />
                </View>
                <View style={styles.repliesSection}>
                    <Text style={styles.repliesTitle}>Replies</Text>
                    <Feed
                        type={'replies' as any}
                        hideHeader={true}
                        style={styles.repliesFeed}
                        contentContainerStyle={{ paddingBottom: 16 }}
                        filters={{ postId: String(id), parentPostId: String(id) }}
                        reloadKey={repliesReloadKey}
                        recycleItems={true}
                        maintainVisibleContentPosition={true}
                    />
                </View>
            </View>

            {/* Inline Reply Composer */}
            <ThemedView style={[styles.composerContainer, { paddingBottom: Math.max(insets.bottom, 8) }]}
            >
                <View style={styles.composer}>
                    <View style={styles.composerAvatarWrap}>
                        <Image
                            source={{ uri: (user as any)?.avatar || 'https://via.placeholder.com/40' }}
                            style={styles.composerAvatar}
                        />
                    </View>
                    <TextInput
                        ref={textInputRef}
                        style={styles.composerInput}
                        placeholder="Post your reply"
                        placeholderTextColor={colors.COLOR_BLACK_LIGHT_4}
                        value={content}
                        onChangeText={setContent}
                        multiline
                        maxLength={MAX_CHARACTERS}
                    />
                    <TouchableOpacity
                        onPress={handleReply}
                        disabled={!canReply}
                        style={[styles.composerButton, !canReply && styles.composerButtonDisabled]}
                    >
                        <Text style={styles.composerButtonText}>{isSubmitting ? '...' : 'Reply'}</Text>
                    </TouchableOpacity>
                </View>
                <View style={styles.composerMeta}>
                    <Text
                        style={[styles.characterCountText, isOverLimit && styles.characterCountWarning]}
                    >
                        {characterCount}/{MAX_CHARACTERS}
                    </Text>
                </View>
            </ThemedView>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
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
    list: {
        flex: 1,
    },
    postContainer: {
        paddingBottom: 8,
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
    },
    repliesTitle: {
        fontSize: 18,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginBottom: 12,
        paddingHorizontal: 16,
        paddingTop: 16,
    },
    repliesFeed: {
        flex: 1,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 16,
    },
    footerText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginLeft: 8,
    },
    composerContainer: {
        // Keep composer in normal layout so KeyboardAvoidingView can adjust it
        borderTopWidth: 1,
        borderTopColor: colors.COLOR_BLACK_LIGHT_6,
        paddingHorizontal: 12,
        paddingTop: 8,
    },
    composer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: 8,
    },
    composerAvatarWrap: {
        paddingBottom: 6,
    },
    composerAvatar: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    composerInput: {
        flex: 1,
        minHeight: 40,
        maxHeight: 120,
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 16,
        color: colors.COLOR_BLACK_LIGHT_1,
    },
    composerButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 16,
        alignSelf: 'center',
        marginLeft: 4,
    },
    composerButtonDisabled: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_5,
    },
    composerButtonText: {
        color: colors.primaryLight,
        fontWeight: '600',
    },
    composerMeta: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        paddingHorizontal: 8,
        paddingTop: 4,
        paddingBottom: 4,
    },
    characterCountText: {
        fontSize: 12,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    characterCountWarning: {
        color: '#E0245E',
        fontWeight: '600',
    },
    parentPostContainer: {
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        paddingBottom: 12,
        marginBottom: 8,
    },
    parentPostLabel: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        paddingHorizontal: 16,
        paddingVertical: 8,
        fontWeight: '500',
    },
    replyConnector: {
        width: 2,
        height: 12,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        marginLeft: 32,
        marginTop: 4,
    },
});

export default PostDetailScreen;
