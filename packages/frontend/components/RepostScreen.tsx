import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";
import { useSafeBack } from "@/hooks/useSafeBack";
import React, { useState, useRef, useEffect } from "react";
import {
    View,
    Text,
    TextInput,
    TouchableOpacity,
    KeyboardAvoidingView,
    Platform,
    ScrollView,
} from "react-native";
import { toast } from 'sonner';
import * as Prompt from '@/components/Prompt';
import { Avatar } from '@oxyhq/bloom/avatar';
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
    const safeBack = useSafeBack();

    const [content, setContent] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const discardControl = Prompt.usePromptControl();
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
            safeBack();

            // Show success feedback
            toast.success('Post reposted successfully!');
        } catch (error) {
            console.error('Error reposting:', error);
            toast.error('Failed to repost. Please try again.');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleCancel = () => {
        if (content.trim().length > 0) {
            discardControl.open();
        } else {
            safeBack();
        }
    };

    if (!originalPost) {
        return (
            <View className="flex-1 bg-background">
                <Text className="text-lg text-center" style={{ marginTop: 100 }}>Post not found</Text>
            </View>
        );
    }

    return (
        <KeyboardAvoidingView
            className="flex-1 bg-background"
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
            {/* Header */}
            <View
                className="flex-row justify-between items-center px-4 border-b border-border"
                style={{ paddingBottom: 12, paddingTop: insets.top }}
            >
                <TouchableOpacity onPress={handleCancel} className="py-2 px-3">
                    <Text className="text-primary text-base font-semibold">Cancel</Text>
                </TouchableOpacity>

                <View className="flex-row items-center">
                    <TouchableOpacity
                        className="rounded-full px-5 py-2"
                        style={[!canRepost && { opacity: 0.5 }]}
                        onPress={handleRepost}
                        disabled={!canRepost}
                    >
                        <Text className="text-base font-bold" style={[!canRepost && { opacity: 0.7 }]}>
                            {isSubmitting ? 'Reposting...' : 'Repost'}
                        </Text>
                    </TouchableOpacity>
                </View>
            </View>

            <ScrollView className="flex-1 px-4" showsVerticalScrollIndicator={false}>
                {/* Repost Header */}
                <View className="flex-row items-center py-3 border-b border-border mb-4">
                    <Ionicons name="repeat" size={20} color={theme.colors.primary} />
                    <Text className="text-primary text-base font-semibold ml-2">Repost</Text>
                </View>

                {/* Original Post */}
                <View className="py-4 border-b border-border mb-4">
                    <View className="flex-row items-center mb-2">
                        <Avatar source={originalPost.user.avatar} size={32} style={{ marginRight: 8 }} />
                        <View className="flex-1">
                            <UserName
                                name={originalPost.user.name}
                                verified={originalPost.user.verified}
                                variant="small"
                            />
                            {originalPost.user.handle ? (
                                <Text className="text-muted-foreground text-[13px]">@{originalPost.user.handle}</Text>
                            ) : null}
                        </View>
                    </View>
                    <Text className="text-foreground text-[15px]" style={{ lineHeight: 20 }}>{originalPost.content}</Text>
                </View>

                {/* Repost Input */}
                <View className="flex-1">
                    <View className="flex-row mb-3">
                        <Avatar
                            source={user?.avatar}
                            size={48}
                            style={{ marginRight: 12 }}
                        />
                        <View className="justify-center">
                            <Text className="text-foreground text-base font-bold mb-0.5">
                                {user?.name?.full || user?.username}
                            </Text>
                            <Text className="text-muted-foreground text-sm">@{user?.username}</Text>
                        </View>
                    </View>

                    <TextInput
                        ref={textInputRef}
                        className="text-foreground"
                        style={{
                            fontSize: 20,
                            lineHeight: 28,
                            minHeight: 120,
                            textAlignVertical: 'top',
                            color: theme.colors.text,
                        }}
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
                    <View className="flex-row justify-end items-center mt-4 mb-5">
                        <Text
                            className="text-muted-foreground text-sm font-medium"
                            style={isOverLimit ? { color: theme.colors.error } : undefined}
                        >
                            {characterCount}
                        </Text>
                        <Text className="text-muted-foreground text-sm ml-0.5">/{MAX_CHARACTERS}</Text>
                    </View>
                </View>
            </ScrollView>

            <Prompt.Basic
                control={discardControl}
                title="Discard Repost?"
                description="Are you sure you want to discard this repost?"
                confirmButtonCta="Discard"
                confirmButtonColor="negative"
                cancelButtonCta="Keep Editing"
                onConfirm={() => safeBack()}
            />
        </KeyboardAvoidingView>
    );
};

export default RepostScreen;
