import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import React, { useState, useRef, useEffect } from "react";
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
} from "react-native";
import Avatar from "./Avatar";
import UserName from "./UserName";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@oxyhq/services";
import { usePostsStore } from "../stores/postsStore";
import { CreateRepostRequest } from "@mention/shared-types";
import { useTheme } from "@/hooks/useTheme";

const MAX_CHARACTERS = 280;

const RepostScreen: React.FC = () => {
    const { user, oxyServices } = useAuth();
    const { id: postId } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();
    const theme = useTheme();

    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [originalPost, setOriginalPost] = useState<any>(null);
    const textInputRef = useRef<TextInput>(null);

    const { getPostById, createRepost, feeds } = usePostsStore();

    useEffect(() => {
        const loadOriginal = async () => {
            try {
                if (!postId) return;
                // Try from store feeds first
                const types = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved'] as const;
                let found: any = null;
                for (const t of types) {
                    const feed = (feeds as any)[t];
                    if (feed?.items) {
                        found = feed.items.find((p: any) => p.id === postId);
                        if (found) break;
                    }
                }
                if (found) setOriginalPost(found);
                else {
                    const fetched = await getPostById(String(postId));
                    setOriginalPost(fetched);
                }
            } catch (e) {
                console.error('Failed to load original post for repost:', e);
            }
        };
        loadOriginal();
    }, [postId, getPostById, feeds]);

    const characterCount = content.length;
    const isOverLimit = characterCount > MAX_CHARACTERS;
    const canRepost = !isOverLimit && !isSubmitting;

    const handleRepost = async () => {
        if (!canRepost || !user || !originalPost) return;

        setIsSubmitting(true);

        try {
            // Create new repost data
            const avatarUrl = typeof (user as any).avatar === 'string'
                ? (user as any).avatar
                : ((user as any).avatar || 'https://pbs.twimg.com/profile_images/1892333191295361024/VOz-zLq9_400x400.jpg');

            // Create repost request
            const repostRequest: CreateRepostRequest = {
                originalPostId: postId!,
                content: content.trim() ? { text: content.trim() } : undefined,
                mentions: [],
                hashtags: []
            };

            // Add to backend and store using posts store
            await createRepost(repostRequest);

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
            <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
                <Text style={styles.errorText}>Post not found</Text>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            style={[styles.container, { backgroundColor: theme.colors.background }]}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            {/* Header */}
            <View style={[styles.header, { borderBottomColor: theme.colors.border }, { paddingTop: insets.top }]}>
                <TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
                    <Text style={[styles.cancelText, { color: theme.colors.primary }]}>Cancel</Text>
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
                <View style={[styles.repostHeader, { borderBottomColor: theme.colors.border }]}>
                    <Ionicons name="repeat" size={20} color={theme.colors.primary} />
                    <Text style={[styles.repostHeaderText, { color: theme.colors.primary }]}>Repost</Text>
                </View>

                {/* Original Post */}
                <View style={[styles.originalPost, { borderBottomColor: theme.colors.border }]}>
                    <View style={styles.originalPostHeader}>
                        <Avatar source={originalPost.user.avatar} size={32} style={{ marginRight: 8 }} />
                        <View style={styles.originalPostInfo}>
                            <UserName
                                name={originalPost.user.name}
                                verified={originalPost.user.verified}
                                variant="small"
                            />
                            {originalPost.user.handle ? <Text style={[styles.originalPostHandle, { color: theme.colors.textSecondary }]}>@{originalPost.user.handle}</Text> : null}
                        </View>
                    </View>
                    <Text style={[styles.originalPostContent, { color: theme.colors.text }]}>{originalPost.content}</Text>
                </View>

                {/* Repost Input */}
                <View style={styles.repostSection}>
                    <View style={styles.userInfo}>
                        <Avatar
                            source={user?.avatar}
                            size={48}
                            style={{ marginRight: 12 }}
                        />
                        <View style={styles.userDetails}>
                            <Text style={[styles.userName, { color: theme.colors.text }]}>
                                {user?.name?.full || user?.username}
                            </Text>
                            <Text style={[styles.userHandle, { color: theme.colors.textSecondary }]}>@{user?.username}</Text>
                        </View>
                    </View>

                    <TextInput
                        ref={textInputRef}
                        style={[styles.textInput, { color: theme.colors.text }]}
                        placeholder="Add a comment..."
                        placeholderTextColor={theme.colors.textTertiary}
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
                            { color: theme.colors.textSecondary },
                            isOverLimit && { color: theme.colors.error }
                        ]}>
                            {characterCount}
                        </Text>
                        <Text style={[styles.characterCountMax, { color: theme.colors.textSecondary }]}>/{MAX_CHARACTERS}</Text>
                    </View>
                </View>
            </ScrollView>
        </KeyboardAvoidingView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        // backgroundColor will be applied inline with theme
    },
    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        paddingHorizontal: 16,
        paddingBottom: 12,
        borderBottomWidth: 1,
        // borderBottomColor will be applied inline with theme
    },
    cancelButton: {
        paddingVertical: 8,
        paddingHorizontal: 12,
    },
    cancelText: {
        // color will be applied inline with theme
        fontSize: 16,
        fontWeight: "600",
    },
    headerActions: {
        flexDirection: "row",
        alignItems: "center",
    },
    repostButton: {
        // backgroundColor will be applied inline with theme
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 20,
    },
    repostButtonDisabled: {
        // backgroundColor will be applied inline with theme
        opacity: 0.5,
    },
    repostButtonText: {
        // color will be applied inline with theme
        fontSize: 16,
        fontWeight: "700",
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
        marginBottom: 16,
    },
    repostHeaderText: {
        fontSize: 16,
        fontWeight: '600',
        marginLeft: 8,
    },
    originalPost: {
        paddingVertical: 16,
        borderBottomWidth: 1,
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
        marginRight: 4,
    },
    verifiedIcon: {
        marginRight: 4,
    },
    originalPostHandle: {
        fontSize: 13,
    },
    originalPostContent: {
        fontSize: 15,
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
        marginBottom: 2,
    },
    userHandle: {
        fontSize: 14,
    },
    textInput: {
        fontSize: 20,
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
        fontWeight: '500',
    },
    characterCountOverLimit: {
    },
    characterCountMax: {
        fontSize: 14,
        marginLeft: 2,
    },
    errorText: {
        fontSize: 18,
        textAlign: 'center',
        marginTop: 100,
    },
});

export default RepostScreen; 