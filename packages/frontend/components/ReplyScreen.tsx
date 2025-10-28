// Ionicons removed; VerifiedIcon used via UserName/Avatar
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState, useRef, useEffect } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    Alert,
    KeyboardAvoidingView,
    Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxyhq/services';
import { usePostsStore } from '../stores/postsStore';
import { colors } from '../styles/colors';
import PostItem from './Feed/PostItem';
import { UIPost, Reply, FeedRepost as Repost, FeedType } from '@mention/shared-types';
import Avatar from './Avatar';
import UserName from './UserName';

const MAX_CHARACTERS = 280;

const ReplyScreen: React.FC = () => {
    const { user } = useOxy();
    const { createReply, feeds, getPostById } = usePostsStore();
    const insets = useSafeAreaInsets();
    const { id: postId } = useLocalSearchParams<{ id: string }>();

    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [originalPost, setOriginalPost] = useState<UIPost | Reply | Repost | null>(null);
    const [isLoadingPost, setIsLoadingPost] = useState(true);
    const textInputRef = useRef<TextInput>(null);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const canReply = content.trim().length > 0 && !isOverLimit && !isSubmitting;

    useEffect(() => {
        const findOriginalPost = async () => {
            if (!postId) {
                setIsLoadingPost(false);
                return;
            }

            setIsLoadingPost(true);

            try {
                // First try to find in the feeds
                const feedTypes = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved'] as const;

                let foundPost = null;
                for (const feedType of feedTypes) {
                    const feed = (feeds as any)[feedType];
                    if (feed?.items) {
                        foundPost = feed.items.find((p: any) => p.id === postId);
                        if (foundPost) break;
                    }
                }

                // If not found in feeds, try to fetch from API
                if (!foundPost) {
                    console.log('Post not found in feeds, fetching from API...');
                    foundPost = await getPostById(postId);
                }

                if (foundPost) {
                    setOriginalPost(foundPost);
                } else {
                    console.error('Post not found:', postId);
                }
            } catch (error) {
                console.error('Error finding original post:', error);
            } finally {
                setIsLoadingPost(false);
            }
        };

        findOriginalPost();
    }, [postId, feeds, getPostById]);

    const handleReply = async () => {
        if (!canReply || !user || !originalPost) return;

        setIsSubmitting(true);

        try {
            // Create reply request
            const replyRequest = {
                postId: postId!,
                content: {
                    text: content.trim(),
                } as any, // Cast to any to match expected PostContent type
                mentions: [],
                hashtags: []
            };

            // Add to backend and store
            await createReply(replyRequest);

            // Navigate back
            router.back();

            // Show success feedback
            Alert.alert('Success', 'Your reply has been posted!');
        } catch (error) {
            console.error('Error posting reply:', error);
            Alert.alert('Error', 'Failed to post reply. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCancel = () => {
        if (content.trim().length > 0) {
            Alert.alert(
                'Discard Reply?',
                'You have unsaved changes. Are you sure you want to discard them?',
                [
                    { text: 'Keep Editing', style: 'cancel' },
                    { text: 'Discard', style: 'destructive', onPress: () => router.back() }
                ]
            );
        } else {
            router.back();
        }
    };

    if (isLoadingPost) {
        return (
            <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center' }]}>
                <Text style={{ color: colors.COLOR_BLACK_LIGHT_1 }}>Loading post...</Text>
            </View>
        );
    }

    if (!originalPost) {
        return (
            <View style={[styles.container, { paddingTop: insets.top, justifyContent: 'center', alignItems: 'center' }]}>
                <Text style={{ color: colors.COLOR_BLACK_LIGHT_1 }}>Post not found</Text>
            </View>
        );
    }

    return (
        <View style={[styles.container, { paddingTop: insets.top }]}>
            {/* Header */}
            <View style={styles.header}>
                <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
                    <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                    onPress={handleReply}
                    disabled={!canReply}
                    style={[styles.replyButton, !canReply && styles.replyButtonDisabled]}
                >
                    <Text style={[styles.replyButtonText, !canReply && styles.replyButtonTextDisabled]}>
                        Reply
                    </Text>
                </TouchableOpacity>
            </View>

            {/* Original Post */}
            <View style={styles.originalPostContainer}>
                {originalPost && <PostItem post={originalPost} />}
            </View>

            {/* Reply Input */}
            <KeyboardAvoidingView
                style={styles.replyArea}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <View style={styles.userInfo}>
                    <Avatar source={user?.avatar} size={40} verified={!!(user as any)?.verified} />
                    <View style={styles.userDetails}>
                        <UserName name={user?.name?.full || user?.username} verified={!!(user as any)?.verified} />
                    </View>
                </View>

                <TextInput
                    ref={textInputRef}
                    style={styles.textInput}
                    placeholder="Post your reply"
                    placeholderTextColor="#657786"
                    value={content}
                    onChangeText={setContent}
                    multiline
                    autoFocus
                    maxLength={MAX_CHARACTERS}
                    textAlignVertical="top"
                />

                <View style={styles.footer}>
                    <View style={styles.characterCount}>
                        <Text style={[
                            styles.characterCountText,
                            isOverLimit && styles.characterCountWarning
                        ]}>
                            {characterCount}/{MAX_CHARACTERS}
                        </Text>
                    </View>
                </View>
            </KeyboardAvoidingView>
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
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#E1E8ED',
    },
    cancelButton: {
        padding: 8,
    },
    cancelText: {
        fontSize: 16,
        color: colors.primaryColor,
    },
    replyButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 20,
        minWidth: 60,
        alignItems: 'center',
    },
    replyButtonDisabled: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_5,
    },
    replyButtonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '600',
    },
    replyButtonTextDisabled: {
        color: '#FFFFFF',
        opacity: 0.7,
    },
    originalPostContainer: {
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    replyArea: {
        flex: 1,
        padding: 16,
    },
    userInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
    },
    avatarContainer: {
        position: 'relative',
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
    },
    verifiedBadge: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
        borderRadius: 8,
    },
    userDetails: {
        marginLeft: 12,
    },
    userName: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
    },
    userHandle: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
        marginTop: 2,
    },
    textInput: {
        flex: 1,
        fontSize: 18,
        lineHeight: 24,
        color: colors.COLOR_BLACK_LIGHT_1,
        minHeight: 120,
    },
    footer: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        marginTop: 16,
    },
    characterCount: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    characterCountText: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    characterCountWarning: {
        color: '#E0245E',
        fontWeight: '600',
    },
});

export default ReplyScreen; 
