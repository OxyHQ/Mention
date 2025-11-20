import React, { useCallback, useMemo, useContext, useState } from 'react';
import { StyleSheet, View, Pressable, TouchableOpacity, Text } from 'react-native';
import { useRouter, usePathname } from 'expo-router';

import { UIPost, Reply, FeedRepost as Repost, PostAttachmentDescriptor } from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';
import PostHeader from '../Post/PostHeader';
import PostContentText from '../Post/PostContentText';
import PostActions from '../Post/PostActions';
import EngagementListSheet from '../Post/EngagementListSheet';
import PostLocation from '../Post/PostLocation';
import PostMiddle from '../Post/PostMiddle';
import PostSourcesSheet from '@/components/Post/PostSourcesSheet';
import { useLinkDetection } from '@/hooks/useLinkDetection';
import PostArticleModal from '@/components/Post/PostArticleModal';
import { useOxy } from '@oxyhq/services';
import { useUsersStore } from '@/stores/usersStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { usePostPrivacy } from '@/hooks/usePostPrivacy';
import { usePostLike } from '@/hooks/usePostLike';
import { usePostSave } from '@/hooks/usePostSave';
import { usePostRepost } from '@/hooks/usePostRepost';
import { usePostShare } from '@/hooks/usePostShare';
import { usePostActions } from '@/hooks/usePostActions';
import { useOriginalPost } from '@/hooks/useOriginalPost';
import { getPostFromStore } from '@/utils/postSelectors';

interface PostItemProps {
    post: UIPost | Reply | Repost;
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
    const { oxyServices, user } = useOxy();
    const theme = useTheme();
    const { t } = useTranslation();
    const router = useRouter();
    const pathname = usePathname();
    const bottomSheet = useContext(BottomSheetContext);
    const [isArticleModalVisible, setIsArticleModalVisible] = useState(false);

    // Simplified post selector - stable selector
    const postId = (post as any)?.id;
    const storePost = usePostsStore((state) => (postId ? state.postsById[postId] : null));
    const viewPost = storePost ?? post;
    const viewPostId = (viewPost as any)?.id as string | undefined;
    const postOwnerId = (viewPost as any)?.user?.id || (viewPost as any)?.user?._id;

    // Early returns for invalid posts
    if (!viewPost || !(viewPost as any).user) {
        return null;
    }

    // Privacy checks
    const privacy = usePostPrivacy(viewPost);
    if (privacy.isAuthorBlocked) {
        return null;
    }

    // Check if current user is the post owner
    const isOwner = !!(user && ((user as any).id === postOwnerId || (user as any)._id === postOwnerId));

    // Extract interaction states
    const isLiked = Boolean((viewPost as any)?.isLiked ?? (viewPost as any)?.metadata?.isLiked ?? false);
    const isReposted = Boolean((viewPost as any)?.isReposted ?? (viewPost as any)?.metadata?.isReposted ?? false);
    const isSaved = Boolean((viewPost as any)?.isSaved ?? (viewPost as any)?.metadata?.isSaved ?? false);

    // Load original/quoted post
    const originalPost = useOriginalPost({ post: viewPost, isNested, nestingDepth });

    // Post action hooks
    const handleLike = usePostLike(viewPostId, isLiked);
    const handleSave = usePostSave(viewPostId, isSaved);
    const handleRepost = usePostRepost(viewPostId, isReposted);
    const handleShare = usePostShare(viewPost);

    // Extract content data
    const postText = (viewPost as any)?.content?.text || '';
    const linkDetection = useLinkDetection(postText);
    const linkMetadata = linkDetection.detectedLinks[0] || null;
    const hasLink = Boolean(linkMetadata);

    const sourcesList = useMemo(() => {
        const raw = (viewPost as any)?.content?.sources;
        if (!Array.isArray(raw)) return [];
        return raw
            .filter((item: any) => item && typeof item.url === 'string' && item.url.trim().length > 0)
            .map((item: any) => ({
                url: item.url.trim(),
                title: typeof item.title === 'string' ? item.title : undefined,
            }));
    }, [(viewPost as any)?.content?.sources]);

    const hasSources = sourcesList.length > 0;

    const attachments: PostAttachmentDescriptor[] | null = useMemo(() => {
        const raw = (viewPost as any)?.content?.attachments;
        if (!Array.isArray(raw)) return null;
        return raw.filter(Boolean) as PostAttachmentDescriptor[];
    }, [(viewPost as any)?.content?.attachments]);

    const articleContent = useMemo(() => {
        const art = (viewPost as any)?.content?.article;
        if (!art) return null;
        const title = typeof art.title === 'string' ? art.title : '';
        const body = typeof art.body === 'string' ? art.body : '';
        const excerpt = typeof art.excerpt === 'string' ? art.excerpt : '';
        const articleId = art.articleId || art.id;
        if (!articleId && !title.trim() && !body.trim() && !excerpt.trim()) return null;
        return {
            articleId: articleId ? String(articleId) : undefined,
            title,
            body,
            excerpt,
        };
    }, [(viewPost as any)?.content?.article]);

    const hasArticle = Boolean(articleContent);

    // Location and poll data
    const location = (viewPost as any)?.content?.location;
    const hasValidLocation = Boolean(location?.coordinates && location.coordinates.length >= 2);
    const pollId = (viewPost as any)?.content?.pollId || (viewPost as any)?.metadata?.pollId || (viewPost as any)?.metadata?.poll?.id || null;
    const hasPollContent = Boolean(pollId || (viewPost as any)?.content?.poll);

    const hasMediaContent = Array.isArray((viewPost as any)?.content?.media) && (viewPost as any).content.media.length > 0;
    const hasLegacyImages = Array.isArray((viewPost as any)?.content?.images) && (viewPost as any).content.images.length > 0;
    const hasNestedContent = Boolean(originalPost);
    const shouldRenderMediaBlock = hasMediaContent || hasLegacyImages || hasPollContent || hasArticle || hasNestedContent || hasLink;

    // Avatar URI
    const avatarUri = useMemo(() => {
        const avatarId = (viewPost as any)?.user?.avatar;
        if (!avatarId || !oxyServices || typeof (oxyServices as any).getFileDownloadUrl !== 'function') {
            return undefined;
        }
        return (oxyServices as any).getFileDownloadUrl(avatarId as string, 'thumb');
    }, [(viewPost as any)?.user?.avatar, oxyServices]);

    // Navigation handlers
    const isPostDetail = (pathname || '').startsWith('/p/');
    const goToPost = useCallback(() => {
        if (!isPostDetail && viewPostId) router.push(`/p/${viewPostId}`);
    }, [router, viewPostId, isPostDetail]);

    const userData = useMemo(() => {
        const user = (viewPost as any)?.user || {};
        return {
            id: String(user.id || user._id || ''),
            handle: user.handle || user.username || ''
        };
    }, [(viewPost as any)?.user?.id, (viewPost as any)?.user?.handle, (viewPost as any)?.user?.username]);

    const goToUser = useCallback(() => {
        let handle = userData.handle;
        if (!handle && userData.id) {
            try { handle = useUsersStore.getState().usersById[userData.id]?.data?.username || ''; } catch { }
        }
        if (handle) router.push(`/@${handle}`);
        else if (userData.id) router.push(`/${userData.id}`);
    }, [router, userData]);

    // Sheet handlers
    const closeSourcesSheet = useCallback(() => {
        bottomSheet.setBottomSheetContent(null);
        bottomSheet.openBottomSheet(false);
    }, [bottomSheet]);

    const sourcesSheetElement = useMemo(() => (
        <PostSourcesSheet sources={sourcesList} onClose={closeSourcesSheet} />
    ), [sourcesList, closeSourcesSheet]);

    const openSourcesSheet = useCallback(() => {
        if (!hasSources) return;
        bottomSheet.setBottomSheetContent(sourcesSheetElement);
        bottomSheet.openBottomSheet(true);
    }, [hasSources, bottomSheet, sourcesSheetElement]);

    const openArticleSheet = useCallback(() => {
        if (!articleContent) return;
        setIsArticleModalVisible(true);
    }, [articleContent]);

    const closeArticleSheet = useCallback(() => {
        setIsArticleModalVisible(false);
    }, []);

    const handleReply = useCallback(() => {
        if (onReply) return onReply();
        router.push(`/p/${viewPostId}/reply`);
    }, [onReply, router, viewPostId]);

    // Bottom sheet actions
    const postActions: {
        insightsAction: Array<{ icon: any; text: string; onPress: () => void; color?: string }>;
        saveActionGroup: Array<{ icon: any; text: string; onPress: () => void; color?: string }>;
        deleteAction: Array<{ icon: any; text: string; onPress: () => void; color?: string }>;
        articleAction: Array<{ icon: any; text: string; onPress: () => void; color?: string }>;
        sourcesAction: Array<{ icon: any; text: string; onPress: () => void; color?: string }>;
        copyLinkAction: Array<{ icon: any; text: string; onPress: () => void; color?: string }>;
    } = usePostActions({
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
        const ActionRow: React.FC<{ icon: any; text: string; onPress: () => void; color?: string; isFirst?: boolean; isLast?: boolean }> = ({ icon, text, onPress, color, isFirst, isLast }) => (
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
                    }
                ]}
                onPress={onPress}
                activeOpacity={0.7}
            >
                <Text style={[styles.sheetItemText, { color: color || theme.colors.text }]}>{text}</Text>
                <View style={styles.sheetItemRight}>{icon}</View>
            </TouchableOpacity>
        );

        const ActionGroup: React.FC<{ actions: Array<{ icon: any; text: string; onPress: () => void; color?: string }> }> = ({ actions }) => {
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
                <ActionGroup actions={postActions.copyLinkAction} />
            </View>
        );
        bottomSheet.openBottomSheet(true);
    }, [postActions, theme, bottomSheet]);

    // Layout constants
    const HPAD = 8;
    const AVATAR_SIZE = 40;
    const AVATAR_GAP = 8;
    const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP;
    const BOTTOM_LEFT_PAD = HPAD + AVATAR_OFFSET;

    // Container component
    const Container: any = isPostDetail ? View : Pressable;

    return (
        <>
            <Container
                style={[
                    !isNested && styles.postContainer,
                    !isNested && { backgroundColor: theme.colors.background },
                    isNested && { backgroundColor: theme.colors.background },
                    isNested && [styles.nestedPostContainer, { borderColor: theme.colors.border }],
                    style
                ]}
                {...(isPostDetail ? {} : { onPress: goToPost })}
                onStartShouldSetResponderCapture={() => false}
                onMoveShouldSetResponderCapture={() => false}
                onStartShouldSetResponder={() => false}
                onMoveShouldSetResponder={() => false}
            >
                <PostHeader
                    user={(viewPost as any).user}
                    date={(viewPost as any).date || 'Just now'}
                    showRepost={Boolean((viewPost as any).originalPostId || (viewPost as any).repostOf || (viewPost as any).quoteOf) && !isNested}
                    repostedBy={(viewPost as any).repostedBy}
                    showReply={false}
                    avatarUri={avatarUri}
                    onPressUser={goToUser}
                    onPressAvatar={goToUser}
                    onPressMenu={openMenu}
                >
                    {privacy.isAuthorRestricted ? (
                        <View style={[styles.restrictedBadge, { backgroundColor: theme.colors.backgroundSecondary ?? `${theme.colors.border}33` }]}>
                            <Ionicons name="eye-off" size={12} color={theme.colors.textSecondary} />
                            <Text style={[styles.restrictedBadgeText, { color: theme.colors.textSecondary }]}>
                                {t('privacy.restricted.badge', 'Restricted contact')}
                            </Text>
                        </View>
                    ) : null}
                    {Boolean((viewPost as any)?.content?.text) && (
                        <PostContentText content={(viewPost as any).content} postId={(viewPost as any).id} />
                    )}
                </PostHeader>

                {hasValidLocation && (
                    <PostLocation
                        key="location"
                        location={location}
                        paddingHorizontal={BOTTOM_LEFT_PAD}
                    />
                )}

                {hasSources && (
                    <View key="sources" style={{ paddingLeft: BOTTOM_LEFT_PAD, paddingRight: HPAD }}>
                        <TouchableOpacity
                            style={[styles.sourcesChip, {
                                borderColor: theme.colors.border,
                                backgroundColor: theme.colors.backgroundSecondary,
                            }]}
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
                    <PostMiddle
                        key="media"
                        media={(viewPost as any).content?.media || []}
                        attachments={attachments || undefined}
                        nestedPost={originalPost ?? null}
                        leftOffset={BOTTOM_LEFT_PAD}
                        pollData={(viewPost as any).content?.poll}
                        pollId={pollId as any}
                        nestingDepth={nestingDepth}
                        postId={viewPostId}
                        article={articleContent ? {
                            title: articleContent.title,
                            body: articleContent.excerpt || articleContent.body,
                            articleId: articleContent.articleId,
                        } : null}
                        onArticlePress={hasArticle ? openArticleSheet : undefined}
                        text={postText}
                        linkMetadata={linkMetadata ? {
                            url: linkMetadata.url,
                            title: linkMetadata.title,
                            description: linkMetadata.description,
                            image: linkMetadata.image,
                            siteName: linkMetadata.siteName,
                        } : null}
                    />
                )}

                {!isNested && (
                    <View style={[{ paddingLeft: BOTTOM_LEFT_PAD, paddingRight: HPAD }]}>
                        <PostActions
                            engagement={(viewPost as any).engagement}
                            isLiked={isLiked}
                            isReposted={isReposted}
                            isSaved={isSaved}
                            onReply={handleReply}
                            onRepost={handleRepost}
                            onLike={handleLike}
                            onSave={handleSave}
                            onShare={handleShare}
                            postId={viewPostId}
                            hideLikeCounts={privacy.hideLikeCounts}
                            hideShareCounts={privacy.hideShareCounts}
                            hideReplyCounts={privacy.hideReplyCounts}
                            hideSaveCounts={privacy.hideSaveCounts}
                            onLikesPress={() => {
                                bottomSheet.setBottomSheetContent(
                                    <EngagementListSheet
                                        postId={viewPostId!}
                                        type="likes"
                                        onClose={() => bottomSheet.openBottomSheet(false)}
                                    />
                                );
                                bottomSheet.openBottomSheet(true);
                            }}
                            onRepostsPress={() => {
                                bottomSheet.setBottomSheetContent(
                                    <EngagementListSheet
                                        postId={viewPostId!}
                                        type="reposts"
                                        onClose={() => bottomSheet.openBottomSheet(false)}
                                    />
                                );
                                bottomSheet.openBottomSheet(true);
                            }}
                            showInsights={isOwner}
                            onInsightsPress={() => {
                                const { PostInsightsSheet } = require('@/components/Post/PostInsightsSheet');
                                bottomSheet.setBottomSheetContent(
                                    <PostInsightsSheet
                                        postId={viewPostId || null}
                                        onClose={() => bottomSheet.openBottomSheet(false)}
                                    />
                                );
                                bottomSheet.openBottomSheet(true);
                            }}
                        />
                    </View>
                )}
            </Container>
            {articleContent && (
                <PostArticleModal
                    visible={isArticleModalVisible}
                    articleId={articleContent.articleId}
                    title={articleContent.title}
                    body={articleContent.body}
                    onClose={closeArticleSheet}
                />
            )}
        </>
    );
};

const styles = StyleSheet.create({
    postContainer: {
        flexDirection: 'column',
        gap: 8,
        paddingVertical: 8,
    },
    nestedPostContainer: {
        flexDirection: 'column',
        gap: 8,
        paddingVertical: 8,
        flex: 1,
        borderWidth: 1,
        borderRadius: 15,
        maxHeight: 400,
        overflow: 'hidden',
    },
    sheetContainer: {
        paddingHorizontal: 16,
        paddingTop: 8,
        paddingBottom: 20,
    },
    actionGroup: {
        marginBottom: 8,
    },
    sheetItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 14,
        minHeight: 50,
    },
    sheetItemText: {
        fontSize: 16,
        flex: 1,
    },
    sheetItemRight: {
        width: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
    sourcesChip: {
        marginTop: 8,
        alignSelf: 'flex-start',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 12,
        paddingVertical: 6,
    },
    sourcesChipText: {
        fontSize: 12,
        fontWeight: '600',
    },
    restrictedBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: 6,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
        marginTop: 2,
    },
    restrictedBadgeText: {
        fontSize: 11,
        fontWeight: '600',
    },
});

/**
 * Simplified comparison function - only checks post ID and updated timestamp
 * All other changes should be handled by subcomponents
 */
const arePropsEqual = (prevProps: PostItemProps, nextProps: PostItemProps) => {
    const prevPost = prevProps.post as any;
    const nextPost = nextProps.post as any;

    // Fast path: check post ID first
    if (prevPost?.id !== nextPost?.id) {
        return false;
    }

    // Check props that don't require deep inspection
    if (
        prevProps.isNested !== nextProps.isNested ||
        prevProps.nestingDepth !== nextProps.nestingDepth ||
        prevProps.style !== nextProps.style
    ) {
        return false;
    }

    // Check if post was updated (backend should set updatedAt on any change)
    if (prevPost?.updatedAt !== nextPost?.updatedAt) {
        return false;
    }

    // Check interaction flags (most common changes)
    if (
        prevPost?.isLiked !== nextPost?.isLiked ||
        prevPost?.isReposted !== nextPost?.isReposted ||
        prevPost?.isSaved !== nextPost?.isSaved
    ) {
        return false;
    }

    // All relevant props are equal, skip re-render
    return true;
};

export default React.memo(PostItem, arePropsEqual);
