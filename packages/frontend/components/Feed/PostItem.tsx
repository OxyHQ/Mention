import React, { useCallback, useMemo, useContext, useState, lazy, Suspense } from 'react';
import { StyleSheet, View, Pressable, TouchableOpacity, Text, GestureResponderEvent } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import {
    HydratedPost,
    HydratedPostSummary,
    PostUser,
    PostAttachmentDescriptor,
    PostAttachmentBundle,
    PostContent,
    PostEngagementSummary,
    PostLinkPreview,
    PostRoomContent,
    MEDIA_VARIANT_AVATAR,
} from '@mention/shared-types';
import { usePostSelector } from '../../stores/postsStore';
import PostHeader, { HEADER_CONTENT_GAP, POST_CONTEXT_ROW_HEIGHT } from '../Post/PostHeader';
import PostContentText from '../Post/PostContentText';
import PostLanguageChip from '../Post/PostLanguageChip';
import ContentWarning from '../Post/ContentWarning';
import PostActions from '../Post/PostActions';
import PostLocation from '../Post/PostLocation';
import PostAttachmentsRow from '../Post/PostAttachmentsRow';
// Lazy load modals/sheets - only loaded when user opens them
const PostSourcesSheet = lazy(() => import('@/components/Post/PostSourcesSheet'));
const PostArticleModal = lazy(() => import('@/components/Post/PostArticleModal'));
const PostInsightsSheet = lazy(() => import('@/components/Post/PostInsightsSheet'));
const EngagementListSheet = lazy(() => import('@/components/Post/EngagementListSheet'));
const CollaboratorsSheet = lazy(() => import('@/components/Post/CollaboratorsSheet'));
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { useImagePreload } from '@oxyhq/bloom/hooks';
import { usePostLike } from '@/hooks/usePostLike';
import { usePostVote } from '@/hooks/usePostVote';
import { usePostSave } from '@/hooks/usePostSave';
import { usePostBoost } from '@/hooks/usePostBoost';
import { usePostShare } from '@/hooks/usePostShare';
import { usePostActions } from '@/hooks/usePostActions';
import { PinIcon } from '@/assets/icons/pin-icon';
import { BoostIcon } from '@/assets/icons/boost-icon';
import { usePostLanguage } from '@/hooks/usePostLanguage';
import { THREAD_LINE_WIDTH, THREAD_LINE_BORDER_RADIUS, THREAD_LINE_Z_INDEX } from '@/components/Compose/composeLayout';
import { POST_ITEM_SPACING } from '@/styles/shared';
import { SubtleHover } from '@oxyhq/bloom/subtle-hover';
import { useThreadHoverStore } from '@/stores/threadHoverStore';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { reportFeedInteraction } from '@/utils/feedTelemetry';
import { formatFullTimestamp } from '@/utils/dateUtils';
import { displayNameOrHandle } from '@/utils/displayName';

type PostEntity = HydratedPost & {
    original?: HydratedPostSummary | null;
    quoted?: HydratedPostSummary | null;
};

/** Stable identity for the "no link previews" case (see `linkPreviews` below). */
const EMPTY_LINK_PREVIEWS: PostLinkPreview[] = [];

/** Stable identity for a post whose content failed to hydrate (see `content` below). */
const EMPTY_CONTENT: PostContent = {};

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
    replyContextAuthor?: PostUser;
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
    repostedBy?: PostUser;
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
    /**
     * Thread "unit" wiring (feed rows only). All rows of one thread share the
     * same `sliceKey`; `isThread` is true when this row is part of a multi-post
     * thread, and `threadRootId` is the thread's root post id. Together they make
     * the whole thread behave as one unit: hovering any post highlights every
     * post of the thread (via the shared `threadHoverStore`), and tapping any
     * post opens the thread at its root. Absent/false for standalone posts.
     */
    sliceKey?: string;
    threadRootId?: string;
    isThread?: boolean;
    /**
     * Notified right before a tap opens the post detail. A pure observer — it does
     * NOT replace the navigation (use it to record that the row was opened, e.g.
     * the search screen committing its query to the search history).
     */
    onOpen?: () => void;
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
    sliceKey,
    threadRootId,
    isThread = false,
    onOpen,
}) => {
    const theme = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const pathname = usePathname();
    const bottomSheet = useContext(BottomSheetContext);
    const { joinLiveRoom } = useLiveRoom();
    const [isArticleModalVisible, setIsArticleModalVisible] = useState(false);

    const postId = post?.id;
    // Reactive read of the cached post (compiler-safe `useSyncExternalStore`
    // under the hood — never `useMemo` over an out-of-band SQLite read).
    const storePost = usePostSelector(postId ? String(postId) : undefined);
    const viewPost = storePost ?? post;
    const viewPostId = viewPost?.id ? String(viewPost.id) : undefined;

    const viewerState =
        viewPost?.viewerState ?? { isOwner: false, isCollaborator: false, isLiked: false, isDownvoted: false, isBoosted: false, isSaved: false };

    const metadata = viewPost?.metadata ?? {};
    const permissions = viewPost?.permissions ?? {};
    const content: PostContent = viewPost?.content ?? EMPTY_CONTENT;
    const attachmentsBundle: PostAttachmentBundle = viewPost?.attachments ?? {};
    // Module-level EMPTY fallback: a fresh `[]` each render would give the
    // memoized PostAttachmentsRow a new array identity every time and defeat its
    // React.memo (and that of the row's children).
    const linkPreviews: PostLinkPreview[] = viewPost?.linkPreviews ?? EMPTY_LINK_PREVIEWS;
    const isSensitiveContent = metadata.isSensitive === true;
    // Content warning (federated `summary` / Mastodon CW) surfaced by the backend as
    // `metadata.spoilerText`. Rendered as a visible label above the body — media blur
    // is handled separately via `isSensitiveContent`; this never gates the body text.
    const spoilerText = typeof metadata.spoilerText === 'string' ? metadata.spoilerText.trim() : '';

    const isOwner = viewerState.isOwner ?? false;
    const canViewInsights = permissions.canViewInsights ?? isOwner;
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

    // Stable identity for the media array so the memoized PostAttachmentsRow can
    // skip re-rendering on an unrelated like/save/translate. A bare `?? []` would
    // hand it a fresh array each render and defeat its React.memo. Always an array.
    const mediaItems = useMemo(() => {
        const m = attachmentsBundle.media ?? content.media;
        return Array.isArray(m) ? m : [];
    }, [attachmentsBundle.media, content.media]);

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

    // A boost whose original is genuinely gone (deleted/never-imported): the
    // backend marks `boost.unavailable` with a null `originalPost`. A boost has an
    // empty body, so we render a muted "no longer available" placeholder in the
    // embedded-original slot instead of a blank card.
    const boostUnavailable = Boolean(viewPost?.boost?.unavailable);

    const shouldRenderMediaBlock =
        mediaItems.length > 0 ||
        Boolean(nestedPost) ||
        Boolean(pollData) ||
        Boolean(articleContent) ||
        Boolean(eventContent) ||
        Boolean(roomContent) ||
        Boolean(podcastContent) ||
        linkPreviews.length > 0 ||
        hasValidLocation;

    const attachmentDescriptors: PostAttachmentDescriptor[] | undefined = Array.isArray(content.attachments)
        ? content.attachments
        : undefined;

    // Avatar source resolution is delegated to Bloom's Avatar (via the
    // app-wide ImageResolver). The backend emits the canonical Oxy `User`
    // shape: `avatar` is EITHER a bare Oxy file id OR an absolute URL — for
    // BOTH local and federated actors alike (both are mirrored into the same
    // Oxy storage, so there's no federation-based distinction to make here).
    // We always pass `variant={MEDIA_VARIANT_AVATAR}` unconditionally: Bloom's
    // Avatar ignores `variant` entirely when `source` turns out to be an
    // already-absolute URL (rendered straight through) and only applies it
    // when resolving a bare Oxy file id, so there's nothing for this
    // component to detect or branch on. We no longer pre-resolve the file id
    // with `useImageUrl`.
    const avatarSource = viewPost?.user?.avatar;
    const avatarVariant = MEDIA_VARIANT_AVATAR;

    // Preload only makes sense when the avatar is already an absolute URL —
    // a bare file id needs async resolution first, handled internally by
    // Bloom's resolver/cache. Media items are referenced by id and resolved
    // inside PostAttachmentsRow.
    const imageUrls = useMemo(
        () => (avatarSource && (avatarSource.startsWith('http://') || avatarSource.startsWith('https://')) ? [avatarSource] : []),
        [avatarSource],
    );

    useImagePreload(imageUrls, true);

    // `onDetailRoute` = rendered on a `/p/` screen (focused post OR a reply in its
    // list). `isDetailMain` = the FOCUSED post itself (detail variant). A nested
    // sub-card (embedded original inside a boost/quote) is never the focused post,
    // so it stays tappable even on a detail route; the focused main post does not.
    const onDetailRoute = (pathname || '').startsWith('/p/');
    const isDetailMain = isPostDetailProp && !isNested;
    const isTappable = isNested || !onDetailRoute;

    // A thread (multi-post slice) behaves as one unit: every row shares one
    // `sliceKey`, hovering any row highlights them all, and tapping any row opens
    // the thread at its `threadRootId`. Standalone posts have no slice wiring and
    // keep per-post hover + their own detail target.
    const isThreadUnit = Boolean(isThread && sliceKey);
    const setHoveredSlice = useThreadHoverStore((s) => s.setHoveredSlice);
    // Scoped selector: only THIS slice's active boolean — a post re-renders only
    // when its own active state flips, never on unrelated hover changes.
    const isThreadHoverActive = useThreadHoverStore(
        (s) => isThreadUnit && s.hoveredSliceKey === sliceKey,
    );

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
            onOpen?.();
            // Thread posts open the whole thread at its root; standalone posts
            // open their own detail.
            const targetPostId = isThreadUnit && threadRootId ? threadRootId : viewPostId;
            router.push(`/p/${targetPostId}`);
        }
    }, [router, viewPostId, isTappable, feedDescriptor, isNested, isThreadUnit, threadRootId, onOpen]);

    // Canonical profile handle for the author. Built from the full actor so a
    // federated actor resolves to `username@domain` (via isFederated + instance)
    // rather than a bare local-part. Display AND navigation both use this single
    // value so they can never diverge. Empty for a degraded/unresolvable author
    // (empty handle) → no `@handle` shown and no tappable link.
    const authorHandle = useMemo(
        () => getNormalizedUserHandle(viewPost.user) ?? undefined,
        [viewPost.user],
    );

    const goToUser = useCallback(() => {
        if (authorHandle) {
            router.push(`/@${authorHandle}`);
        }
    }, [router, authorHandle]);

    // Per-author profile link for the collaborative byline (owner + each
    // collaborator). Uses the same `/@handle` route as the single-author header.
    const goToAuthor = useCallback((handle: string) => {
        if (handle) {
            router.push(`/@${handle}`);
        }
    }, [router]);

    // "Reposted by X" row → the BOOSTER's profile. Stop propagation so it doesn't
    // also trigger the outer container press (which opens the ORIGINAL post detail).
    const goToReposter = useCallback((event?: GestureResponderEvent) => {
        event?.stopPropagation?.();
        const handle = getNormalizedUserHandle(repostedBy);
        if (handle) {
            router.push(`/@${handle}`);
        }
    }, [router, repostedBy]);

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

    // Reading this post in another language. The server already resolved ONE body
    // for this viewer, so everything here is the reader deliberately overruling
    // that choice: `displayText` overrides the body, and it is `null` whenever the
    // server's own resolution is what's on screen.
    const {
        options: languageOptions,
        activeTag: activeLanguageTag,
        displayText: languageDisplayText,
        isTranslating,
        isTranslated,
        selectLanguage,
        toggleReaderTranslation,
    } = usePostLanguage(content, viewPostId, metadata.language);

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

    // Owner + accepted collaborators, already hydrated on the post. A post is
    // collaborative when it carries more than one author.
    const collaborators = viewPost?.authors;
    const isCollab = (collaborators?.length ?? 0) > 1;

    // Open the collaborators list — the byline shows first names only, so this is
    // where the full @usernames live. Content is already on the post (no fetch).
    const openCollaboratorsSheet = useCallback(() => {
        if (!collaborators || collaborators.length <= 1) return;
        bottomSheet.setBottomSheetContent(
            <Suspense fallback={null}>
                <CollaboratorsSheet
                    authors={collaborators}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            </Suspense>
        );
        bottomSheet.openBottomSheet(true);
    }, [bottomSheet, collaborators]);

    const roomId = roomContent?.roomId;
    const handleRoomPress = useCallback(() => {
        if (roomId) joinLiveRoom(roomId);
    }, [joinLiveRoom, roomId]);

    const postActions = usePostActions({
        viewPost,
        isOwner,
        canViewInsights,
        canStopSharing: permissions.canStopSharing ?? false,
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
                {postActions.stopSharingAction.length > 0 && <ActionGroup actions={postActions.stopSharingAction} />}
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

    // Memoize the structured props handed to the memoized children so they keep a
    // stable identity across re-renders. The inline object/array literals these
    // replace were rebuilt every render, defeating the React.memo on
    // PostAttachmentsRow (media/video subtree) and PostActions — so a like/save/
    // translate re-rendered the whole attachment subtree unnecessarily.
    const articleProp = useMemo(
        () =>
            articleContent
                ? {
                      title: articleContent.title,
                      body: articleContent.body ?? articleContent.excerpt,
                      articleId: articleContent.articleId,
                  }
                : null,
        [articleContent],
    );

    const eventProp = useMemo(
        () =>
            eventContent
                ? {
                      eventId: eventContent.eventId,
                      name: eventContent.name,
                      date: eventContent.date,
                      location: eventContent.location,
                      description: eventContent.description,
                  }
                : null,
        [eventContent],
    );

    const roomProp = useMemo(
        () =>
            roomContent && roomId
                ? {
                      roomId,
                      title: roomContent.title,
                      status: roomContent.status,
                      topic: roomContent.topic,
                      host: roomContent.host,
                  }
                : null,
        [roomContent, roomId],
    );

    // URLs of the previewed links, used to trim a trailing URL from the body text
    // when a card already renders it.
    const linkPreviewUrls = useMemo(() => linkPreviews.map((preview) => preview.url), [linkPreviews]);

    const engagementSummary: PostEngagementSummary | undefined = viewPost?.engagement;
    const actionsEngagement = useMemo(
        () => ({
            replies: engagementSummary?.replies ?? 0,
            boosts: engagementSummary?.boosts ?? 0,
            likes: engagementSummary?.likes ?? 0,
            downvotes: engagementSummary?.downvotes ?? 0,
            saves: engagementSummary?.saves ?? 0,
            views: engagementSummary?.views ?? null,
            recentReplierAvatars: engagementSummary?.recentReplierAvatars,
        }),
        [
            engagementSummary?.replies,
            engagementSummary?.boosts,
            engagementSummary?.likes,
            engagementSummary?.downvotes,
            engagementSummary?.saves,
            engagementSummary?.views,
            engagementSummary?.recentReplierAvatars,
        ],
    );

    if (!viewPost || !viewPost.user) {
        return null;
    }

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
    const hasBelowHeaderBlocks = Boolean((hasValidLocation && location) || hasSources || shouldRenderMediaBlock || boostUnavailable || !isNested);
    const headerToBlocksGap = content.text ? SECTION_GAP : HEADER_CONTENT_GAP;

    const replyContextHandle = getNormalizedUserHandle(replyContextAuthor) || replyContextAuthor?.name?.displayName;

    const postAuthor = displayNameOrHandle(viewPost.user.name?.displayName, authorHandle ? `@${authorHandle}` : '');
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
                    {t('post.repostedBy', { defaultValue: 'Reposted by' })} {displayNameOrHandle(repostedBy.name?.displayName, getNormalizedUserHandle(repostedBy) ? `@${getNormalizedUserHandle(repostedBy)}` : '')}
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
                {...(isThreadUnit
                    ? {
                        onHoverIn: () => setHoveredSlice(sliceKey ?? null),
                        onHoverOut: () => setHoveredSlice(null),
                    }
                    : {})}
            >
                {isTappable && (isThreadUnit
                    ? <SubtleHover active={isThreadHoverActive} />
                    : <SubtleHover />)}
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
                            backgroundColor: theme.colors.border,
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
                            backgroundColor: theme.colors.border,
                            borderRadius: THREAD_LINE_BORDER_RADIUS,
                            zIndex: THREAD_LINE_Z_INDEX,
                        }}
                    />
                )}
                <View style={{ gap: headerToBlocksGap }}>
                    <PostHeader
                        user={{
                            displayName: viewPost.user.name?.displayName,
                            handle: authorHandle || '',
                            verified: viewPost.user.verified,
                            isFederated: viewPost.user.isFederated,
                            instance: viewPost.user.instance,
                        }}
                        authors={viewPost.authors && viewPost.authors.length > 0 ? viewPost.authors : undefined}
                        date={metadata.createdAt}
                        showBoost={Boolean(viewPost.boost) && !isNested}
                        showReply={false}
                        contextTop={contextRows.length > 0 ? contextRows : undefined}
                        avatarSource={avatarSource}
                        avatarVariant={avatarVariant}
                        authorUserId={viewPost.user.id || undefined}
                        onPressUser={goToUser}
                        onPressAvatar={goToUser}
                        onPressCollaborators={isCollab ? openCollaboratorsSheet : undefined}
                        onPressAuthor={goToAuthor}
                        onPressMenu={openMenu}
                        paddingHorizontal={isNested ? 0 : HPAD}
                    >
                        {spoilerText ? <ContentWarning text={spoilerText} /> : null}
                        {content.text ? <PostContentText content={content} postId={viewPostId} overrideText={languageDisplayText} linkPreviewUrls={linkPreviewUrls} /> : null}
                        {content.text ? (
                            <PostLanguageChip
                                options={languageOptions}
                                activeTag={activeLanguageTag}
                                isTranslating={isTranslating}
                                onSelect={selectLanguage}
                            />
                        ) : null}
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

                {boostUnavailable && (
                    <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD }}>
                        <View className="border-border rounded-2xl border px-3 py-3">
                            <Text className="text-muted-foreground text-[14px]">
                                {t('post.boostUnavailable', { defaultValue: 'This post is no longer available' })}
                            </Text>
                        </View>
                    </View>
                )}

                {shouldRenderMediaBlock && (
                    <PostAttachmentsRow
                        sensitive={isSensitiveContent}
                        media={mediaItems}
                        attachments={attachmentDescriptors}
                        nestedPost={nestedPost ?? null}
                        leftOffset={AVATAR_OFFSET}
                        pollData={pollData}
                        pollId={pollId ? String(pollId) : undefined}
                        nestingDepth={nestingDepth}
                        postId={viewPostId}
                        article={articleProp}
                        onArticlePress={hasArticle ? openArticleSheet : undefined}
                        event={eventProp}
                        room={roomProp}
                        onRoomPress={roomId ? handleRoomPress : undefined}
                        podcast={podcastContent}
                        location={location}
                        sources={sourcesList}
                        onSourcesPress={hasSources ? openSourcesSheet : undefined}
                        text={content.text}
                        linkPreviews={linkPreviews}
                    />
                )}

                {!isNested && (
                    <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD }}>
                        <PostActions
                            engagement={actionsEngagement}
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
                            onTranslate={!isDetailMain && content.text ? toggleReaderTranslation : undefined}
                            isTranslated={isTranslated}
                            isTranslating={isTranslating}
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
        prevProps.sliceKey === nextProps.sliceKey &&
        prevProps.threadRootId === nextProps.threadRootId &&
        prevProps.isThread === nextProps.isThread &&
        // Same original post id can be reposted by different actors across rows;
        // compare the booster so a recycled row never shows a stale "Reposted by".
        prevProps.repostedBy?.id === nextProps.repostedBy?.id
    );
});
