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
import { HydratedPost, Reply, FeedBoost as Boost } from '@mention/shared-types';
import { useAuth } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { statisticsService } from '@/services/statisticsService';
import SEO from '@/components/SEO';

type PostDetailEntity = HydratedPost | Reply | Boost;

const PostDetailScreen: React.FC = () => {
    const { id } = useLocalSearchParams<{ id: string }>();
    const insets = useSafeAreaInsets();
    const safeBack = useSafeBack();
    const { getPostById, revalidatePostById } = usePostsStore();
    const { user, oxyServices } = useAuth();
    const theme = useTheme();
    const { t } = useTranslation();
    const { treeView, sortOrder } = useThreadPreferences();
    const { openBottomSheet, setBottomSheetContent } = React.useContext(BottomSheetContext);

    // Reactive store version — re-reads the cached post whenever the shared cache
    // mutates (background revalidation, optimistic like/boost, etc.).
    const dataVersion = usePostsStore((s) => s.dataVersion);

    // The cached post for this id, read reactively from the shared cache. Seeded
    // by the feed when the post was already visible, so the detail screen paints
    // instantly instead of issuing a cold blocking fetch on open.
    const cachedPost = useMemo<PostDetailEntity | null>(
        () => (id ? usePostsStore.getState().getPostFromDb(String(id)) : null),
        [id, dataVersion],
    );

    // `post` holds either the cached post (instant) or a network-fetched post
    // (cache miss). When the cache has the post, it is the source of truth and
    // stays in sync via `cachedPost`; on a cache miss we fall back to the fetched
    // value held in `fetchedPost`.
    const [fetchedPost, setFetchedPost] = useState<PostDetailEntity | null>(null);
    const post = cachedPost ?? fetchedPost;

    const [parentPost, setParentPost] = useState<PostDetailEntity | null>(null);
    // Only block first paint when there is no cached post to render. A cache hit
    // paints immediately and revalidates in the background (stale-while-revalidate).
    const [loading, setLoading] = useState(() => !cachedPost);
    const [error, setError] = useState<string | null>(null);
    const [repliesReloadKey, setRepliesReloadKey] = useState(0);

    // A boost (`type:'boost'`) is its OWN post with an empty body whose content is
    // the original it boosted — so `/p/<boostId>` renders as the booster's post
    // with the original embedded as a nested sub-card (the same way the feed row
    // renders a boost). A boost has no direct replies of its own; replies attach
    // to the original, so the replies thread below targets the original's id.
    const isBoost = Boolean(post?.boost?.originalPost);
    const replyTargetId = post?.boost?.originalPost?.id
        ? String(post.boost.originalPost.id)
        : String(id);

    // Memoize filters for replies feed
    const feedFilters = useMemo(() => ({
        postId: replyTargetId,
        parentPostId: replyTargetId,
        sort: SORT_TO_API[sortOrder],
    }), [replyTargetId, sortOrder]);

    const openReplyPreferences = useCallback(() => {
        setBottomSheetContent(<ReplyPreferencesSheet />);
        openBottomSheet(true);
    }, [setBottomSheetContent, openBottomSheet]);

    const handleOpenReply = useCallback(() => {
        // Replies attach to the original, never to the boost record.
        if (replyTargetId) router.push(`/compose?replyToPostId=${replyTargetId}`);
    }, [replyTargetId]);

    // Load the post. When the feed already cached it, the post is rendered
    // synchronously above (`cachedPost`) and this effect only revalidates it in
    // the background (stale-while-revalidate) — no spinner, no blocking fetch.
    // On a true cache miss it does a single blocking fetch.
    useEffect(() => {
        if (!id) {
            setError('Post ID is required');
            setLoading(false);
            return;
        }

        let cancelled = false;
        const postId = String(id);
        const hadCache = !!usePostsStore.getState().getPostFromDb(postId);

        // Track view in background (non-blocking) regardless of cache state.
        if (user) {
            statisticsService.trackPostView(postId).catch(() => {});
        }

        const loadParent = async (parentPostId: string | undefined) => {
            if (!parentPostId) return;
            const cachedParent = usePostsStore.getState().getPostFromDb(parentPostId);
            if (cachedParent) {
                if (!cancelled) setParentPost(cachedParent);
                return;
            }
            try {
                const parentResponse = await getPostById(parentPostId);
                if (!cancelled) setParentPost(parentResponse);
            } catch {
                // A missing/deleted parent is non-fatal — render the post alone.
            }
        };

        const run = async () => {
            setError(null);

            if (hadCache) {
                // Instant paint already happened from `cachedPost`. Revalidate in
                // the background so engagement/viewer state is fresh; the reactive
                // store read (`cachedPost`) picks up the refreshed post.
                const cached = usePostsStore.getState().getPostFromDb(postId);
                loadParent(cached?.parentPostId);
                revalidatePostById(postId).then((fresh) => {
                    if (!cancelled && fresh?.parentPostId) loadParent(fresh.parentPostId);
                });
                return;
            }

            // Cache miss — blocking fetch, then load the parent (if any).
            try {
                setLoading(true);
                const response = await getPostById(postId);
                if (cancelled) return;
                setFetchedPost(response);
                loadParent(response?.parentPostId);
            } catch {
                if (!cancelled) setError('Failed to load post');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        run();

        return () => {
            cancelled = true;
        };
    }, [id, getPostById, revalidatePostById, user]);

    const handleBack = () => {
        safeBack();
    };

    // Generate SEO data for the post (must be before any early returns)
    const getPostImage = useCallback(() => {
        if (!post) return undefined;
        const media = post.content.media || [];
        const firstImage = media.find((item) => item?.type === 'image');
        if (firstImage?.id && oxyServices?.getFileDownloadUrl) {
            return oxyServices.getFileDownloadUrl(firstImage.id);
        }
        return undefined;
    }, [post, oxyServices]);

    const postText = post?.content.text || '';
    const postDescription = postText.length > 200
        ? `${postText.substring(0, 197)}...`
        : postText || t('seo.post.description', { defaultValue: 'View this post on Mention' });
    const postAuthor = post ? post.user.displayName : t('common.someone');
    const postTitle = t('seo.post.title', { author: postAuthor, defaultValue: `${postAuthor} on Mention` });
    const postImage = getPostImage();

    // List header for Feed: parent post + main post + compose prompt + replies heading
    const listHeader = useMemo(() => {
        if (!post) return null;
        return (
            <View>
                {parentPost && post.parentPostId && (
                    <View className="border-b pb-3 mb-2 border-border">
                        <Text className="text-sm px-4 py-2 font-medium text-muted-foreground">Replying to</Text>
                        <PostItem
                            post={parentPost}
                            onReply={handleOpenReply}
                        />
                        <View className="w-0.5 h-3 ml-8 mt-1 bg-border" />
                    </View>
                )}

                {isBoost ? (
                    // Render the boost via the SHARED feed boost path (PostItem):
                    // booster header + "boosted" + the original as a nested sub-card.
                    // On a detail route PostItem is non-tappable for the main post,
                    // and the nested original card opens `/p/<originalId>`.
                    <PostItem
                        post={post}
                        onReply={handleOpenReply}
                    />
                ) : (
                    <PostDetailView
                        post={post}
                        onFocusReply={handleOpenReply}
                    />
                )}

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
    }, [post, parentPost, isBoost, handleOpenReply, user, t]);

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
                publishedTime={post && 'metadata' in post ? post.metadata?.createdAt : undefined}
                modifiedTime={post && 'metadata' in post ? post.metadata?.updatedAt : undefined}
            />
            <ThemedView className="flex-1" style={{ paddingTop: insets.top }}>
                <Header
                    options={{
                        title: (post && 'metadata' in post && post.metadata?.isThread) ? 'Thread' : 'Post',
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
                        threadPostId={replyTargetId}
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
