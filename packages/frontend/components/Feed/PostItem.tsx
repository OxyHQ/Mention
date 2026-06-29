import React, { useCallback, useMemo, useContext, useState, useRef, lazy, Suspense } from 'react';
import { StyleSheet, View, Pressable, TouchableOpacity, Text, GestureResponderEvent } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import {
    HydratedPost,
    HydratedPostSummary,
    PostActorSummary,
    PostAttachmentDescriptor,
    PostAttachmentBundle,
    PostContent,
    PostEngagementSummary,
    PostRoomContent,
} from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';
import PostHeader, { HEADER_CONTENT_GAP, POST_CONTEXT_ROW_HEIGHT } from '../Post/PostHeader';
import PostContentText from '../Post/PostContentText';
import PostActions from '../Post/PostActions';
import PostLocation from '../Post/PostLocation';
import PostAttachmentsRow from '../Post/PostAttachmentsRow';
// Lazy load modals/sheets - only loaded when user opens them
const PostSourcesSheet = lazy(() => import('@/components/Post/PostSourcesSheet'));
const PostArticleModal = lazy(() => import('@/components/Post/PostArticleModal'));
const PostInsightsSheet = lazy(() => import('@/components/Post/PostInsightsSheet'));
const EngagementListSheet = lazy(() => import('@/components/Post/EngagementListSheet'));
import { useAuth } from '@oxyhq/services';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { useImagePreload } from '@/hooks/useImagePreload';
import { usePostLike } from '@/hooks/usePostLike';
import { usePostVote } from '@/hooks/usePostVote';
import { usePostSave } from '@/hooks/usePostSave';
import { usePostBoost } from '@/hooks/usePostBoost';
import { usePostShare } from '@/hooks/usePostShare';
import { usePostActions } from '@/hooks/usePostActions';
import { PinIcon } from '@/assets/icons/pin-icon';
import { BoostIcon } from '@/assets/icons/boost-icon';
import { api } from '@/utils/api';
import { THREAD_LINE_WIDTH, THREAD_LINE_BORDER_RADIUS, THREAD_LINE_Z_INDEX } from '@/components/Compose/composeLayout';
import { POST_ITEM_SPACING } from '@/styles/shared';
import { SubtleHover } from '@/components/SubtleHover';
import { useAutoTranslateStore } from '@/stores/autoTranslateStore';
import { show as toast } from '@oxyhq/bloom/toast';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { reportFeedInteraction } from '@/utils/feedTelemetry';
import { formatFullTimestamp } from '@/utils/dateUtils';

type PostEntity = HydratedPost & {
    original?: HydratedPostSummary | null;
    quoted?: HydratedPostSummary | null;
};

interface PostItemProps {
    post: PostEntity;
    isNested?: boolean;
    showPinned?: boolean;
    style?: object;
    onReply?: () => void;
    nestingDepth?: number;
    isThreadParent?: boolean;
    isThreadChild?: boolean;
    isThreadLastChild?: boolean;
    /**
     * When something is rendered flush below this post (e.g. a "Show this thread"
     * link), drop the container's bottom border + padding so the post connects to
     * it as one block. The element below then owns the single bottom separator.
     */
    attachedBelow?: boolean;
    /**
     * When this row is a reply surfaced into a feed for context (slice reason
     * `replyContext`), the parent author it replies to. Renders a muted
     * "Replying to @handle" row in the avatar-gutter lane above the header,
     * mirroring the Pinned row layout (Bluesky-style context rows, all muted).
     */
    replyContextAuthor?: { handle?: string; displayName?: string };
    /**
     * When this row is a PURE repost (boost) surfaced into a feed, the actor who
     * reposted it. The main post body is the ORIGINAL post (passed as `post`);
     * this renders a muted, tappable "Reposted by {displayName}" context row in
     * the avatar-gutter lane ABOVE the header — and above the Pinned/reply-context
     * rows (repost is the outermost reason). Because the original carries no
     * `boost`, the inline header boost glyph stays off, so this is the single
     * repost affordance (no duplicate indicator). Quote posts use `quotedPost`
     * nesting instead and never set this prop.
     */
    repostedBy?: PostActorSummary;
    /**
     * Render the FOCUSED post-detail variant: full-width body, the larger spread-out
     * action bar (with the full absolute timestamp + engagement-stats rows), and a
     * non-tappable container. Passed ONLY by the post-detail screen for the focused
     * post — NOT by the replies list (replies stay in the compact feed variant). The
     * same `PostItem` renders feed AND detail; only this flag changes.
     */
    isPostDetail?: boolean;
    /**
     * When this item is rendered inside a feed, the feed's descriptor. Opening
     * the post detail from the feed reports a `click` interaction attributed to
     * this feed. Absent for non-feed renders (post detail, nested previews).
     */
    feedDescriptor?: string;
}

const PostItem: React.FC<PostItemProps> = ({
    post,
    isNested = false,
    showPinned = false,
    style,
    onReply,
    nestingDepth = 0,
    isThreadParent = false,
    isThreadChild = false,
    isThreadLastChild = false,
    attachedBelow = false,
    replyContextAuthor,
    repostedBy,
    isPostDetail: isPostDetailProp = false,
    feedDescriptor,
}) => {
    const { user: authUser } = useAuth();
    const isPremium = (authUser as { premium?: { isPremium?: boolean } } | null)?.premium?.isPremium ?? false;
    const theme = useTheme();
    const { t, i18n } = useTranslation();
    const router = useRouter();
    const pathname = usePathname();
    const bottomSheet = useContext(BottomSheetContext);
    const { joinLiveRoom } = useLiveRoom();
    const [isArticleModalVisible, setIsArticleModalVisible] = useState(false);
    const [sensitiveRevealed, setSensitiveRevealed] = useState(false);
    const [translatedText, setTranslatedText] = useState<string | null>(null);
    const [isTranslating, setIsTranslating] = useState(false);
    const autoTranslateEnabled = useAutoTranslateStore((s) => s.enabled);
    const autoTranslateAttempted = useRef(false);
    const hasManuallyDismissed = useRef(false);

    const postId = post?.id;
    const dataVersion = usePostsStore((state) => state.dataVersion);
    const storePost = useMemo(() => {
        if (!postId) return null;
        return usePostsStore.getState().getPostFromDb(postId);
    }, [postId, dataVersion]);
    const viewPost = storePost ?? post;
    const viewPostId = viewPost?.id ? String(viewPost.id) : undefined;

    const viewerState =
        viewPost?.viewerState ?? { isOwner: false, isLiked: false, isDownvoted: false, isBoosted: false, isSaved: false };

    const metadata = viewPost?.metadata ?? {};
    const content: PostContent = viewPost?.content ?? {};
    const attachmentsBundle: PostAttachmentBundle = viewPost?.attachments ?? {};
    const linkPreview = viewPost?.linkPreview ?? null;
    const isSensitiveContent = metadata.isSensitive === true;

    const isOwner = viewerState.isOwner ?? false;
    const isLiked = viewerState.isLiked ?? false;
    const isDownvoted = viewerState.isDownvoted ?? false;
    const isBoosted = viewerState.isBoosted ?? false;
    const isSaved = viewerState.isSaved ?? false;

    const sourcesList = attachmentsBundle.sources ?? [];
    const hasSources = sourcesList.length > 0;

    const articleContent = attachmentsBundle.article ?? null;
    const hasArticle = Boolean(articleContent);

    const eventContent = attachmentsBundle.event ?? content.event ?? null;
    const hasEvent = Boolean(eventContent);

    const roomContent: PostRoomContent | null =
        attachmentsBundle.room ?? content.room ?? null;

    const podcastContent = attachmentsBundle.podcast ?? content.podcast ?? null;

    const pollData = attachmentsBundle.poll ?? content.poll ?? null;
    const pollId = content.pollId ?? null;

    const location = attachmentsBundle.location ?? content.location ?? null;
    const hasValidLocation = Boolean(location?.coordinates && location.coordinates.length >= 2);

    const mediaItems = attachmentsBundle.media ?? content.media ?? [];

    const nestedPost = useMemo(() => {
        if (!viewPost) return null;
        // `original`/`quoted` are legacy snake-case aliases for the hydrated
        // `originalPost`/`quotedPost` nested summaries (some cached responses
        // still carry them). Read both shapes via the alias view.
        const legacy = viewPost as { original?: HydratedPostSummary | null; quoted?: HydratedPostSummary | null };
        if (viewPost.boost?.originalPost) return viewPost.boost.originalPost;
        if (legacy.original) return legacy.original;
        if (viewPost.originalPost) return viewPost.originalPost;
        if (legacy.quoted) return legacy.quoted;
        if (viewPost.quotedPost) return viewPost.quotedPost;
        return null;
    }, [viewPost]);

    const shouldRenderMediaBlock =
        (Array.isArray(mediaItems) && mediaItems.length > 0) ||
        Boolean(nestedPost) ||
        Boolean(pollData) ||
        Boolean(articleContent) ||
        Boolean(eventContent) ||
        Boolean(roomContent) ||
        Boolean(podcastContent) ||
        Boolean(linkPreview) ||
        hasValidLocation;

    const attachmentDescriptors: PostAttachmentDescriptor[] | undefined = Array.isArray(content.attachments)
        ? content.attachments
        : undefined;

    // Avatar source resolution is federation-aware and delegated to Bloom's
    // Avatar (via the app-wide ImageResolver). FEDERATED/remote actors carry a
    // remote http(s) avatar URL — passed straight through; the `variant` is
    // ignored for absolute URLs. LOCAL actors carry an Oxy file id — passed as
    // `source` with `variant="thumb"` so Bloom's resolver fetches the thumb
    // rendition. We no longer pre-resolve the file id with `useImageUrl`.
    //
    // NOTE (durable upstream fix): the backend PostHydrationService should emit a
    // clean file id for local actors and a remote URL for federated actors so the
    // client never has to disambiguate. Until then we branch on `isFederated` and
    // on whether the value is already an absolute URL.
    const rawAvatar = viewPost?.user?.avatarUrl;
    const isRemoteAvatar =
        typeof rawAvatar === 'string' &&
        (viewPost?.user?.isFederated === true ||
            rawAvatar.startsWith('http://') ||
            rawAvatar.startsWith('https://'));
    const avatarSource = typeof rawAvatar === 'string' ? rawAvatar : undefined;
    const avatarVariant = isRemoteAvatar ? undefined : 'thumb';

    // Preload only when the avatar is already an absolute URL (remote/federated).
    // Local file ids are resolved+cached by Bloom's resolver, and media items are
    // referenced by id and resolved inside PostAttachmentsRow.
    const imageUrls = useMemo(
        () => (isRemoteAvatar && avatarSource ? [avatarSource] : []),
        [isRemoteAvatar, avatarSource],
    );

    useImagePreload(imageUrls, true);

    // `onDetailRoute` = rendered on a `/p/` screen (focused post OR a reply in its
    // list). `isDetailMain` = the FOCUSED post itself (detail variant). A nested
    // sub-card (embedded original inside a boost/quote) is never the focused post,
    // so it stays tappable even on a detail route; the focused main post does not.
    const onDetailRoute = (pathname || '').startsWith('/p/');
    const isDetailMain = isPostDetailProp && !isNested;
    const isTappable = isNested || !onDetailRoute;
    const goToPost = useCallback((event?: GestureResponderEvent) => {
        // A nested item is its OWN tap target: opening it must NOT also trigger the
        // outer post's press. On React Native Web the press bubbles through the DOM,
        // so stop it here. The outer boost row navigates to the boost's own detail;
        // only the inner card navigates to the embedded original.
        if (isNested) {
            event?.stopPropagation?.();
        }
        if (isTappable && viewPostId) {
            // Best-effort feed-ranking signal: opening a post from a feed is a
            // strong positive interaction. No-op when not rendered in a feed
            // (feedDescriptor undefined) or for federated previews without an id.
            if (feedDescriptor) {
                reportFeedInteraction(feedDescriptor, viewPostId, 'click');
            }
            router.push(`/p/${viewPostId}`);
        }
    }, [router, viewPostId, isTappable, feedDescriptor, isNested]);

    const goToUser = useCallback(() => {
        const handle = getNormalizedUserHandle({
            handle: viewPost.user?.handle,
            username: viewPost.user?.handle,
        });
        if (handle) {
            router.push(`/@${handle}`);
        }
    }, [router, viewPost.user?.handle]);

    // "Reposted by X" row → the BOOSTER's profile. Stop propagation so it doesn't
    // also trigger the outer container press (which opens the ORIGINAL post detail).
    const goToReposter = useCallback((event?: GestureResponderEvent) => {
        event?.stopPropagation?.();
        const handle = getNormalizedUserHandle({
            handle: repostedBy?.handle,
            username: repostedBy?.handle,
        });
        if (handle) {
            router.push(`/@${handle}`);
        }
    }, [router, repostedBy?.handle]);

    // Pass the originating feed descriptor as the engagement `source` so the
    // backend can attribute a like/save/boost to the surface it happened on
    // (e.g. a like in the Videos feed = interest in the video, not the author).
    // Undefined outside a feed (post detail / nested) → normal, unattributed write.
    const handleLike = usePostLike(viewPostId, isLiked, feedDescriptor);
    const { toggleDownvote: handleDownvote } = usePostVote(viewPostId, isLiked, isDownvoted);
    const handleSave = usePostSave(viewPostId, isSaved, feedDescriptor);
    const handleBoost = usePostBoost(viewPostId, isBoosted, feedDescriptor);
    const handleShare = usePostShare(viewPost);

    const handleReply = useCallback(() => {
        if (onReply) {
            onReply();
            return;
        }
        if (viewPostId) {
            router.push(`/compose?replyToPostId=${viewPostId}`);
        }
    }, [onReply, router, viewPostId]);

    const fetchTranslation = useCallback(async (force = false) => {
        if (!viewPostId || isTranslating) return;
        setIsTranslating(true);
        try {
            const { data } = await api.post<{ translatedText: string }>(
                `/posts/${viewPostId}/translate`,
                { targetLanguage: i18n.language, force },
            );
            if (data.translatedText) {
                setTranslatedText(data.translatedText);
            } else {
                toast(t('translation.failed'), { type: 'error' });
            }
        } catch (err: unknown) {
            const status = (err as { response?: { status?: number } })?.response?.status;
            if (status === 429) {
                toast(t('translation.rateLimited'), { type: 'error' });
            } else {
                toast(t('translation.failed'), { type: 'error' });
            }
        } finally {
            setIsTranslating(false);
        }
    }, [viewPostId, isTranslating, i18n.language, t]);

    const handleTranslate = useCallback(() => {
        if (!isPremium) {
            router.push('/subscribe');
            return;
        }
        if (translatedText) {
            hasManuallyDismissed.current = true;
            setTranslatedText(null);
            return;
        }
        // If user previously dismissed, force a fresh translation (bypass cache)
        fetchTranslation(hasManuallyDismissed.current);
    }, [isPremium, translatedText, fetchTranslation, router]);

    // Auto-translate: compute during render, fire once via ref guard
    if (
        isPremium &&
        autoTranslateEnabled &&
        content.text &&
        viewPostId &&
        !translatedText &&
        !isTranslating &&
        !autoTranslateAttempted.current
    ) {
        const postLang = (metadata.language || 'en').split('-')[0].toLowerCase();
        const userLang = (i18n.language || 'en').split('-')[0].toLowerCase();
        if (postLang !== userLang) {
            autoTranslateAttempted.current = true;
            queueMicrotask(() => fetchTranslation());
        }
    }

    const closeSourcesSheet = useCallback(() => {
        bottomSheet.setBottomSheetContent(null);
        bottomSheet.openBottomSheet(false);
    }, [bottomSheet]);

    const sourcesSheetElement = useMemo(
        () => (
            <Suspense fallback={null}>
                <PostSourcesSheet sources={sourcesList} onClose={closeSourcesSheet} />
            </Suspense>
        ),
        [sourcesList, closeSourcesSheet],
    );

    const openSourcesSheet = useCallback(() => {
        if (!hasSources) return;
        bottomSheet.setBottomSheetContent(sourcesSheetElement);
        bottomSheet.openBottomSheet(true);
    }, [hasSources, bottomSheet, sourcesSheetElement]);

    const openArticleSheet = useCallback(() => {
        if (hasArticle) {
            setIsArticleModalVisible(true);
        }
    }, [hasArticle]);

    const closeArticleSheet = useCallback(() => {
        setIsArticleModalVisible(false);
    }, []);

    const handleInsightsPress = useCallback(() => {
        bottomSheet.setBottomSheetContent(
            <Suspense fallback={null}>
                <PostInsightsSheet
                    postId={viewPostId || null}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            </Suspense>
        );
        bottomSheet.openBottomSheet(true);
    }, [bottomSheet, viewPostId]);

    // Detail-only: open the likes/boosts engagement list. No-op outside the
    // focused post-detail variant (the feed action row doesn't expose it).
    const openEngagementList = useCallback((type: 'likes' | 'boosts') => {
        if (!viewPostId) return;
        bottomSheet.setBottomSheetContent(
            <Suspense fallback={null}>
                <EngagementListSheet
                    postId={viewPostId}
                    type={type}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            </Suspense>
        );
        bottomSheet.openBottomSheet(true);
    }, [bottomSheet, viewPostId]);

    const roomId = roomContent?.roomId;
    const handleRoomPress = useCallback(() => {
        if (roomId) joinLiveRoom(roomId);
    }, [joinLiveRoom, roomId]);

    const postActions = usePostActions({
        viewPost,
        isOwner,
        isSaved,
        hasArticle,
        hasSources,
        onSave: handleSave,
        onOpenArticle: openArticleSheet,
        onOpenSources: openSourcesSheet,
    });

    const openMenu = useCallback(() => {
        const ActionRow: React.FC<{
            icon: React.ReactNode;
            text: string;
            onPress: () => void;
            color?: string;
            isFirst?: boolean;
            isLast?: boolean;
        }> = ({ icon, text, onPress, color, isFirst, isLast }) => (
            <TouchableOpacity
                className="bg-surface flex-row items-center justify-between py-3 px-3.5"
                style={{
                    borderTopLeftRadius: isFirst ? 16 : 0,
                    borderTopRightRadius: isFirst ? 16 : 0,
                    borderBottomLeftRadius: isLast ? 16 : 0,
                    borderBottomRightRadius: isLast ? 16 : 0,
                    marginBottom: !isLast ? 4 : 0,
                }}
                onPress={onPress}
                activeOpacity={0.7}
            >
                <Text className={cn("text-base font-medium", !color && "text-foreground")} style={color ? { color } : undefined}>{text}</Text>
                <View className="ml-3">{icon}</View>
            </TouchableOpacity>
        );

        const ActionGroup: React.FC<{
            actions: Array<{ icon: React.ReactNode; text: string; onPress: () => void; color?: string }>;
        }> = ({ actions }) => {
            if (actions.length === 0) return null;
            return (
                <View className="mb-1">
                    {actions.map((action, index) => (
                        <ActionRow
                            key={index}
                            icon={action.icon}
                            text={action.text}
                            onPress={action.onPress}
                            color={action.color}
                            isFirst={index === 0}
                            isLast={index === actions.length - 1}
                        />
                    ))}
                </View>
            );
        };

        bottomSheet.setBottomSheetContent(
            <View className="bg-background p-4 gap-2">
                {postActions.insightsAction.length > 0 && <ActionGroup actions={postActions.insightsAction} />}
                {postActions.saveActionGroup.length > 0 && <ActionGroup actions={postActions.saveActionGroup} />}
                {postActions.deleteAction.length > 0 && <ActionGroup actions={postActions.deleteAction} />}
                {postActions.articleAction.length > 0 && <ActionGroup actions={postActions.articleAction} />}
                {postActions.sourcesAction.length > 0 && <ActionGroup actions={postActions.sourcesAction} />}
                {postActions.addToListAction.length > 0 && <ActionGroup actions={postActions.addToListAction} />}
                {postActions.muteReportAction.length > 0 && <ActionGroup actions={postActions.muteReportAction} />}
                <ActionGroup actions={postActions.copyLinkAction} />
            </View>,
        );
        bottomSheet.openBottomSheet(true);
    }, [bottomSheet, postActions]);

    if (!viewPost || !viewPost.user) {
        return null;
    }

    const engagement: PostEngagementSummary = viewPost.engagement ?? {
        likes: 0,
        downvotes: 0,
        boosts: 0,
        replies: 0,
        saves: null,
        views: null,
        impressions: null,
    };

    // Canonical post-item layout tokens (single source of truth: COMPONENT_SPACING.post).
    // HPAD/VPAD/SECTION_GAP = 12, AVATAR_SIZE = 40, AVATAR_GAP = 12, AVATAR_OFFSET = 64.
    const { HPAD, VPAD, SECTION_GAP, AVATAR_SIZE, AVATAR_OFFSET } = POST_ITEM_SPACING;

    // The detail variant is layout-identical to the feed: the body stays indented
    // under the avatar column (AVATAR_OFFSET), aligned with the name. ONLY the
    // bottom action bar and the extra detail rows (timestamp + engagement stats)
    // differ — never the avatar/name/handle/time/content position.
    const fullTimestamp = isDetailMain ? formatFullTimestamp(metadata.createdAt ?? '') : '';

    // Keep text posts on the normal section rhythm, but let no-text posts hug
    // their first external content block using the same small gap PostHeader uses
    // between the identity row and inline body text. Subsequent external blocks
    // still use the normal section gap.
    const Container: React.ElementType = isTappable ? Pressable : View;
    const hasBelowHeaderBlocks = Boolean((hasValidLocation && location) || hasSources || shouldRenderMediaBlock || !isNested);
    const headerToBlocksGap = content.text ? SECTION_GAP : HEADER_CONTENT_GAP;

    const replyContextHandle = replyContextAuthor?.handle || replyContextAuthor?.displayName;

    const postAuthor = viewPost.user.displayName;
    const postTextSummary = content.text
        ? content.text.length > 80
            ? content.text.substring(0, 80) + '...'
            : content.text
        : '';
    const postAccessibilityLabel = postTextSummary
        ? `${postAuthor}: ${postTextSummary}`
        : `Post by ${postAuthor}`;

    // Thread line positioning: center on avatar, use shared style constants from composeLayout
    const THREAD_LINE_LEFT = HPAD + AVATAR_SIZE / 2 - 1;
    const THREAD_LINE_W = THREAD_LINE_WIDTH;

    // Bluesky-style context rows (Reposted by / Pinned / Replying to), rendered as
    // the first children of PostHeader's content column so the text aligns with the
    // display name (no more pl-[60px] — same column as the name). Each row is a
    // consistent POST_CONTEXT_ROW_HEIGHT tall; the avatar stays top-aligned (the
    // column grows down). The icon keeps `-ml-4` to poke left into the avatar
    // gutter; repost is the outermost reason, then pinned, then reply.
    const contextRows: React.ReactNode[] = [];
    if (repostedBy) {
        contextRows.push(
            <TouchableOpacity
                key="reposted"
                className="flex-row items-center"
                style={{ height: POST_CONTEXT_ROW_HEIGHT }}
                activeOpacity={0.7}
                onPress={goToReposter}
                accessibilityRole="link"
            >
                <View className="-ml-4 mr-[3px]">
                    <BoostIcon size={13} color={theme.colors.textSecondary} />
                </View>
                <Text className="text-muted-foreground text-[13px] font-semibold" numberOfLines={1}>
                    {t('post.repostedBy', { defaultValue: 'Reposted by' })} {repostedBy.displayName}
                </Text>
            </TouchableOpacity>,
        );
    }
    if (showPinned) {
        contextRows.push(
            <View key="pinned" className="flex-row items-center" style={{ height: POST_CONTEXT_ROW_HEIGHT }}>
                <View className="-ml-4 mr-[3px]">
                    <PinIcon size={13} className="text-muted-foreground" />
                </View>
                <Text className="text-muted-foreground text-[13px] font-semibold" numberOfLines={1}>
                    {t('post.pinned', { defaultValue: 'Pinned' })}
                </Text>
            </View>,
        );
    }
    if (replyContextHandle) {
        contextRows.push(
            <View key="reply" className="flex-row items-center" style={{ height: POST_CONTEXT_ROW_HEIGHT }}>
                <View className="-ml-4 mr-[3px]">
                    <Ionicons name="return-down-forward-outline" size={13} color={theme.colors.textSecondary} />
                </View>
                <Text className="text-muted-foreground text-[13px] font-semibold" numberOfLines={1}>
                    {t('post.replyingTo', { defaultValue: 'Replying to' })} @{replyContextHandle}
                </Text>
            </View>,
        );
    }

    // PostHeader offsets the avatar down by the context rows' total height to keep
    // it aligned with the name row. Mirror that exact offset here so the thread
    // line tracks the offset avatar instead of leaving a gap above it.
    const headerTopOffset = contextRows.length * (POST_CONTEXT_ROW_HEIGHT + HEADER_CONTENT_GAP);

    return (
        <>
            <Container
                className={cn(
                    "group",
                    !isNested && "bg-background border-border",
                    isNested && "border-border bg-background",
                )}
                style={[
                    !isNested && styles.postContainer,
                    !isNested && {
                        paddingTop: VPAD,
                        paddingBottom: VPAD,
                    },
                    isNested && styles.nestedPostContainer,
                    // Thread spacing adjustments
                    isThreadParent && !isNested && { paddingBottom: 0, borderBottomWidth: 0 },
                    isThreadChild && !isThreadLastChild && !isNested && { paddingBottom: 0, borderBottomWidth: 0 },
                    attachedBelow && !isNested && { paddingBottom: 0, borderBottomWidth: 0 },
                    isThreadChild && !isNested && { paddingTop: 4 },
                    style,
                ]}
                accessibilityLabel={postAccessibilityLabel}
                {...(isTappable ? { onPress: goToPost } : {})}
            >
                {isTappable && <SubtleHover />}
                {/* Thread line above avatar — connects from previous post's bottom.
                    Ends `headerTopOffset` below the top, leaving the same small gap
                    before the avatar as the below-avatar line has (tracking the
                    context-row offset that pushes the avatar down). */}
                {isThreadChild && !isNested && (
                    <View
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: THREAD_LINE_LEFT,
                            width: THREAD_LINE_W,
                            height: headerTopOffset,
                            backgroundColor: `${theme.colors.primary}30`,
                            borderRadius: THREAD_LINE_BORDER_RADIUS,
                            zIndex: THREAD_LINE_Z_INDEX,
                        }}
                    />
                )}
                {/* Thread line below avatar — connects to next post's top. Shifted
                    down by headerTopOffset so it starts at the offset avatar's bottom. */}
                {isThreadParent && !isNested && (
                    <View
                        style={{
                            position: 'absolute',
                            top: (isThreadChild ? 4 : VPAD) + AVATAR_SIZE + headerTopOffset,
                            left: THREAD_LINE_LEFT,
                            width: THREAD_LINE_W,
                            bottom: 0,
                            backgroundColor: `${theme.colors.primary}30`,
                            borderRadius: THREAD_LINE_BORDER_RADIUS,
                            zIndex: THREAD_LINE_Z_INDEX,
                        }}
                    />
                )}
                <View style={{ gap: headerToBlocksGap }}>
                    <PostHeader
                        user={{
                            displayName: viewPost.user.displayName,
                            handle: viewPost.user.handle || '',
                            verified: viewPost.user.isVerified,
                            isFederated: viewPost.user.isFederated,
                            instance: viewPost.user.instance,
                        }}
                        date={metadata.createdAt}
                        showBoost={Boolean(viewPost.boost) && !isNested}
                        showReply={false}
                        contextTop={contextRows.length > 0 ? contextRows : undefined}
                        avatarSource={avatarSource}
                        avatarVariant={avatarVariant}
                        onPressUser={goToUser}
                        onPressAvatar={goToUser}
                        onPressMenu={openMenu}
                        paddingHorizontal={isNested ? 0 : HPAD}
                    >
                        {content.text ? <PostContentText content={content} postId={viewPostId} translatedText={translatedText} linkPreviewUrl={linkPreview?.url} /> : null}
                    </PostHeader>

                    {hasBelowHeaderBlocks && (
                        <View style={{ gap: SECTION_GAP }}>
                            {hasValidLocation && location && (
                                <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD }}>
                                    <PostLocation location={location} paddingHorizontal={0} />
                                </View>
                            )}

                            {hasSources && (
                                <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD }}>
                                    <TouchableOpacity
                                        className="border-border bg-surface flex-row items-center gap-1.5 self-start rounded-xl border"
                                        style={{ paddingHorizontal: 10, paddingVertical: 4 }}
                                        onPress={openSourcesSheet}
                                        activeOpacity={0.8}
                                    >
                                        <Ionicons name="link-outline" size={14} color={theme.colors.primary} />
                                        <Text className="text-primary text-[13px] font-semibold">
                                            {t('post.sourcesChip', { defaultValue: 'Sources' })}
                                            {` (${sourcesList.length})`}
                                        </Text>
                                    </TouchableOpacity>
                                </View>
                            )}

                {shouldRenderMediaBlock && (
                    <View style={{ position: 'relative' }}>
                        {isSensitiveContent && !sensitiveRevealed && (
                            <TouchableOpacity
                                style={styles.sensitiveOverlay}
                                onPress={() => setSensitiveRevealed(true)}
                                activeOpacity={0.8}
                            >
                                <View className="items-center gap-1">
                                    <Ionicons name="eye-off" size={24} color="#fff" />
                                    <Text style={styles.sensitiveOverlayTitle}>
                                        {t('post.sensitiveContent', { defaultValue: 'Sensitive content' })}
                                    </Text>
                                    <Text style={styles.sensitiveOverlaySubtitle}>
                                        {t('post.sensitiveContentTap', { defaultValue: 'Tap to reveal' })}
                                    </Text>
                                </View>
                            </TouchableOpacity>
                        )}
                        <View style={isSensitiveContent && !sensitiveRevealed ? { opacity: 0.05 } : undefined}>
                            <PostAttachmentsRow
                                media={Array.isArray(mediaItems) ? mediaItems : []}
                                attachments={attachmentDescriptors}
                                nestedPost={nestedPost ?? null}
                                leftOffset={AVATAR_OFFSET}
                                pollData={pollData}
                                pollId={pollId ? String(pollId) : undefined}
                                nestingDepth={nestingDepth}
                                postId={viewPostId}
                                article={
                                    articleContent
                                        ? {
                                            title: articleContent.title,
                                            body: articleContent.body ?? articleContent.excerpt,
                                            articleId: articleContent.articleId,
                                        }
                                        : null
                                }
                                onArticlePress={hasArticle ? openArticleSheet : undefined}
                                event={
                                    eventContent
                                        ? {
                                            eventId: eventContent.eventId,
                                            name: eventContent.name,
                                            date: eventContent.date,
                                            location: eventContent.location,
                                            description: eventContent.description,
                                        }
                                        : null
                                }
                                room={
                                    roomContent && roomId
                                        ? {
                                            roomId,
                                            title: roomContent.title,
                                            status: roomContent.status,
                                            topic: roomContent.topic,
                                            host: roomContent.host,
                                        }
                                        : null
                                }
                                onRoomPress={roomId ? handleRoomPress : undefined}
                                podcast={podcastContent}
                                location={location}
                                sources={sourcesList}
                                onSourcesPress={hasSources ? openSourcesSheet : undefined}
                                text={content.text}
                                linkMetadata={
                                    linkPreview
                                        ? {
                                            url: linkPreview.url,
                                            title: linkPreview.title,
                                            description: linkPreview.description,
                                            image: linkPreview.image,
                                            siteName: linkPreview.siteName,
                                        }
                                        : null
                                }
                            />
                        </View>
                    </View>
                )}

                {!isNested && (
                    <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD }}>
                        <PostActions
                            engagement={{
                                replies: engagement.replies ?? 0,
                                boosts: engagement.boosts ?? 0,
                                likes: engagement.likes ?? 0,
                                downvotes: engagement.downvotes ?? 0,
                                saves: engagement.saves ?? null,
                                views: engagement.views ?? null,
                                recentReplierAvatars: engagement.recentReplierAvatars,
                            }}
                            isLiked={isLiked}
                            isDownvoted={isDownvoted}
                            isBoosted={isBoosted}
                            isSaved={isSaved}
                            onReply={handleReply}
                            onBoost={handleBoost}
                            onLike={handleLike}
                            onDownvote={handleDownvote}
                            onSave={handleSave}
                            onShare={handleShare}
                            postId={viewPostId}
                            onTranslate={!isDetailMain && content.text ? handleTranslate : undefined}
                            isTranslated={Boolean(translatedText)}
                            isTranslating={isTranslating}
                            isPremium={isPremium}
                            onInsightsPress={isOwner ? handleInsightsPress : undefined}
                            detail={isDetailMain}
                            timestampLabel={fullTimestamp}
                            hasMediaBlock={shouldRenderMediaBlock}
                            onLikesPress={isDetailMain ? () => openEngagementList('likes') : undefined}
                            onBoostsPress={isDetailMain ? () => openEngagementList('boosts') : undefined}
                        />
                    </View>
                )}
                    </View>
                )}
                </View>
            </Container>

            {articleContent ? (
                <Suspense fallback={null}>
                    <PostArticleModal
                        visible={isArticleModalVisible}
                        onClose={closeArticleSheet}
                        articleId={articleContent.articleId}
                        title={articleContent.title}
                        body={articleContent.body}
                    />
                </Suspense>
            ) : null}
        </>
    );
};

const styles = StyleSheet.create({
    postContainer: {
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    nestedPostContainer: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 16,
        padding: 12,
        // No top margin: the nested card's spacing from the outer header/content is
        // owned by the parent content column's flex `gap` (see PostItem render).
    },
    sensitiveOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 10,
        backgroundColor: 'rgba(0,0,0,0.85)',
        borderRadius: 16,
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 120,
    },
    sensitiveOverlayTitle: {
        color: '#fff',
        fontSize: 15,
        fontWeight: '600',
        marginTop: 4,
    },
    sensitiveOverlaySubtitle: {
        color: 'rgba(255,255,255,0.6)',
        fontSize: 13,
    },
});

export default React.memo(PostItem, (prevProps, nextProps) => {
    // Fast path: same post reference
    if (prevProps.post === nextProps.post) return true;

    const prev = prevProps.post;
    const next = nextProps.post;

    // Compare identity and key engagement/viewer state
    return (
        prev?.id === next?.id &&
        prev?.viewerState?.isLiked === next?.viewerState?.isLiked &&
        prev?.viewerState?.isDownvoted === next?.viewerState?.isDownvoted &&
        prev?.viewerState?.isBoosted === next?.viewerState?.isBoosted &&
        prev?.viewerState?.isSaved === next?.viewerState?.isSaved &&
        prev?.engagement?.likes === next?.engagement?.likes &&
        prev?.engagement?.downvotes === next?.engagement?.downvotes &&
        prev?.engagement?.boosts === next?.engagement?.boosts &&
        prev?.engagement?.replies === next?.engagement?.replies &&
        prev?.metadata?.updatedAt === next?.metadata?.updatedAt &&
        prevProps.isNested === nextProps.isNested &&
        prevProps.nestingDepth === nextProps.nestingDepth &&
        prevProps.isThreadParent === nextProps.isThreadParent &&
        prevProps.isThreadChild === nextProps.isThreadChild &&
        prevProps.isThreadLastChild === nextProps.isThreadLastChild &&
        prevProps.attachedBelow === nextProps.attachedBelow &&
        prevProps.isPostDetail === nextProps.isPostDetail &&
        prevProps.feedDescriptor === nextProps.feedDescriptor &&
        // Same original post id can be reposted by different actors across rows;
        // compare the booster so a recycled row never shows a stale "Reposted by".
        prevProps.repostedBy?.id === nextProps.repostedBy?.id
    );
});
