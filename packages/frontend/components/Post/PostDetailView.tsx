import React, { useCallback, useMemo, useContext, useState, useRef, lazy, Suspense } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import {
    HydratedPost,
    PostContent,
    PostAttachmentBundle,
    PostAttachmentDescriptor,
    PostEngagementSummary,
} from '@mention/shared-types';
import { usePostsStore } from '@/stores/postsStore';
import PostAvatar from './PostAvatar';
import UserName from '../UserName';
import PostContentText from './PostContentText';
import PostLocation from './PostLocation';
import PostAttachmentsRow from './PostAttachmentsRow';
const PostSourcesSheet = lazy(() => import('./PostSourcesSheet'));
const PostArticleModal = lazy(() => import('./PostArticleModal'));
const PostInsightsSheet = lazy(() => import('./PostInsightsSheet'));
import { useAuth } from '@oxyhq/services';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { useLiveRoom } from '@/context/LiveRoomContext';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useImageUrl } from '@/hooks/useImageUrl';
import { usePostLike } from '@/hooks/usePostLike';
import { usePostVote } from '@/hooks/usePostVote';
import { usePostSave } from '@/hooks/usePostSave';
import { usePostRepost } from '@/hooks/usePostRepost';
import { usePostShare } from '@/hooks/usePostShare';
import { usePostActions } from '@/hooks/usePostActions';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { formatCompactNumber } from '@/utils/formatNumber';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { RepostIcon, RepostIconActive } from '@/assets/icons/repost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { PressableScale } from '@/lib/animations/PressableScale';
import { AnimatedLikeIcon } from '@/lib/animations/AnimatedLikeIcon';
import { CountWheel } from '@/lib/animations/CountWheel';
import { useVoteStyle } from '@/hooks/useVoteStyle';
import VotePill from './VotePill';
import { useHaptics } from '@/hooks/useHaptics';
import EngagementListSheet from './EngagementListSheet';
import { cn } from '@/lib/utils';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';

type PostEntity = HydratedPost & {
    original?: any;
    quoted?: any;
};

interface PostDetailViewProps {
    post: PostEntity;
    onFocusReply: () => void;
}

const AVATAR_SIZE = 48;
const HPAD = 16;
const ICON_SIZE = 22;

function formatFullTimestamp(dateString: string): string {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '';

    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    const displayMinutes = minutes.toString().padStart(2, '0');

    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[date.getMonth()];
    const day = date.getDate();
    const year = date.getFullYear();

    return `${displayHours}:${displayMinutes} ${ampm} \u00B7 ${month} ${day}, ${year}`;
}

const EMPTY_VIEWER_STATE = { isOwner: false, isLiked: false, isDownvoted: false, isReposted: false, isSaved: false };
const EMPTY_ENGAGEMENT: PostEngagementSummary = { likes: 0, reposts: 0, replies: 0, saves: null, views: null, impressions: null };

const PostDetailView: React.FC<PostDetailViewProps> = ({ post, onFocusReply }) => {
    const { oxyServices } = useAuth();
    const theme = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const bottomSheet = useContext(BottomSheetContext);
    const { joinLiveRoom } = useLiveRoom();
    const haptic = useHaptics();
    const hasBeenToggled = useRef(false);
    const voteStyle = useVoteStyle();
    const [isArticleModalVisible, setIsArticleModalVisible] = useState(false);
    const [sensitiveRevealed, setSensitiveRevealed] = useState(false);

    // Derive view post from store (reactive) or prop
    const postId = post?.id;
    const storePost = usePostsStore((state) => (postId ? state.postsById[String(postId)] : null));
    const viewPost = (storePost ?? post) as PostEntity;
    const viewPostId = viewPost?.id ? String(viewPost.id) : undefined;

    // Extract all data with safe defaults (hooks must not be conditional)
    const viewerState = viewPost?.viewerState ?? EMPTY_VIEWER_STATE;
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
    const roomContent = attachmentsBundle.room ?? content.room ?? (attachmentsBundle as any).space ?? content.space ?? null;
    const pollData = attachmentsBundle.poll ?? content.poll ?? null;
    const pollId = content.pollId ?? null;
    const location = attachmentsBundle.location ?? content.location ?? null;
    const hasValidLocation = Boolean(location?.coordinates && location.coordinates.length >= 2);
    const mediaItems = attachmentsBundle.media ?? content.media ?? [];

    const rawAvatar = viewPost?.user?.avatarUrl || (viewPost?.user as any)?.avatar;
    const avatarFileId = typeof rawAvatar === 'string' && !rawAvatar.startsWith('http') ? rawAvatar : undefined;
    const resolvedAvatarUrl = useImageUrl(avatarFileId, 'thumb', oxyServices);
    const avatarUri = useMemo(() => {
        if (!rawAvatar) return undefined;
        if (typeof rawAvatar === 'string' && rawAvatar.startsWith('http')) return rawAvatar;
        return resolvedAvatarUrl ?? rawAvatar;
    }, [rawAvatar, resolvedAvatarUrl]);

    const engagement: PostEngagementSummary = viewPost?.engagement ?? EMPTY_ENGAGEMENT;

    const nestedPost = useMemo(() => {
        if (!viewPost) return null;
        if (viewPost.repost?.originalPost) return viewPost.repost.originalPost;
        if (viewPost.original) return viewPost.original;
        if (viewPost.originalPost) return viewPost.originalPost;
        if (viewPost.quoted) return viewPost.quoted;
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

    const goToUser = useCallback(() => {
        if (!viewPost?.user) return;
        if (viewPost.user.isFederated && viewPost.user.handle && viewPost.user.instance) {
            router.push(`/@${viewPost.user.handle}@${viewPost.user.instance}`);
            return;
        }
        const handle = viewPost.user.handle;
        if (handle) {
            router.push(`/@${handle}`);
            return;
        }
        const id = viewPost.user.id;
        if (id) {
            router.push(`/${id}`);
        }
    }, [router, viewPost?.user?.handle, viewPost?.user?.id, viewPost?.user?.isFederated, viewPost?.user?.instance]);

    const handleLike = usePostLike(viewPostId, isLiked);
    const { toggleDownvote: handleDownvote } = usePostVote(viewPostId, isLiked, isDownvoted);
    const handleSave = usePostSave(viewPostId, isSaved);
    const handleRepost = usePostRepost(viewPostId, isReposted);
    const handleShare = usePostShare(viewPost);

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
        if (hasArticle) setIsArticleModalVisible(true);
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
            icon: any; text: string; onPress: () => void; color?: string; isFirst?: boolean; isLast?: boolean;
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

    const openEngagementList = useCallback((type: 'likes' | 'reposts') => {
        if (!viewPostId) return;
        bottomSheet.setBottomSheetContent(
            <EngagementListSheet
                postId={viewPostId}
                type={type}
                onClose={() => bottomSheet.openBottomSheet(false)}
            />
        );
        bottomSheet.openBottomSheet(true);
    }, [bottomSheet, viewPostId]);

    const openInsights = useCallback(() => {
        if (!viewPostId) return;
        bottomSheet.setBottomSheetContent(
            <Suspense fallback={null}>
                <PostInsightsSheet
                    postId={viewPostId}
                    onClose={() => bottomSheet.openBottomSheet(false)}
                />
            </Suspense>
        );
        bottomSheet.openBottomSheet(true);
    }, [bottomSheet, viewPostId]);

    // Guard: all hooks above, render guard below
    if (!viewPost || !viewPost.user) {
        return null;
    }

    const replies = engagement.replies ?? 0;
    const reposts = engagement.reposts ?? 0;
    const likes = engagement.likes ?? 0;
    const downvotes = engagement.downvotes ?? 0;
    const saves = engagement.saves ?? 0;

    // Build stats entries for the engagement row
    const statsEntries: { label: string; count: number; onPress?: () => void }[] = [];
    if (reposts > 0) statsEntries.push({ label: reposts === 1 ? 'repost' : 'reposts', count: reposts, onPress: () => openEngagementList('reposts') });
    if (likes > 0) statsEntries.push({ label: likes === 1 ? 'like' : 'likes', count: likes, onPress: () => openEngagementList('likes') });
    if (saves > 0) statsEntries.push({ label: saves === 1 ? 'save' : 'saves', count: saves });

    const timestampString = metadata.createdAt ? formatFullTimestamp(metadata.createdAt) : '';

    return (
        <>
            <View className="bg-background" style={{ paddingHorizontal: HPAD, paddingTop: 12, paddingBottom: 4 }}>
                {/* Author row */}
                <View className="flex-row items-center mb-3">
                    <ProfileHoverCard username={viewPost.user.handle}>
                        <TouchableOpacity activeOpacity={0.7} onPress={goToUser}>
                            <PostAvatar uri={avatarUri} size={AVATAR_SIZE} />
                        </TouchableOpacity>
                    </ProfileHoverCard>
                    <View className="flex-1 mr-2">
                        <View className="flex-row items-center">
                            <UserName
                                name={viewPost.user.name || viewPost.user.displayName || ''}
                                verified={viewPost.user.isVerified}
                                onPress={goToUser}
                                style={{ name: { fontSize: 16, fontWeight: '700' } }}
                            />
                        </View>
                        <View className="flex-row items-center mt-0.5">
                            <Text className="text-muted-foreground text-[15px]">
                                @{viewPost.user.handle}
                            </Text>
                            {viewPost.user.isFederated && (
                                <FediverseIcon size={13} className="text-muted-foreground ml-1" />
                            )}
                        </View>
                    </View>
                    <TouchableOpacity
                        accessibilityLabel="Post options"
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        className="p-2"
                        onPress={openMenu}
                    >
                        <Ionicons name="ellipsis-horizontal" size={20} color={theme.colors.textSecondary} />
                    </TouchableOpacity>
                </View>

                {/* Post content */}
                {content.text ? (
                    <View className="mb-3">
                        <PostContentText content={content} postId={viewPostId} />
                    </View>
                ) : null}

                {/* Location */}
                {hasValidLocation && location && (
                    <View className="mb-3">
                        <PostLocation location={location} paddingHorizontal={0} />
                    </View>
                )}

                {/* Sources chip */}
                {hasSources && (
                    <View className="mb-3">
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
            </View>

            {/* Media/attachments — full width */}
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
                            leftOffset={HPAD}
                            pollData={pollData}
                            pollId={pollId ? String(pollId) : undefined}
                            nestingDepth={0}
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
                            style={{ marginTop: 0 }}
                        />
                    </View>
                </View>
            )}

            <View style={{ paddingHorizontal: HPAD }}>
                {/* Timestamp row */}
                {timestampString ? (
                    <View className="flex-row items-center py-3" style={{ borderTopWidth: shouldRenderMediaBlock ? 0 : StyleSheet.hairlineWidth, borderTopColor: theme.colors.border }}>
                        <Text className="text-muted-foreground text-[14px]">
                            {timestampString}
                        </Text>
                        <Ionicons
                            name="globe-outline"
                            size={14}
                            color={theme.colors.textSecondary}
                            style={{ marginLeft: 6 }}
                        />
                    </View>
                ) : null}

                {/* Engagement stats row */}
                {statsEntries.length > 0 && (
                    <View
                        className="flex-row items-center py-3"
                        style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border, gap: 16 }}
                    >
                        {statsEntries.map((stat, index) => (
                            <TouchableOpacity
                                key={index}
                                className="flex-row items-center"
                                style={{ gap: 4 }}
                                onPress={stat.onPress}
                                disabled={!stat.onPress}
                                activeOpacity={stat.onPress ? 0.7 : 1}
                            >
                                <Text className="text-foreground text-[14px] font-bold">
                                    {formatCompactNumber(stat.count)}
                                </Text>
                                <Text className="text-muted-foreground text-[14px]">
                                    {stat.label}
                                </Text>
                            </TouchableOpacity>
                        ))}
                    </View>
                )}

                {/* Action buttons row */}
                <View
                    className="flex-row items-center justify-between py-2.5"
                    style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.border }}
                >
                    {/* Like */}
                    {voteStyle === 'pill' && handleDownvote ? (
                        <VotePill
                            likeCount={likes}
                            downvoteCount={downvotes}
                            isLiked={isLiked}
                            isDownvoted={isDownvoted}
                            onUpvote={() => {
                                hasBeenToggled.current = true;
                                handleLike();
                            }}
                            onDownvote={handleDownvote}
                        />
                    ) : (
                        <PressableScale
                            className="flex-row items-center"
                            style={{ gap: 6 }}
                            onPress={() => {
                                hasBeenToggled.current = true;
                                haptic('Light');
                                handleLike();
                            }}
                            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
                            accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
                        >
                            <AnimatedLikeIcon isLiked={isLiked} hasBeenToggled={hasBeenToggled.current} />
                            {likes > 0 && (
                                <CountWheel likeCount={likes} isLiked={isLiked} hasBeenToggled={hasBeenToggled.current} />
                            )}
                        </PressableScale>
                    )}

                    {/* Reply */}
                    <PressableScale
                        className="flex-row items-center"
                        style={{ gap: 6 }}
                        onPress={() => {
                            haptic('Light');
                            onFocusReply();
                        }}
                        hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
                        accessibilityLabel="Reply"
                    >
                        <CommentIcon size={ICON_SIZE} className="text-muted-foreground" />
                        {replies > 0 && (
                            <Text className="text-muted-foreground text-[13px]">
                                {formatCompactNumber(replies)}
                            </Text>
                        )}
                    </PressableScale>

                    {/* Repost */}
                    <PressableScale
                        className="flex-row items-center"
                        style={{ gap: 6 }}
                        onPress={() => {
                            haptic('Medium');
                            handleRepost();
                        }}
                        hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
                        accessibilityLabel={isReposted ? 'Undo repost' : 'Repost'}
                    >
                        {isReposted ? (
                            <RepostIconActive size={ICON_SIZE} color={theme.colors.success} />
                        ) : (
                            <RepostIcon size={ICON_SIZE} className="text-muted-foreground" />
                        )}
                        {reposts > 0 && (
                            <Text
                                className="text-[13px]"
                                style={{ color: isReposted ? theme.colors.success : theme.colors.textSecondary }}
                            >
                                {formatCompactNumber(reposts)}
                            </Text>
                        )}
                    </PressableScale>

                    {/* Bookmark */}
                    <PressableScale
                        onPress={() => {
                            haptic('Light');
                            handleSave();
                        }}
                        hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
                        accessibilityLabel={isSaved ? 'Unsave' : 'Save'}
                    >
                        {isSaved ? (
                            <BookmarkActive size={ICON_SIZE} color={theme.colors.primary} />
                        ) : (
                            <Bookmark size={ICON_SIZE} className="text-muted-foreground" />
                        )}
                    </PressableScale>

                    {/* Share */}
                    <PressableScale
                        onPress={() => {
                            haptic('Light');
                            handleShare();
                        }}
                        hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
                        accessibilityLabel="Share"
                    >
                        <ShareIcon size={ICON_SIZE} className="text-muted-foreground" />
                    </PressableScale>

                    {/* Insights (owner only) */}
                    {isOwner && (
                        <PressableScale
                            onPress={() => {
                                haptic('Light');
                                openInsights();
                            }}
                            hitSlop={{ top: 5, bottom: 10, left: 10, right: 10 }}
                            accessibilityLabel="Insights"
                        >
                            <Ionicons name="stats-chart-outline" size={ICON_SIZE - 2} color={theme.colors.textSecondary} />
                        </PressableScale>
                    )}
                </View>

                {/* Bottom divider */}
                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }} />
            </View>

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

export default React.memo(PostDetailView);

const styles = StyleSheet.create({
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
