import React, { useCallback, useMemo, useContext, useState, useRef, lazy, Suspense } from 'react';
import { StyleSheet, View, Pressable, TouchableOpacity, Text } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import {
    HydratedPost,
    HydratedPostSummary,
    PostAttachmentDescriptor,
    PostAttachmentBundle,
    PostContent,
    PostEngagementSummary,
} from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';
import PostHeader from '../Post/PostHeader';
import PostContentText from '../Post/PostContentText';
import PostActions from '../Post/PostActions';
import PostLocation from '../Post/PostLocation';
import PostAttachmentsRow from '../Post/PostAttachmentsRow';
// Lazy load modals/sheets - only loaded when user opens them
const PostSourcesSheet = lazy(() => import('@/components/Post/PostSourcesSheet'));
const PostArticleModal = lazy(() => import('@/components/Post/PostArticleModal'));
const PostInsightsSheet = lazy(() => import('@/components/Post/PostInsightsSheet'));
import { useAuth } from '@oxyhq/services';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { useImageUrl } from '@/hooks/useImageUrl';
import { useImagePreload } from '@/hooks/useImagePreload';
import { usePostLike } from '@/hooks/usePostLike';
import { usePostVote } from '@/hooks/usePostVote';
import { usePostSave } from '@/hooks/usePostSave';
import { usePostRepost } from '@/hooks/usePostRepost';
import { usePostShare } from '@/hooks/usePostShare';
import { usePostActions } from '@/hooks/usePostActions';
import { PinIcon } from '@/assets/icons/pin-icon';
import { api } from '@/utils/api';
import { THREAD_LINE_WIDTH, THREAD_LINE_BORDER_RADIUS, THREAD_LINE_Z_INDEX } from '@/components/Compose/composeLayout';
import { SubtleHover } from '@/components/SubtleHover';
import { useAutoTranslateStore } from '@/stores/autoTranslateStore';
import { toast } from 'sonner';

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
}) => {
    const { oxyServices, user: authUser } = useAuth();
    const isPremium = (authUser as any)?.premium?.isPremium ?? false;
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

    const postId = (post as any)?.id;
    const storePost = usePostsStore((state) => (postId ? state.postsById[postId] : null));
    const viewPost = storePost ?? post;
    const viewPostId = viewPost?.id ? String(viewPost.id) : undefined;

    const viewerState =
        viewPost?.viewerState ?? { isOwner: false, isLiked: false, isDownvoted: false, isReposted: false, isSaved: false };

    const metadata = viewPost?.metadata ?? {};
    const content: PostContent = viewPost?.content ?? {};
    const attachmentsBundle: PostAttachmentBundle = viewPost?.attachments ?? {};
    const linkPreview = viewPost?.linkPreview ?? null;
    const isSensitiveContent = metadata.isSensitive === true;

    const isOwner = viewerState.isOwner ?? false;
    const isLiked = viewerState.isLiked ?? false;
    const isDownvoted = viewerState.isDownvoted ?? false;
    const isReposted = viewerState.isReposted ?? false;
    const isSaved = viewerState.isSaved ?? false;

    const sourcesList = attachmentsBundle.sources ?? [];
    const hasSources = sourcesList.length > 0;

    const articleContent = attachmentsBundle.article ?? null;
    const hasArticle = Boolean(articleContent);

    const eventContent = attachmentsBundle.event ?? content.event ?? null;
    const hasEvent = Boolean(eventContent);

    const roomContent = attachmentsBundle.room ?? content.room ?? (attachmentsBundle as any).space ?? content.space ?? null;

    const pollData = attachmentsBundle.poll ?? content.poll ?? null;
    const pollId = content.pollId ?? null;

    const location = attachmentsBundle.location ?? content.location ?? null;
    const hasValidLocation = Boolean(location?.coordinates && location.coordinates.length >= 2);

    const mediaItems = attachmentsBundle.media ?? content.media ?? [];

    const nestedPost = useMemo(() => {
        if (!viewPost) return null;
        if (viewPost.repost?.originalPost) return viewPost.repost.originalPost;
        if ((viewPost as any).original) return (viewPost as any).original;
        if (viewPost.originalPost) return viewPost.originalPost;
        if ((viewPost as any).quoted) return (viewPost as any).quoted;
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
        Boolean(linkPreview) ||
        hasValidLocation;

    const attachmentDescriptors: PostAttachmentDescriptor[] | undefined = Array.isArray(content.attachments)
        ? content.attachments
        : undefined;

    const rawAvatar = viewPost?.user?.avatarUrl || (viewPost?.user as any)?.avatar;
    const avatarFileId = typeof rawAvatar === 'string' && !rawAvatar.startsWith('http') ? rawAvatar : undefined;
    const resolvedAvatarUrl = useImageUrl(avatarFileId, 'thumb', oxyServices);

    const avatarUri = useMemo(() => {
        if (!rawAvatar) return undefined;
        if (typeof rawAvatar === 'string' && rawAvatar.startsWith('http')) return rawAvatar;
        return resolvedAvatarUrl ?? rawAvatar;
    }, [rawAvatar, resolvedAvatarUrl]);

    // Preload images for better perceived performance
    const imageUrls = useMemo(() => {
        const urls: string[] = [];
        if (avatarUri && (avatarUri.startsWith('http://') || avatarUri.startsWith('https://'))) {
            urls.push(avatarUri);
        }
        // Filter and collect valid URLs in one pass
        for (const item of mediaItems) {
            if (item.src && (item.src.startsWith('http://') || item.src.startsWith('https://'))) {
                urls.push(item.src);
            }
        }
        return urls;
    }, [avatarUri, mediaItems]);

    useImagePreload(imageUrls, true);

    const isPostDetail = (pathname || '').startsWith('/p/');
    const goToPost = useCallback(() => {
        if (!isPostDetail && viewPostId) {
            router.push(`/p/${viewPostId}`);
        }
    }, [router, viewPostId, isPostDetail]);

    const goToUser = useCallback(() => {
        if (viewPost.user?.isFederated && viewPost.user?.handle && viewPost.user?.instance) {
            router.push(`/@${viewPost.user.handle}@${viewPost.user.instance}`);
            return;
        }
        const handle = viewPost.user?.handle;
        if (handle) {
            router.push(`/@${handle}`);
            return;
        }
        const id = viewPost.user?.id;
        if (id) {
            router.push(`/${id}`);
        }
    }, [router, viewPost.user?.handle, viewPost.user?.id, viewPost.user?.isFederated, viewPost.user?.instance]);

    const handleLike = usePostLike(viewPostId, isLiked);
    const { toggleDownvote: handleDownvote } = usePostVote(viewPostId, isLiked, isDownvoted);
    const handleSave = usePostSave(viewPostId, isSaved);
    const handleRepost = usePostRepost(viewPostId, isReposted);
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
                toast.error(t('translation.failed'));
            }
        } catch (err: unknown) {
            const status = (err as { response?: { status?: number } })?.response?.status;
            if (status === 429) {
                toast.error(t('translation.rateLimited'));
            } else {
                toast.error(t('translation.failed'));
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
            icon: any;
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
            actions: Array<{ icon: any; text: string; onPress: () => void; color?: string }>;
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
        reposts: 0,
        replies: 0,
        saves: null,
        views: null,
        impressions: null,
    };

    const SPACING = 12; // Unified spacing for consistent padding/gaps
    const HPAD = SPACING;
    const VPAD = SPACING;
    const SECTION_GAP = SPACING;
    const AVATAR_SIZE = 40;
    const AVATAR_GAP = SPACING;
    // AVATAR_OFFSET is the distance from container edge to where text/content starts after avatar
    // Header has HPAD padding, then avatar (40px), then gap (12px), so text starts at HPAD + 40 + 12
    const AVATAR_OFFSET = HPAD + AVATAR_SIZE + AVATAR_GAP;

    const Container: any = isPostDetail ? View : Pressable;

    const repostedBy = viewPost.repost?.actor
        ? {
            name: viewPost.repost.actor.displayName || viewPost.repost.actor.name || '',
            handle: viewPost.repost.actor.handle || '',
            verified: viewPost.repost.actor.isVerified,
            date: metadata.createdAt,
        }
        : undefined;

    const postAuthor = viewPost.user?.name || viewPost.user?.displayName || viewPost.user?.handle || '';
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

    return (
        <>
            <Container
                className={cn(
                    "group",
                    !isNested && "bg-background",
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
                    isThreadChild && !isNested && { paddingTop: 4 },
                    style,
                ]}
                accessibilityLabel={postAccessibilityLabel}
                {...(isPostDetail ? {} : { onPress: goToPost })}
            >
                {!isPostDetail && <SubtleHover />}
                {/* Thread line above avatar — connects from previous post's bottom */}
                {isThreadChild && !isNested && (
                    <View
                        style={{
                            position: 'absolute',
                            top: 0,
                            left: THREAD_LINE_LEFT,
                            width: THREAD_LINE_W,
                            height: 4,
                            backgroundColor: `${theme.colors.primary}30`,
                            borderRadius: THREAD_LINE_BORDER_RADIUS,
                            zIndex: THREAD_LINE_Z_INDEX,
                        }}
                    />
                )}
                {/* Thread line below avatar — connects to next post's top */}
                {isThreadParent && !isNested && (
                    <View
                        style={{
                            position: 'absolute',
                            top: (isThreadChild ? 4 : VPAD) + AVATAR_SIZE,
                            left: THREAD_LINE_LEFT,
                            width: THREAD_LINE_W,
                            bottom: 0,
                            backgroundColor: `${theme.colors.primary}30`,
                            borderRadius: THREAD_LINE_BORDER_RADIUS,
                            zIndex: THREAD_LINE_Z_INDEX,
                        }}
                    />
                )}
                {showPinned && (
                    <View className="flex-row items-center mb-0.5" style={{ paddingLeft: HPAD }}>
                        <View style={{ width: AVATAR_SIZE + AVATAR_GAP, alignItems: 'flex-end', paddingRight: AVATAR_GAP }}>
                            <PinIcon size={14} className="text-muted-foreground" />
                        </View>
                        <Text className="text-muted-foreground text-[13px] font-semibold">
                            {t('post.pinned', { defaultValue: 'Pinned' })}
                        </Text>
                    </View>
                )}
                <PostHeader
                    user={{
                        name: viewPost.user.name || viewPost.user.displayName || '',
                        handle: viewPost.user.handle || '',
                        verified: viewPost.user.isVerified,
                        isFederated: viewPost.user.isFederated,
                        instance: viewPost.user.instance,
                    }}
                    date={metadata.createdAt}
                    showRepost={Boolean(viewPost.repost) && !isNested}
                    repostedBy={repostedBy}
                    showReply={false}
                    avatarUri={avatarUri}
                    onPressUser={goToUser}
                    onPressAvatar={goToUser}
                    onPressMenu={openMenu}
                    paddingHorizontal={HPAD}
                >
                    {content.text ? <PostContentText content={content} postId={viewPostId} translatedText={translatedText} linkPreviewUrl={linkPreview?.url} /> : null}
                </PostHeader>

                {hasValidLocation && location && (
                    <View style={{ marginTop: SECTION_GAP, paddingLeft: AVATAR_OFFSET, paddingRight: HPAD }}>
                        <PostLocation location={location} paddingHorizontal={0} />
                    </View>
                )}

                {hasSources && (
                    <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD, marginTop: SECTION_GAP }}>
                        <TouchableOpacity
                            className="border-border bg-surface flex-row items-center gap-1.5 self-start rounded-xl border mt-2"
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
                                    roomContent
                                        ? {
                                            roomId: roomContent.roomId || roomContent.spaceId,
                                            title: roomContent.title,
                                            status: roomContent.status,
                                            topic: roomContent.topic,
                                            host: roomContent.host,
                                        }
                                        : null
                                }
                                onRoomPress={
                                    (roomContent?.roomId || roomContent?.spaceId)
                                        ? () => joinLiveRoom(roomContent.roomId || roomContent.spaceId)
                                        : undefined
                                }
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
                                style={{ marginTop: SECTION_GAP }}
                            />
                        </View>
                    </View>
                )}

                {!isNested && (
                    <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD, marginTop: SECTION_GAP }}>
                        <PostActions
                            engagement={{
                                replies: engagement.replies ?? 0,
                                reposts: engagement.reposts ?? 0,
                                likes: engagement.likes ?? 0,
                                downvotes: engagement.downvotes ?? 0,
                                saves: engagement.saves ?? null,
                                views: engagement.views ?? null,
                                recentReplierAvatars: engagement.recentReplierAvatars,
                            }}
                            isLiked={isLiked}
                            isDownvoted={isDownvoted}
                            isReposted={isReposted}
                            isSaved={isSaved}
                            onReply={handleReply}
                            onRepost={handleRepost}
                            onLike={handleLike}
                            onDownvote={handleDownvote}
                            onSave={handleSave}
                            onShare={handleShare}
                            postId={viewPostId}
                            onTranslate={content.text ? handleTranslate : undefined}
                            isTranslated={Boolean(translatedText)}
                            isTranslating={isTranslating}
                            isPremium={isPremium}
                            onInsightsPress={isOwner ? () => {
                                bottomSheet.setBottomSheetContent(
                                    <Suspense fallback={null}>
                                        <PostInsightsSheet
                                            postId={viewPostId || null}
                                            onClose={() => bottomSheet.openBottomSheet(false)}
                                        />
                                    </Suspense>
                                );
                                bottomSheet.openBottomSheet(true);
                            } : undefined}
                        />
                    </View>
                )}
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
        borderBottomColor: 'rgba(0,0,0,0.08)',
    },
    nestedPostContainer: {
        borderWidth: StyleSheet.hairlineWidth,
        borderRadius: 16,
        marginTop: 12,
        padding: 12,
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
        prev?.viewerState?.isReposted === next?.viewerState?.isReposted &&
        prev?.viewerState?.isSaved === next?.viewerState?.isSaved &&
        prev?.engagement?.likes === next?.engagement?.likes &&
        prev?.engagement?.downvotes === next?.engagement?.downvotes &&
        prev?.engagement?.reposts === next?.engagement?.reposts &&
        prev?.engagement?.replies === next?.engagement?.replies &&
        prev?.metadata?.updatedAt === next?.metadata?.updatedAt &&
        prevProps.isNested === nextProps.isNested &&
        prevProps.nestingDepth === nextProps.nestingDepth &&
        prevProps.isThreadParent === nextProps.isThreadParent &&
        prevProps.isThreadChild === nextProps.isThreadChild &&
        prevProps.isThreadLastChild === nextProps.isThreadLastChild
    );
});
