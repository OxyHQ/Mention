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

// Hard cap on how far up the reply chain we walk when building the ancestor
// thread, guarding against a runaway/cyclic chain. Threads are short in practice
// (a handful of hops); this is purely a safety ceiling.
const MAX_ANCESTOR_DEPTH = 30;

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

    // The full ancestor chain above the focused post, ordered ROOT FIRST … the
    // immediate parent LAST. Rendered as one connected thread above the focused
    // post (Bluesky-style). Empty for a root post (no parent).
    const [ancestors, setAncestors] = useState<PostDetailEntity[]>([]);
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

        // Drop any ancestor chain belonging to a previously-viewed post so the new
        // focused post never momentarily renders under stale parents on navigation.
        setAncestors([]);

        // Track view in background (non-blocking) regardless of cache state.
        if (user) {
            statisticsService.trackPostView(postId).catch(() => {});
        }

        // Walk the reply chain UP from the focused post to the root, building the
        // ordered ancestor array (root first … immediate parent last). Each hop
        // reads the shared cache first and only fetches on a miss, so a fully
        // cached chain resolves in one tight pass. Resilient + bounded:
        //   - a missing/deleted ancestor just stops the chain (render what loaded);
        //   - a cycle (id already visited) breaks the walk;
        //   - the walk is capped at MAX_ANCESTOR_DEPTH hops.
        // Boosts have no `parentPostId`, so they yield an empty chain — the boost
        // renders standalone with its original embedded (replies target the
        // original via `replyTargetId`, unchanged).
        const loadAncestors = async (startParentId: string | undefined) => {
            if (!startParentId) {
                if (!cancelled) setAncestors([]);
                return;
            }
            const chain: PostDetailEntity[] = []; // bottom-up: immediate parent first
            const visited = new Set<string>([postId]);
            let nextId: string | undefined = startParentId;
            let depth = 0;

            while (nextId && depth < MAX_ANCESTOR_DEPTH) {
                if (visited.has(nextId)) break; // cycle guard
                visited.add(nextId);

                let ancestor = usePostsStore.getState().getPostFromDb(nextId) as PostDetailEntity | null;
                if (!ancestor) {
                    try {
                        ancestor = await getPostById(nextId);
                    } catch {
                        // Missing/deleted ancestor — stop and keep what we have.
                        break;
                    }
                }
                if (cancelled) return;
                if (!ancestor) break;

                chain.push(ancestor);
                nextId = ancestor.parentPostId ? String(ancestor.parentPostId) : undefined;
                depth++;
            }

            if (!cancelled) setAncestors(chain.reverse()); // root first
        };

        const run = async () => {
            setError(null);

            if (hadCache) {
                // Instant paint already happened from `cachedPost`. Revalidate in
                // the background so engagement/viewer state is fresh; the reactive
                // store read (`cachedPost`) picks up the refreshed post.
                const cached = usePostsStore.getState().getPostFromDb(postId);
                loadAncestors(cached?.parentPostId);
                revalidatePostById(postId).then((fresh) => {
                    if (!cancelled && fresh?.parentPostId) loadAncestors(fresh.parentPostId);
                });
                return;
            }

            // Cache miss — blocking fetch, then load the ancestor chain (if any).
            try {
                setLoading(true);
                const response = await getPostById(postId);
                if (cancelled) return;
                setFetchedPost(response);
                loadAncestors(response?.parentPostId);
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

    // List header for Feed: ancestor thread + focused post + compose prompt + replies heading
    const listHeader = useMemo(() => {
        if (!post) return null;
        const hasAncestors = ancestors.length > 0;
        return (
            <View>
                {/* Ancestor chain rendered top-to-bottom (root first) as ONE
                    connected thread. Each ancestor draws the thread line DOWN from
                    its avatar (`isThreadParent`) and, for every hop below the root,
                    receives the incoming line from above (`isThreadChild`), so the
                    line is continuous root → … → immediate parent. `attachedBelow`
                    drops each ancestor's bottom border/padding so they connect flush
                    with no separators between them or into the focused post. */}
                {ancestors.map((ancestor, index) => (
                    <PostItem
                        key={String(ancestor.id ?? index)}
                        post={ancestor}
                        isThreadParent
                        isThreadChild={index > 0}
                        attachedBelow
                        onReply={handleOpenReply}
                    />
                ))}

                {/* The focused post renders through the SAME PostItem as the feed,
                    gated by the `isPostDetail` variant (full-width body, larger spread
                    action bar, full timestamp + engagement-stats rows). This covers
                    BOTH a normal post and a boost (booster header + "boosted" + the
                    original as a nested, tappable sub-card → `/p/<originalId>`). The
                    focused main post is non-tappable; only its nested card navigates.
                    When there are ancestors it is the LAST node of the thread:
                    `isThreadChild` brings the line down into it (and tightens the top
                    gap to connect flush to the immediate parent), while
                    `isThreadLastChild` keeps its bottom border so it stays visually
                    separated from the compose prompt below. It is intentionally NOT a
                    thread parent — see the replies-connection note below. */}
                <PostItem
                    post={post}
                    isPostDetail
                    isThreadChild={hasAncestors}
                    isThreadLastChild={hasAncestors}
                    onReply={handleOpenReply}
                />

                <FeedHeader
                    showComposeButton={!!user}
                    onComposePress={handleOpenReply}
                    promptText={t('compose.replyPlaceholder', { defaultValue: 'Post your reply' })}
                />
            </View>
        );
    }, [post, ancestors, handleOpenReply, user, t]);

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
