import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState, useRef } from 'react';
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    StyleSheet,
    Alert,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
    Image
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxyhq/services';
import { usePostsStore } from '../stores/postsStore';
import { CreateReplyRequest } from '@mention/shared-types';
import { UIPost as Post } from '@mention/shared-types';

const MAX_CHARACTERS = 280;

const ReplyScreen: React.FC = () => {
    const { user } = useOxy();
    const { addReply, posts, createReplyAPI } = usePostsStore();
    const { postId } = useLocalSearchParams<{ postId: string }>();
    const insets = useSafeAreaInsets();

    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const textInputRef = useRef<TextInput>(null);

    // Find the original post
    const originalPost = posts.find(post => post.id === postId);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const canReply = content.trim().length > 0 && !isOverLimit && !isSubmitting;

    const handleReply = async () => {
        if (!canReply || !user || !originalPost) return;

        setIsSubmitting(true);

        try {
            // Create new reply data
            const avatarUrl = typeof user.avatar === 'string'
                ? user.avatar
                : user.avatar?.url || 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg';

            const newReplyData = {
                postId: postId!,
                user: {
                    name: user.name?.full || user.username,
                    handle: user.username,
                    avatar: avatarUrl,
                    verified: user.verified || false,
                },
                content: content.trim(),
                engagement: {
                    replies: 0,
                    reposts: 0,
                    likes: 0,
                },
            };

            // Create reply request
            const replyRequest: CreateReplyRequest = {
                postId: postId!,
                content: content.trim(),
                mentions: [],
                hashtags: []
            };

            // Add to backend and store
            await createReplyAPI(replyRequest);

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
                'Are you sure you want to discard this reply?',
                [
                    { text: 'Keep Editing', style: 'cancel' },
                    {
                        text: 'Discard',
                        style: 'destructive',
                        onPress: () => router.back()
                    },
                ]
            );
        } else {
            router.back();
        }
    };

    if (!originalPost) {
        return (
            <View style={styles.container}>
                <Text style={styles.errorText}>Post not found</Text>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={styles.container}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            {/* Header */}
            <View style={[styles.header, { paddingTop: insets.top }]}>
                <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
                    <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>

                <View style={styles.headerActions}>
                    <TouchableOpacity
                        style={[styles.replyButton, !canReply && styles.replyButtonDisabled]}
                        onPress={handleReply}
                        disabled={!canReply}
                    >
                        <Text style={[styles.replyButtonText, !canReply && styles.replyButtonTextDisabled]}>
                            {isSubmitting ? 'Replying...' : 'Reply'}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>

            <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                {/* Original Post */}
                <View style={styles.originalPost}>
                    <View style={styles.originalPostHeader}>
                        <Image source={{ uri: originalPost.user.avatar }} style={styles.originalPostAvatar} />
                        <View style={styles.originalPostInfo}>
                            <Text style={styles.originalPostName}>
                                {originalPost.user.name}
                                {originalPost.user.verified && (
                                    <Ionicons name="checkmark-circle" size={14} color="#1DA1F2" style={styles.verifiedIcon} />
                                )}
                            </Text>
                            <Text style={styles.originalPostHandle}>@{originalPost.user.handle}</Text>
                        </View>
                    </View>
                    <Text style={styles.originalPostContent}>{originalPost.content}</Text>
                </View>

                {/* Reply Input */}
                <View style={styles.replySection}>
                    <View style={styles.userInfo}>
                        <Image
                            source={{
                                uri: typeof user?.avatar === 'string'
                                    ? user.avatar
                                    : user?.avatar?.url || 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg'
                            }}
                            style={styles.userAvatar}
                        />
                        <View style={styles.userDetails}>
                            <Text style={styles.userName}>
                                {user?.name?.full || user?.username}
                            </Text>
                            <Text style={styles.userHandle}>@{user?.username}</Text>
                        </View>
                    </View>

                    <TextInput
                        ref={textInputRef}
                        style={styles.textInput}
                        placeholder="Post your reply"
                        placeholderTextColor="#71767B"
                        value={content}
                        onChangeText={setContent}
                        multiline
                        autoFocus
                        maxLength={MAX_CHARACTERS + 50}
                        textAlignVertical="top"
                    />

                    {/* Character Count */}
                    <View style={styles.characterCount}>
                        <Text style={[
                            styles.characterCountText,
                            isOverLimit && styles.characterCountOverLimit
                        ]}>
                            {characterCount}
                        </Text>
                        <Text style={styles.characterCountMax}>/{MAX_CHARACTERS}</Text>
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
    },
    cancelButton: {
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    cancelText: {
        color: '#1D9BF0',
        fontSize: 16,
        fontWeight: '600',
    },
    headerActions: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    replyButton: {
        backgroundColor: '#1D9BF0',
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 20,
    },
    replyButtonDisabled: {
        backgroundColor: '#1D9BF0',
        opacity: 0.5,
    },
    replyButtonText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: '700',
    },
    replyButtonTextDisabled: {
        opacity: 0.7,
    },
    content: {
        flex: 1,
        paddingHorizontal: 16,
    },
    originalPost: {
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
        marginBottom: 16,
    },
    originalPostHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 8,
    },
    originalPostAvatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
        marginRight: 8,
    },
    originalPostInfo: {
        flex: 1,
    },
    originalPostName: {
        fontSize: 14,
        fontWeight: '700',
        color: '#FFF',
        marginRight: 4,
    },
    verifiedIcon: {
        marginRight: 4,
    },
    originalPostHandle: {
        fontSize: 13,
        color: '#71767B',
    },
    originalPostContent: {
        fontSize: 15,
        color: '#FFF',
        lineHeight: 20,
    },
    replySection: {
        flex: 1,
    },
    userInfo: {
        flexDirection: 'row',
        marginBottom: 12,
    },
    userAvatar: {
        width: 48,
        height: 48,
        borderRadius: 24,
        marginRight: 12,
    },
    userDetails: {
        justifyContent: 'center',
    },
    userName: {
        fontSize: 16,
        fontWeight: '700',
        color: '#FFF',
        marginBottom: 2,
    },
    userHandle: {
        fontSize: 14,
        color: '#71767B',
    },
    textInput: {
        fontSize: 20,
        color: '#FFF',
        lineHeight: 28,
        minHeight: 120,
        textAlignVertical: 'top',
    },
    characterCount: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        marginTop: 16,
        marginBottom: 20,
    },
    characterCountText: {
        fontSize: 14,
        color: '#71767B',
        fontWeight: '500',
    },
    characterCountOverLimit: {
        color: '#F4212E',
    },
    characterCountMax: {
        fontSize: 14,
        color: '#71767B',
        marginLeft: 2,
    },
    errorText: {
        color: '#FFF',
        fontSize: 18,
        textAlign: 'center',
        marginTop: 100,
    },
});

export default ReplyScreen; 