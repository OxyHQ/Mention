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
import { CreateRepostRequest } from '@mention/shared-types';

const MAX_CHARACTERS = 280;

const RepostScreen: React.FC = () => {
    const { user } = useOxy();
    const { addRepost, posts, createRepostAPI } = usePostsStore();
    const { id: postId } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();

    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const textInputRef = useRef<TextInput>(null);

    // Find the original post
    const originalPost = posts.find(post => post.id === postId);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const canRepost = !isOverLimit && !isSubmitting;

    const handleRepost = async () => {
        if (!canRepost || !user || !originalPost) return;

        setIsSubmitting(true);

        try {
            // Create new repost data
            const avatarUrl = typeof user.avatar === 'string'
                ? user.avatar
                : user.avatar?.url || 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg';

            const newRepostData = {
                originalPostId: postId!,
                user: {
                    name: user.name?.full || user.username,
                    handle: user.username,
                    avatar: avatarUrl,
                    verified: user.verified || false,
                },
                engagement: {
                    replies: 0,
                    reposts: 0,
                    likes: 0,
                },
            };

            // Create repost request
            const repostRequest: CreateRepostRequest = {
                originalPostId: postId!,
                comment: content.trim() || undefined,
                mentions: [],
                hashtags: []
            };

            // Add to backend and store
            await createRepostAPI(repostRequest);

            // Navigate back
            router.back();

            // Show success feedback
            Alert.alert('Success', 'Post reposted successfully!');
        } catch (error) {
            console.error('Error reposting:', error);
            Alert.alert('Error', 'Failed to repost. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCancel = () => {
        if (content.trim().length > 0) {
            Alert.alert(
                'Discard Repost?',
                'Are you sure you want to discard this repost?',
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
                        style={[styles.repostButton, !canRepost && styles.repostButtonDisabled]}
                        onPress={handleRepost}
                        disabled={!canRepost}
                    >
                        <Text style={[styles.repostButtonText, !canRepost && styles.repostButtonTextDisabled]}>
                            {isSubmitting ? 'Reposting...' : 'Repost'}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>

            <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                {/* Repost Header */}
                <View style={styles.repostHeader}>
                    <Ionicons name="repeat" size={20} color="#1D9BF0" />
                    <Text style={styles.repostHeaderText}>Repost</Text>
                </View>

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

                {/* Repost Input */}
                <View style={styles.repostSection}>
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
                        placeholder="Add a comment..."
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
    repostButton: {
        backgroundColor: '#1D9BF0',
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 20,
    },
    repostButtonDisabled: {
        backgroundColor: '#1D9BF0',
        opacity: 0.5,
    },
    repostButtonText: {
        color: '#FFF',
        fontSize: 16,
        fontWeight: '700',
    },
    repostButtonTextDisabled: {
        opacity: 0.7,
    },
    content: {
        flex: 1,
        paddingHorizontal: 16,
    },
    repostHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
        marginBottom: 16,
    },
    repostHeaderText: {
        color: '#1D9BF0',
        fontSize: 16,
        fontWeight: '600',
        marginLeft: 8,
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
    repostSection: {
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

export default RepostScreen; 