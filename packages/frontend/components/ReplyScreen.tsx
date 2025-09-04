import { Ionicons } from '@expo/vector-icons';
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
    ScrollView,
    Image
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOxy } from '@oxyhq/services';
import { usePostsStore } from '../stores/postsStore';
import { colors } from '../styles/colors';

const MAX_CHARACTERS = 280;

const ReplyScreen: React.FC = () => {
    const { user } = useOxy();
    const { createReply, posts } = usePostsStore();
    const insets = useSafeAreaInsets();
    const { postId } = useLocalSearchParams<{ postId: string }>();

    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [originalPost, setOriginalPost] = useState<any>(null);
    const textInputRef = useRef<TextInput>(null);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const canReply = content.trim().length > 0 && !isOverLimit && !isSubmitting;

    useEffect(() => {
        // Find the original post from the store
        if (postId && posts) {
            const post = posts.find(p => p.id === postId);
            if (post) {
                setOriginalPost(post);
            }
        }
    }, [postId, posts]);

    const handleReply = async () => {
        if (!canReply || !user || !originalPost) return;

        setIsSubmitting(true);

        try {
            // Create reply request
            const replyRequest = {
                postId: postId!,
                content: {
                    text: content.trim(),
                },
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

    if (!originalPost) {
        return (
            <View style={[styles.container, { paddingTop: insets.top }]}>
                <Text>Loading...</Text>
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
            <View style={styles.originalPost}>
                <Image
                    source={{ uri: originalPost.user?.avatar || 'https://via.placeholder.com/40' }}
                    style={styles.originalPostAvatar}
                />
                <View style={styles.originalPostContent}>
                    <View style={styles.originalPostHeader}>
                        <Text style={styles.originalPostName}>{originalPost.user?.name}</Text>
                        <Text style={styles.originalPostHandle}>@{originalPost.user?.handle}</Text>
                    </View>
                    <Text style={styles.originalPostText}>{originalPost.content}</Text>
                </View>
            </View>

            {/* Reply Input */}
            <KeyboardAvoidingView
                style={styles.replyArea}
                behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
                <View style={styles.userInfo}>
                    <View style={styles.avatarContainer}>
                        <Image
                            source={{ uri: user?.avatar || 'https://via.placeholder.com/40' }}
                            style={styles.avatar}
                        />
                        {user?.verified && (
                            <View style={styles.verifiedBadge}>
                                <Ionicons name="checkmark-circle" size={16} color="#1DA1F2" />
                            </View>
                        )}
                    </View>

                    <View style={styles.userDetails}>
                        <Text style={styles.userName}>{user?.name?.full || user?.username}</Text>
                        <Text style={styles.userHandle}>@{user?.username}</Text>
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
    originalPost: {
        flexDirection: 'row',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_7,
    },
    originalPostAvatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 12,
    },
    originalPostContent: {
        flex: 1,
    },
    originalPostHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    originalPostName: {
        fontSize: 14,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginRight: 8,
    },
    originalPostHandle: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    originalPostText: {
        fontSize: 16,
        lineHeight: 20,
        color: colors.COLOR_BLACK_LIGHT_1,
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