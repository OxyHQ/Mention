import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    TouchableOpacity,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PostItem from '@/components/Feed/PostItem';
import PostDetailView from '@/components/Post/PostDetailView';
import Feed from '@/components/Feed/Feed';
import { FeedHeader } from '@/components/Feed/FeedHeader';
import { useThreadPreferences, SORT_TO_API } from '@/hooks/useThreadPreferences';
import { usePostsStore } from '@/stores/postsStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import ReplyPreferencesSheet from '@/components/ReplyPreferencesSheet';
import { FeedType } from '@mention/shared-types';
import { HydratedPost, Reply, FeedRepost as Repost } from '@mention/shared-types';
import { useAuth } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { statisticsService } from '@/services/statisticsService';
import SEO from '@/components/SEO';

const PostDetailScreen: React.FC = () => {
    const { id } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();
    const safeBack = useSafeBack();
    const { getPostById } = usePostsStore();
    const { user, oxyServices } = useAuth();
    const theme = useTheme();
    const { t } = useTranslation();
    const { treeView, sortOrder } = useThreadPreferences();
    const { openBottomSheet, setBottomSheetContent } = React.useContext(BottomSheetContext);

    const [post, setPost] = useState<HydratedPost | Reply | Repost | null>(null);
    const [parentPost, setParentPost] = useState<HydratedPost | Reply | Repost | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [repliesReloadKey, setRepliesReloadKey] = useState(0);

    // Memoize filters for replies feed
    const feedFilters = useMemo(() => ({
        postId: String(id),
        parentPostId: String(id),
        sort: SORT_TO_API[sortOrder],
    }), [id, sortOrder]);

    const openReplyPreferences = useCallback(() => {
        setBottomSheetContent(<ReplyPreferencesSheet />);
        openBottomSheet(true);
    }, [setBottomSheetContent, openBottomSheet]);

    const handleOpenReply = useCallback(() => {
        if (id) router.push(`/compose?replyToPostId=${id}`);
    }, [id]);

    // Load post instantly from cache, fetch from API only if not cached
    useEffect(() => {
        const loadPost = async () => {
            if (!id) {
                setError('Post ID is required');
                setLoading(false);
                return;
            }

            try {
                setError(null);

                // Check cache first for instant loading (offline support)
                const { postsById } = usePostsStore.getState();
                const cachedPost = postsById[id];

                if (cachedPost) {
                    setPost(cachedPost as any);
                    setLoading(false);

                    // Fetch parent post if this is a reply
                    if ((cachedPost as any).parentPostId) {
                        const cachedParent = postsById[(cachedPost as any).parentPostId];
                        if (cachedParent) {
                            setParentPost(cachedParent as any);
                        } else {
                            try {
                                const parentResponse = await getPostById((cachedPost as any).parentPostId);
                                setParentPost(parentResponse);
                            } catch (parentErr) {
                                // Silently ignore parent fetch errors
                            }
                        }
                    }

                    // Track view in background (non-blocking)
                    if (user) {
                        statisticsService.trackPostView(String(id)).catch(() => {});
                    }
                } else {
                    // Post not in cache - fetch from API
                    setLoading(true);
                    const response = await getPostById(id);
                    setPost(response);

                    // Fetch parent post if this is a reply
                    if (response && (response as any).parentPostId) {
                        try {
                            const parentResponse = await getPostById((response as any).parentPostId);
                            setParentPost(parentResponse);
                        } catch (parentErr) {
                            // Silently ignore parent fetch errors
                        }
                    }

                    // Track post view
                    if (user) {
                        statisticsService.trackPostView(String(id)).catch(() => {});
                    }
                }
            } catch (err) {
                setError('Failed to load post');
            } finally {
                setLoading(false);
            }
        };

        loadPost();
    }, [id, getPostById, user]);

    const handleBack = () => {
        safeBack();
    };

    // Generate SEO data for the post (must be before any early returns)
    const getPostImage = useCallback(() => {
        if (!post) return undefined;
        const media = (post as any)?.content?.media || [];
        const firstImage = media.find((m: any) => m?.type === 'image');
        if (firstImage?.id && oxyServices?.getFileDownloadUrl) {
            return oxyServices.getFileDownloadUrl(firstImage.id);
        }
        return undefined;
    }, [post, oxyServices]);

    const postText = (post as any)?.content?.text || '';
    const postDescription = postText.length > 200
        ? `${postText.substring(0, 197)}...`
        : postText || t('seo.post.description', { defaultValue: 'View this post on Mention' });
    const postAuthor = (post as any)?.user?.name || (post as any)?.user?.handle || t('common.someone');
    const postTitle = t('seo.post.title', { author: postAuthor, defaultValue: `${postAuthor} on Mention` });
    const postImage = getPostImage();

    // List header for Feed: parent post + main post + compose prompt + replies heading
    const listHeader = useMemo(() => {
        if (!post) return null;
        return (
            <View>
                {parentPost && (post as any)?.parentPostId && (
                    <View className="border-b pb-3 mb-2 border-border">
                        <Text className="text-sm px-4 py-2 font-medium text-muted-foreground">Replying to</Text>
                        <PostItem
                            post={parentPost}
                            onReply={handleOpenReply}
                        />
                        <View className="w-0.5 h-3 ml-8 mt-1 bg-border" />
                    </View>
                )}

                <PostDetailView
                    post={post}
                    onFocusReply={handleOpenReply}
                />

                <FeedHeader
                    showComposeButton={!!user}
                    onComposePress={handleOpenReply}
                    promptText={t('compose.replyPlaceholder', { defaultValue: 'Post your reply' })}
                />

                <View className="px-4 pt-4 pb-2">
                    <Text className="text-lg font-semibold text-foreground">{t('Replies')}</Text>
                </View>
            </View>
        );
    }, [post, parentPost, handleOpenReply, user, t]);

    if (!loading && (error || !post)) {
        return (
            <>
                <SEO
                    title={t('seo.post.notFound')}
                    description={t('seo.post.notFoundDescription')}
                />
                <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
                    <Header
                        options={{
                            title: t('screens.post.title'),
                            leftComponents: [
                                <IconButton variant="icon"
                                    key="back"
                                    onPress={handleBack}
                                >
                                    <BackArrowIcon size={20} className="text-foreground" />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />
                    <View className="flex-1 items-center justify-center px-8">
                        <Ionicons name="alert-circle-outline" size={48} color={theme.colors.error} />
                        <Text className="text-xl font-semibold mt-4 mb-2 text-foreground">Post Not Found</Text>
                        <Text className="text-base text-center leading-[22px] mb-6 text-muted-foreground">
                            {error || 'The post you\'re looking for doesn\'t exist or has been deleted.'}
                        </Text>
                        <TouchableOpacity className="px-6 py-3 rounded-lg bg-primary" onPress={() => safeBack()}>
                            <Text className="text-base font-semibold" style={{ color: theme.colors.card }}>Go Back</Text>
                        </TouchableOpacity>
                    </View>
                </ThemedView>
            </>
        );
    }

    return (
        <>
            <SEO
                title={postTitle}
                description={postDescription}
                image={postImage}
                type="article"
                author={postAuthor}
                publishedTime={(post as any)?.createdAt}
                modifiedTime={(post as any)?.updatedAt}
            />
            <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
                <Header
                    options={{
                        title: post?.isThread ? 'Thread' : 'Post',
                        leftComponents: [
                            <IconButton variant="icon"
                                key="back"
                                onPress={handleBack}
                            >
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                        rightComponents: [
                            <IconButton variant="icon" key="reply-prefs" onPress={openReplyPreferences}>
                                <Ionicons name="options-outline" size={22} color={theme.colors.text} />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />

                {loading && !post ? (
                    <View className="flex-1 items-center justify-center">
                        <Loading className="text-primary" size="large" />
                    </View>
                ) : (
                    <Feed
                        type={'replies' as FeedType}
                        filters={feedFilters}
                        reloadKey={repliesReloadKey}
                        listHeaderComponent={listHeader}
                        hideHeader={true}
                        threaded={treeView}
                        threadPostId={String(id)}
                        contentContainerStyle={styles.feedContent}
                    />
                )}
            </ThemedView>
        </>
    );
};

const styles = StyleSheet.create({
    feedContent: {
        paddingBottom: 16,
    },
});

export default PostDetailScreen;
