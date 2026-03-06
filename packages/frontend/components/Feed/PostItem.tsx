import React, { useCallback, useMemo, useContext, useState, lazy, Suspense } from 'react';
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
import { useAuth } from '@oxyhq/services';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { getCachedFileDownloadUrlSync } from '@/utils/imageUrlCache';
import { useImagePreload } from '@/hooks/useImagePreload';
import { usePostLike } from '@/hooks/usePostLike';
import { usePostSave } from '@/hooks/usePostSave';
import { usePostRepost } from '@/hooks/usePostRepost';
import { usePostShare } from '@/hooks/usePostShare';
import { usePostActions } from '@/hooks/usePostActions';

type PostEntity = HydratedPost & {
    original?: HydratedPostSummary | null;
    quoted?: HydratedPostSummary | null;
};

interface PostItemProps {
    post: PostEntity;
    isNested?: boolean;
    style?: object;
    onReply?: () => void;
    nestingDepth?: number;
}

const PostItem: React.FC<PostItemProps> = ({
    post,
    isNested = false,
    style,
    onReply,
    nestingDepth = 0,
}) => {
    const { oxyServices } = useAuth();
    const theme = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const pathname = usePathname();
    const bottomSheet = useContext(BottomSheetContext);
    const { joinLiveRoom } = useLiveRoom();
    const [isArticleModalVisible, setIsArticleModalVisible] = useState(false);

    const postId = (post as any)?.id;
    const storePost = usePostsStore((state) => (postId ? state.postsById[postId] : null));
    const viewPost = storePost ?? post;
    const viewPostId = viewPost?.id ? String(viewPost.id) : undefined;

    if (!viewPost || !viewPost.user) {
        return null;
    }

    const viewerState =
        viewPost.viewerState ?? { isOwner: false, isLiked: false, isReposted: false, isSaved: false };

    const metadata = viewPost.metadata ?? {};
    const content: PostContent = viewPost.content ?? {};
    const attachmentsBundle: PostAttachmentBundle = viewPost.attachments ?? {};
    const linkPreview = viewPost.linkPreview ?? null;

    const isOwner = viewerState.isOwner ?? false;
    const isLiked = viewerState.isLiked ?? false;
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

    const avatarUri = useMemo(() => {
        const avatar = viewPost.user?.avatarUrl || (viewPost.user as any)?.avatar;
        if (!avatar) return undefined;
        if (typeof avatar === 'string' && avatar.startsWith('http')) return avatar;
        if (!oxyServices) return avatar;
        try {
            return getCachedFileDownloadUrlSync(oxyServices, String(avatar), 'thumb');
        } catch {
            return avatar;
        }
    }, [viewPost.user?.avatarUrl, (viewPost.user as any)?.avatar, oxyServices]);

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
        const handle = viewPost.user?.handle;
        if (handle) {
            router.push(`/@${handle}`);
            return;
        }
        const id = viewPost.user?.id;
        if (id) {
            router.push(`/${id}`);
        }
    }, [router, viewPost.user?.handle, viewPost.user?.id]);

    const handleLike = usePostLike(viewPostId, isLiked);
    const handleSave = usePostSave(viewPostId, isSaved);
    const handleRepost = usePostRepost(viewPostId, isReposted);
    const handleShare = usePostShare(viewPost);

    const handleReply = useCallback(() => {
        if (onReply) {
            onReply();
            return;
        }
        if (viewPostId) {
            router.push(`/p/${viewPostId}/reply`);
        }
    }, [onReply, router, viewPostId]);

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
                style={[
                    styles.sheetItem,
                    {
                        backgroundColor: theme.colors.backgroundSecondary,
                        borderTopLeftRadius: isFirst ? 16 : 0,
                        borderTopRightRadius: isFirst ? 16 : 0,
                        borderBottomLeftRadius: isLast ? 16 : 0,
                        borderBottomRightRadius: isLast ? 16 : 0,
                        marginBottom: !isLast ? 4 : 0,
                    },
                ]}
                onPress={onPress}
                activeOpacity={0.7}
            >
                <Text style={[styles.sheetItemText, { color: color || theme.colors.text }]}>{text}</Text>
                <View style={styles.sheetItemRight}>{icon}</View>
            </TouchableOpacity>
        );

        const ActionGroup: React.FC<{
            actions: Array<{ icon: any; text: string; onPress: () => void; color?: string }>;
        }> = ({ actions }) => {
            if (actions.length === 0) return null;
            return (
                <View style={styles.actionGroup}>
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
            <View style={[styles.sheetContainer, { backgroundColor: theme.colors.background }]}>
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
    }, [bottomSheet, postActions, theme.colors.background, theme.colors.backgroundSecondary, theme.colors.text]);

    const engagement: PostEngagementSummary = viewPost.engagement ?? {
        likes: 0,
        reposts: 0,
        replies: 0,
        saves: null,
        views: null,
        impressions: null,
    };

    const hideLikeCounts = engagement.likes === null;
    const hideShareCounts = engagement.reposts === null;
    const hideReplyCounts = engagement.replies === null;
    const hideSaveCounts = engagement.saves === null;

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

    return (
        <>
            <Container
                style={[
                    !isNested && styles.postContainer,
                    !isNested && {
                        backgroundColor: theme.colors.background,
                        paddingTop: VPAD,
                        paddingBottom: VPAD,
                    },
                    isNested && [styles.nestedPostContainer, { borderColor: theme.colors.border, backgroundColor: theme.colors.background }],
                    style,
                ]}
                {...(isPostDetail ? {} : { onPress: goToPost })}
            >
                <PostHeader
                    user={{
                        name: viewPost.user.name || viewPost.user.displayName || '',
                        handle: viewPost.user.handle || '',
                        verified: viewPost.user.isVerified,
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
                    {content.text ? <PostContentText content={content} postId={viewPostId} /> : null}
                </PostHeader>

                {hasValidLocation && location && (
                    <View style={{ marginTop: SECTION_GAP, paddingLeft: AVATAR_OFFSET, paddingRight: HPAD }}>
                        <PostLocation location={location} paddingHorizontal={0} />
                    </View>
                )}

                {hasSources && (
                    <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD, marginTop: SECTION_GAP }}>
                        <TouchableOpacity
                            style={[
                                styles.sourcesChip,
                                {
                                    borderColor: theme.colors.border,
                                    backgroundColor: theme.colors.backgroundSecondary,
                                },
                            ]}
                            onPress={openSourcesSheet}
                            activeOpacity={0.8}
                        >
                            <Ionicons name="link-outline" size={14} color={theme.colors.primary} />
                            <Text style={[styles.sourcesChipText, { color: theme.colors.primary }]}>
                                {t('post.sourcesChip', { defaultValue: 'Sources' })}
                                {` (${sourcesList.length})`}
                            </Text>
                        </TouchableOpacity>
                    </View>
                )}

                {shouldRenderMediaBlock && (
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
                )}

                {!isNested && (
                    <View style={{ paddingLeft: AVATAR_OFFSET, paddingRight: HPAD, marginTop: SECTION_GAP }}>
                        <PostActions
                            engagement={{
                                replies: engagement.replies ?? 0,
                                reposts: engagement.reposts ?? 0,
                                likes: engagement.likes ?? 0,
                                saves: engagement.saves ?? null,
                            }}
                            isLiked={isLiked}
                            isReposted={isReposted}
                            isSaved={isSaved}
                            onReply={handleReply}
                            onRepost={handleRepost}
                            onLike={handleLike}
                            onSave={handleSave}
                            onShare={handleShare}
                            postId={viewPostId}
                            showInsights={isOwner}
                            hideLikeCounts={hideLikeCounts}
                            hideShareCounts={hideShareCounts}
                            hideReplyCounts={hideReplyCounts}
                            hideSaveCounts={hideSaveCounts}
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
    sheetContainer: {
        padding: 16,
        gap: 8,
    },
    actionGroup: {
        marginBottom: 4,
    },
    sheetItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
        paddingHorizontal: 14,
    },
    sheetItemText: {
        fontSize: 16,
        fontWeight: '500',
    },
    sheetItemRight: {
        marginLeft: 12,
    },
    sourcesChip: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 12,
        borderWidth: 1,
        alignSelf: 'flex-start',
        marginTop: 8,
    },
    sourcesChipText: {
        fontSize: 13,
        fontWeight: '600',
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
        prev?.viewerState?.isReposted === next?.viewerState?.isReposted &&
        prev?.viewerState?.isSaved === next?.viewerState?.isSaved &&
        prev?.engagement?.likes === next?.engagement?.likes &&
        prev?.engagement?.reposts === next?.engagement?.reposts &&
        prev?.engagement?.replies === next?.engagement?.replies &&
        prev?.metadata?.updatedAt === next?.metadata?.updatedAt &&
        prevProps.isNested === nextProps.isNested &&
        prevProps.nestingDepth === nextProps.nestingDepth
    );
});

