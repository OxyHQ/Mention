import React, { useCallback, useMemo, useRef, useContext, useState } from 'react';
import { StyleSheet, View, Share, Platform, Alert, Pressable, TouchableOpacity, Text } from 'react-native';
import { useRouter, usePathname } from 'expo-router';

import { UIPost, Reply, FeedRepost as Repost, FeedType, PostAttachmentDescriptor } from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';
import PostHeader from '../Post/PostHeader';
import PostContentText from '../Post/PostContentText';
import PostActions from '../Post/PostActions';
import EngagementListSheet from '../Post/EngagementListSheet';
import PostInsightsSheet from '../Post/PostInsightsSheet';
import ReplySettingsSheet from '../Compose/ReplySettingsSheet';
import PostLocation from '../Post/PostLocation';
import { colors } from '../../styles/colors';
import PostMiddle from '../Post/PostMiddle';
import PostSourcesSheet from '@/components/Post/PostSourcesSheet';
import PostArticleSheet from '@/components/Post/PostArticleSheet';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { useOxy } from '@oxyhq/services';
import { useUsersStore } from '@/stores/usersStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { TrashIcon } from '@/assets/icons/trash-icon';
import { SourcesIcon } from '@/assets/icons/sources-icon';
import { LinkIcon } from '@/assets/icons/link-icon';
import { PinIcon, UnpinIcon } from '@/assets/icons/pin-icon';
import { HideIcon } from '@/assets/icons/hide-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { Ionicons } from '@expo/vector-icons';
import { feedService } from '../../services/feedService';
import { confirmDialog } from '@/utils/alerts';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useCurrentUserPrivacySettings } from '@/hooks/usePrivacySettings';

interface PostItemProps {
    post: UIPost | Reply | Repost;
    isNested?: boolean; // Flag to indicate if this is a nested post (for reposts/replies)
    style?: object; // Additional styles for the post container
    onReply?: () => void; // Optional override for reply action
    nestingDepth?: number; // Track nesting depth to prevent infinite recursion
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
    const { likePost, unlikePost, repostPost, unrepostPost, savePost, unsavePost, getPostById } = usePostsStore();
    const bottomSheet = useContext(BottomSheetContext);
    const removePostEverywhere = usePostsStore((s: any) => (s as any).removePostEverywhere);

    // Subscribe to latest post state using entity cache only for performance
    const postId = (post as any)?.id;

    // Use a ref to cache the selector to prevent recreation
    // CRITICAL: Reset selector when postId changes (FlashList recycling)
    const selectorRef = useRef<((state: any) => any) | null>(null);
    const prevPostIdRef = useRef<string | undefined>(undefined);

    // Reset selector if postId changed (FlashList recycled component with different post)
    if (postId !== prevPostIdRef.current) {
        prevPostIdRef.current = postId;
        selectorRef.current = postId ? (state: any) => {
            // Only check the entity cache - much faster than scanning feeds
            return state.postsById[postId as string] || null;
        } : null;
    } else if (!selectorRef.current && postId) {
        selectorRef.current = (state: any) => {
            // Only check the entity cache - much faster than scanning feeds
            return state.postsById[postId as string] || null;
        };
    }

    // Fallback to scanning feeds only if not in cache (should rarely happen)
    const storePost = usePostsStore(selectorRef.current || (() => null));

    const viewPost = storePost ?? post;
    const viewPostId = (viewPost as any)?.id as string | undefined;
    const viewPostHandle = (viewPost as any)?.user?.handle as string | undefined;
    const postOwnerId = (viewPost as any)?.user?.id || (viewPost as any)?.user?._id;

    // Check if current user is the post owner (for showing insights button)
    const isOwner = !!(user && ((user as any).id === postOwnerId || (user as any)._id === postOwnerId));

    // Get current user's privacy settings - this controls what THEY see, not what others see
    const currentUserPrivacySettings = useCurrentUserPrivacySettings();
    const hideLikeCounts = currentUserPrivacySettings?.hideLikeCounts || false;
    const hideShareCounts = currentUserPrivacySettings?.hideShareCounts || false;
    const hideReplyCounts = currentUserPrivacySettings?.hideReplyCounts || false;
    const hideSaveCounts = currentUserPrivacySettings?.hideSaveCounts || false;

    // Safely extract boolean states with proper fallbacks and type coercion
    // Ensure we properly handle undefined, null, and falsy values
    const isLiked = Boolean((viewPost as any)?.isLiked ?? (viewPost as any)?.metadata?.isLiked ?? false);
    const isReposted = Boolean((viewPost as any)?.isReposted ?? (viewPost as any)?.metadata?.isReposted ?? false);
    const isSaved = Boolean((viewPost as any)?.isSaved ?? (viewPost as any)?.metadata?.isSaved ?? false);

    // Handle reposts and quotes - prefer embedded original/quoted data from backend
    // CRITICAL: Reset state when postId changes to prevent FlashList recycling issues
    const [originalPost, setOriginalPost] = React.useState<any>(() => {
        const p: any = post;
        // Support both 'original' and 'quoted' keys; 'original' takes precedence for reposts
        return p?.original || p?.quoted || null;
    });

    // CRITICAL: Reset originalPost when postId changes (FlashList recycling)
    // This ensures recycled components don't show stale data
    // Reset immediately when postId changes, before the load effect runs
    React.useEffect(() => {
        // Use viewPost to be consistent with the load effect below
        const newOriginal = (viewPost as any)?.original || (viewPost as any)?.quoted || null;
        // Reset immediately when postId changes (FlashList recycled component)
        setOriginalPost(newOriginal);
    }, [postId, viewPost]); // Reset when postId or viewPost changes

    const findFromStore = useCallback((id: string) => {
        try {
            const { feeds, postsById } = usePostsStore.getState();
            if (postsById[id]) return postsById[id];
            const types = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved'] as const;
            for (const t of types) {
                const match = (feeds as any)[t]?.items?.find((p: any) => p.id === id);
                if (match) return match;
            }
        } catch { }
        return null;
    }, []);

    React.useEffect(() => {
        // If backend embedded original/quoted data is present, skip fetching
        if ((viewPost as any)?.original || (viewPost as any)?.quoted) {
            setOriginalPost((viewPost as any).original || (viewPost as any).quoted);
            return;
        }

        const loadOriginalPost = async () => {
            const postData = viewPost as any;
            const targetId = postData.originalPostId || postData.repostOf || postData.quoteOf;

            // Don't load nested content if we're at max nesting depth
            if (isNested && nestingDepth >= 2) {
                setOriginalPost(null);
                return;
            }

            if (!isNested && targetId) {
                // Try store first for fully hydrated user data
                const fromStore = findFromStore(targetId);
                if (fromStore) {
                    setOriginalPost(fromStore);
                    return;
                }
                try {
                    const original = await getPostById(targetId);
                    setOriginalPost(original);
                } catch (error: any) {
                    // Silently handle 404s - post may have been deleted
                    if (error?.response?.status !== 404) {
                        console.error('Error loading original/quoted post:', error);
                    }
                    // Don't set originalPost on error - component will handle missing data gracefully
                }
            }
        };

        loadOriginalPost();
    }, [viewPost, getPostById, isNested, findFromStore, nestingDepth]);

    // Prime users cache from any embedded user objects (post user and original/quoted user)
    React.useEffect(() => {
        try {
            const state: any = useUsersStore.getState();
            const candidates: any[] = [];
            const u = (viewPost as any)?.user;
            if (u) candidates.push(u);
            const ou = (originalPost as any)?.user;
            if (ou) candidates.push(ou);
            if (candidates.length) {
                if (typeof state?.upsertMany === 'function') state.upsertMany(candidates);
                else if (typeof state?.upsertUser === 'function') candidates.forEach((usr) => state.upsertUser(usr));
            }
        } catch { }
    }, [viewPost, originalPost]);


    const likeActionRef = useRef<Promise<void> | null>(null);

    const sourcesList = React.useMemo(() => {
        const raw = (viewPost as any)?.content?.sources;
        if (!Array.isArray(raw)) return [] as Array<{ url: string; title?: string }>;
        return raw
            .filter((item: any) => item && typeof item.url === 'string' && item.url.trim().length > 0)
            .map((item: any) => ({
                url: item.url.trim(),
                title: typeof item.title === 'string' ? item.title : undefined,
            }));
    }, [viewPost]);

    const hasSources = sourcesList.length > 0;

    const attachments: PostAttachmentDescriptor[] | null = React.useMemo(() => {
        const raw = (viewPost as any)?.content?.attachments;
        if (!Array.isArray(raw)) return null;
        return raw.filter(Boolean) as PostAttachmentDescriptor[];
    }, [viewPost]);

    const articleContent = React.useMemo(() => {
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
    }, [viewPost]);

    const hasArticle = Boolean(articleContent);

    const closeSourcesSheet = React.useCallback(() => {
        bottomSheet.setBottomSheetContent(null);
        bottomSheet.openBottomSheet(false);
    }, [bottomSheet]);

    const sourcesSheetElement = React.useMemo(() => (
        <PostSourcesSheet sources={sourcesList} onClose={closeSourcesSheet} />
    ), [sourcesList, closeSourcesSheet]);

    const openSourcesSheet = React.useCallback(() => {
        if (!hasSources) return;
        bottomSheet.setBottomSheetContent(sourcesSheetElement);
        bottomSheet.openBottomSheet(true);
    }, [hasSources, bottomSheet, sourcesSheetElement]);

    const closeArticleSheet = React.useCallback(() => {
        bottomSheet.setBottomSheetContent(null);
        bottomSheet.openBottomSheet(false);
    }, [bottomSheet]);

    const articleSheetElement = React.useMemo(() => {
        if (!articleContent) return null;
        return (
            <PostArticleSheet
                articleId={articleContent.articleId}
                title={articleContent.title}
                body={articleContent.body}
                onClose={closeArticleSheet}
            />
        );
    }, [articleContent, closeArticleSheet]);

    const openArticleSheet = React.useCallback(() => {
        if (!articleSheetElement) return;
        bottomSheet.setBottomSheetContent(articleSheetElement);
        bottomSheet.openBottomSheet(true);
    }, [articleSheetElement, bottomSheet]);

    const handleLike = useCallback(async () => {
        // Prevent rapid clicks - debounce
        if (likeActionRef.current) {
            return;
        }

        try {
            const action = isLiked
                ? unlikePost({ postId: (viewPost as any).id, type: 'post' })
                : likePost({ postId: (viewPost as any).id, type: 'post' });

            likeActionRef.current = action;
            await action;
        } catch (error) {
            console.error('Error toggling like:', error);
        } finally {
            // Clear ref after a short delay to allow rapid toggles after action completes
            setTimeout(() => {
                likeActionRef.current = null;
            }, 300);
        }
    }, [isLiked, likePost, unlikePost, viewPost]);

    const handleReply = useCallback(() => {
        if (onReply) return onReply();
        router.push(`/p/${(viewPost as any).id}/reply`);
    }, [onReply, router, viewPost]);

    const repostActionRef = useRef<Promise<void> | null>(null);

    const handleRepost = useCallback(async () => {
        // Prevent rapid clicks - debounce
        if (repostActionRef.current) {
            return;
        }

        try {
            const action = isReposted
                ? unrepostPost({ postId: (viewPost as any).id })
                : repostPost({ postId: (viewPost as any).id });

            repostActionRef.current = action;
            await action;
        } catch (error) {
            console.error('Error toggling repost:', error);
        } finally {
            // Clear ref after a short delay to allow rapid toggles after action completes
            setTimeout(() => {
                repostActionRef.current = null;
            }, 300);
        }
    }, [isReposted, viewPost, repostPost, unrepostPost]);

    const handleShare = useCallback(async () => {
        try {
            const postUrl = `https://mention.earth/p/${(viewPost as any).id}`;
            const contentText = (viewPost as any)?.content?.text || '';
            const user = (viewPost as any)?.user || {};
            const id = String(user.id || user._id || '');
            const name = (user?.name?.full) || (user?.name?.first ? `${user.name.first} ${user.name.last || ''}`.trim() : '') || user?.name || user?.username || user?.handle || id || 'Someone';
            let handle = user?.handle || user?.username || '';
            if (!handle && id) {
                try { handle = useUsersStore.getState().usersById[id]?.data?.username || ''; } catch { }
            }
            const shareMessage = contentText
                ? `${name}${handle ? ` (@${handle})` : ''}: ${contentText}`
                : `${name}${handle ? ` (@${handle})` : ''} shared a post`;

            if (Platform.OS === 'web') {
                if (navigator.share) {
                    await navigator.share({
                        title: `${name} on Mention`,
                        text: shareMessage,
                        url: postUrl
                    });
                } else {
                    await navigator.clipboard.writeText(`${shareMessage}\n\n${postUrl}`);
                    await (await import('@/utils/alerts')).alertDialog({ title: 'Link copied', message: 'Post link has been copied to clipboard' });
                }
            } else {
                await Share.share({
                    message: `${shareMessage}\n\n${postUrl}`,
                    url: postUrl,
                    title: `${name} on Mention`
                });
            }
        } catch (error) {
            console.error('Error sharing post:', error);
            try { (await import('@/utils/alerts')).alertDialog({ title: 'Error', message: 'Failed to share post' }); } catch {
                Alert.alert('Error', 'Failed to share post');
            }
        }
    }, [viewPost]);

    const saveActionRef = useRef<Promise<void> | null>(null);

    const handleSave = useCallback(async () => {
        // Prevent rapid clicks - debounce
        if (saveActionRef.current) {
            return;
        }

        try {
            const action = isSaved
                ? unsavePost({ postId: (viewPost as any).id })
                : savePost({ postId: (viewPost as any).id });

            saveActionRef.current = action;
            await action;
        } catch (error) {
            console.error('Error toggling save:', error);
        } finally {
            // Clear ref after a short delay to allow rapid toggles after action completes
            setTimeout(() => {
                saveActionRef.current = null;
            }, 300);
        }
    }, [isSaved, viewPost, savePost, unsavePost]);

    // Keep this in sync with PostAvatar defaults
    const HPAD = 8;
    const AVATAR_SIZE = 40;
    const AVATAR_GAP = 8;
    const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP; // 52
    const BOTTOM_LEFT_PAD = HPAD + AVATAR_OFFSET;

    // Memoize avatar URI to prevent unnecessary re-renders
    const avatarUri = React.useMemo(() => {
        const avatarId = (viewPost as any)?.user?.avatar;
        if (!avatarId || !oxyServices || typeof (oxyServices as any).getFileDownloadUrl !== 'function') {
            return undefined;
        }
        return (oxyServices as any).getFileDownloadUrl(avatarId as string, 'thumb');
    }, [(viewPost as any)?.user?.avatar, oxyServices]);

    const isPostDetail = (pathname || '').startsWith('/p/');
    const goToPost = useCallback(() => {
        if (!isPostDetail && viewPostId) router.push(`/p/${viewPostId}`);
    }, [router, viewPostId, isPostDetail]);
    // Memoize user data to prevent recreating goToUser callback
    const userData = React.useMemo(() => {
        const user = (viewPost as any)?.user || {};
        return {
            id: String(user.id || user._id || ''),
            handle: user.handle || user.username || viewPostHandle || ''
        };
    }, [(viewPost as any)?.user?.id, (viewPost as any)?.user?.handle, (viewPost as any)?.user?.username, viewPostHandle]);

    const goToUser = useCallback(() => {
        let handle = userData.handle;
        if (!handle && userData.id) {
            try { handle = useUsersStore.getState().usersById[userData.id]?.data?.username || ''; } catch { }
        }
        if (handle) router.push(`/@${handle}`);
        else if (userData.id) router.push(`/${userData.id}`);
    }, [router, userData]);

    // Memoized location data and validity (place before early return to respect hooks rules)
    const locationMemo = React.useMemo(() => {
        const postContent = (viewPost as any)?.content;
        const location = postContent?.location;
        const hasValidLocation = Boolean(location?.coordinates && location.coordinates.length >= 2);
        // Reduce noisy logs in production
        if (typeof __DEV__ !== 'undefined' && __DEV__ && location) {
            // console.debug('Post location', { id: (viewPost as any)?.id, hasValidLocation });
        }
        return { location, hasValidLocation } as { location: any; hasValidLocation: boolean };
    }, [viewPost]);

    // Memoized poll id resolution across content and legacy metadata
    const pollIdMemo = React.useMemo(() => {
        const postContent = (viewPost as any)?.content;
        if (postContent?.pollId) return postContent.pollId;
        const md: any = (viewPost as any)?.metadata;
        try {
            if (!md) return null;
            if (typeof md === 'string') {
                const parsed = JSON.parse(md);
                return parsed?.poll?.id || parsed?.pollId || null;
            }
            return md?.pollId || md?.poll?.id || null;
        } catch {
            return null;
        }
    }, [viewPost]);

    const hasMediaContent = Array.isArray((viewPost as any)?.content?.media) && (viewPost as any).content.media.length > 0;
    const hasLegacyImages = Array.isArray((viewPost as any)?.content?.images) && (viewPost as any).content.images.length > 0;
    const hasPollContent = Boolean(pollIdMemo || (viewPost as any)?.content?.poll);
    const hasNestedContent = Boolean(originalPost);
    const shouldRenderMediaBlock = hasMediaContent || hasLegacyImages || hasPollContent || hasArticle || hasNestedContent;

    const sections = {
        location: Boolean((attachments?.some(a => a.type === 'location') ?? locationMemo.hasValidLocation) && locationMemo.hasValidLocation),
        sources: Boolean((attachments?.some(a => a.type === 'sources') ?? hasSources) && hasSources),
        media: Boolean((attachments?.some(a => a.type === 'media' || a.type === 'poll' || a.type === 'article') ?? shouldRenderMediaBlock) && shouldRenderMediaBlock)
    };

    // Early return if post is invalid
    if (!viewPost || !(viewPost as any).user) {
        return null;
    }

    // Make whole post pressable (except in detail view).
    // Use Pressable and avoid capturing responder events so nested horizontal scrollers can receive gestures.
    const Container: any = isPostDetail ? View : Pressable;

    return (
        <Container
            style={[
                !isNested && styles.postContainer,
                !isNested && { borderBottomColor: theme.colors.border, backgroundColor: theme.colors.background },
                isNested && { backgroundColor: theme.colors.background },
                isNested && [styles.nestedPostContainer, { borderColor: theme.colors.border }],
                style
            ]}
            {...(isPostDetail ? {} : { onPress: goToPost })}
            // Don't capture start/move responder so child horizontal ScrollViews can become responder
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
                onPressMenu={() => {
                    // Build and open bottom sheet actions for the post
                    const isOwner = !!(user && ((user as any).id === (viewPost as any)?.user?.id || (user as any)._id === (viewPost as any)?.user?.id));
                    const postId = (viewPost as any)?.id;
                    const handleDelete = async () => {
                        try { bottomSheet.openBottomSheet(false); } catch { }
                        const confirmed = await confirmDialog({
                            title: 'Delete post',
                            message: 'Are you sure you want to delete this post? This action cannot be undone.',
                            okText: 'Delete',
                            cancelText: 'Cancel',
                            destructive: true,
                        });
                        if (!confirmed) return;

                        try {
                            await feedService.deletePost(postId);
                        } catch (e) {
                            console.error('Delete API failed', e);
                            Alert.alert('Error', 'Failed to delete post');
                            return;
                        }
                        try {
                            if (typeof removePostEverywhere === 'function') {
                                removePostEverywhere(postId);
                            } else {
                                const store = usePostsStore.getState() as any;
                                const types = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes', 'saved', 'for_you', 'following'] as const;
                                types.forEach((t) => {
                                    try { store.removePostLocally(postId, t as any); } catch { }
                                });
                            }
                            if (isPostDetail) router.back();
                        } catch (err) {
                            console.error('Error removing post locally:', err);
                        }
                    };

                    const postUrl = `https://mention.earth/p/${postId}`;
                    const isPinned = Boolean((viewPost as any)?.metadata?.isPinned);

                    // Group actions based on the image: Insights (single), Save group, Delete (single), Copy link (single)
                    const insightsAction = isOwner ? [
                        {
                            icon: <AnalyticsIcon size={20} color={theme.colors.textSecondary} />, text: "Insights", onPress: () => {
                                bottomSheet.setBottomSheetContent(
                                    <PostInsightsSheet
                                        postId={viewPostId || null}
                                        onClose={() => bottomSheet.openBottomSheet(false)}
                                    />
                                );
                                bottomSheet.openBottomSheet(true);
                            }
                        }
                    ] : [];

                    // Save action group: Save, Unpin, Hide like and share counts, Reply options
                    const saveActionGroup: Array<{ icon: any; text: string; onPress: () => void; color?: string }> = [];

                    // Save/Unsave
                    if (!isSaved) {
                        saveActionGroup.push({
                            icon: <Bookmark size={20} color={theme.colors.textSecondary} />,
                            text: "Save",
                            onPress: async () => { await handleSave(); bottomSheet.openBottomSheet(false); }
                        });
                    } else {
                        saveActionGroup.push({
                            icon: <BookmarkActive size={20} color={theme.colors.textSecondary} />,
                            text: "Unsave",
                            onPress: async () => { await handleSave(); bottomSheet.openBottomSheet(false); }
                        });
                    }

                    // Unpin (only for owners and if pinned)
                    if (isOwner && isPinned) {
                        saveActionGroup.push({
                            icon: <UnpinIcon size={20} color={theme.colors.textSecondary} />,
                            text: "Unpin",
                            onPress: async () => {
                                // TODO: Implement unpin functionality
                                bottomSheet.openBottomSheet(false);
                            }
                        });
                    }

                    // Hide like and share counts (only for owners)
                    if (isOwner) {
                        saveActionGroup.push({
                            icon: <HideIcon size={20} color={theme.colors.textSecondary} />,
                            text: "Hide like and share counts",
                            onPress: async () => {
                                // TODO: Implement hide counts functionality
                                bottomSheet.openBottomSheet(false);
                            }
                        });
                    }

                    // Reply options (only for owners)
                    if (isOwner) {
                        saveActionGroup.push({
                            icon: <ChevronRightIcon size={20} color={theme.colors.textSecondary} />,
                            text: "Reply options",
                            onPress: () => {
                                bottomSheet.setBottomSheetContent(
                                    <ReplySettingsSheet
                                        replyPermission={(viewPost as any)?.replyPermission || 'anyone'}
                                        onReplyPermissionChange={(permission) => {
                                            // TODO: Implement update reply permission
                                            console.log('Update reply permission:', permission);
                                        }}
                                        reviewReplies={(viewPost as any)?.reviewReplies || false}
                                        onReviewRepliesChange={(enabled) => {
                                            // TODO: Implement update review replies
                                            console.log('Update review replies:', enabled);
                                        }}
                                        onClose={() => bottomSheet.openBottomSheet(false)}
                                    />
                                );
                                bottomSheet.openBottomSheet(true);
                            }
                        });
                    }

                    const deleteAction = isOwner ? [
                        { icon: <TrashIcon size={20} color={theme.colors.error} />, text: "Delete", onPress: handleDelete, color: theme.colors.error }
                    ] : [];

                    const articleAction = hasArticle && articleSheetElement ? [
                        {
                            icon: <ArticleIcon size={20} color={theme.colors.textSecondary} />,
                            text: t('post.viewArticle', { defaultValue: 'View article' }),
                            onPress: () => {
                                openArticleSheet();
                            }
                        }
                    ] : [];

                    const sourcesAction = hasSources ? [
                        {
                            icon: <SourcesIcon size={20} color={theme.colors.textSecondary} />,
                            text: t('post.viewSources', { defaultValue: 'View sources' }),
                            onPress: () => {
                                openSourcesSheet();
                            }
                        }
                    ] : [];

                    const copyLinkAction = [
                        {
                            icon: <LinkIcon size={20} color={theme.colors.textSecondary} />, text: "Copy link", onPress: async () => {
                                try {
                                    if (Platform.OS === 'web') {
                                        await navigator.clipboard.writeText(postUrl);
                                    } else {
                                        const { Clipboard } = require('react-native');
                                        Clipboard.setString(postUrl);
                                    }
                                } catch { }
                                bottomSheet.openBottomSheet(false);
                            }
                        }
                    ];

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
                            onPress={() => { onPress(); }}
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
                            {insightsAction.length > 0 && <ActionGroup actions={insightsAction} />}
                            {saveActionGroup.length > 0 && <ActionGroup actions={saveActionGroup} />}
                            {deleteAction.length > 0 && <ActionGroup actions={deleteAction} />}
                            {articleAction.length > 0 && <ActionGroup actions={articleAction} />}
                            {sourcesAction.length > 0 && <ActionGroup actions={sourcesAction} />}
                            <ActionGroup actions={copyLinkAction} />
                        </View>
                    );
                    bottomSheet.openBottomSheet(true);
                }}
            >
                {/* Top: text content */}
                {Boolean((viewPost as any)?.content?.text) && (
                    <PostContentText content={(viewPost as any).content} postId={(viewPost as any).id} />
                )}
            </PostHeader>

            {['location', 'sources', 'media'].map((section) => {
                if (section === 'location' && sections.location) {
                    return (
                        <PostLocation
                            key="location"
                            location={locationMemo.location}
                            paddingHorizontal={BOTTOM_LEFT_PAD}
                        />
                    );
                }

                if (section === 'sources' && sections.sources) {
                    return (
                        <View key="sources" style={{ paddingLeft: BOTTOM_LEFT_PAD, paddingRight: HPAD }}>
                            <TouchableOpacity
                                style={[styles.sourcesChip, {
                                    borderColor: theme.colors.border,
                                    backgroundColor: theme.colors.backgroundSecondary,
                                }]}
                                onPress={openSourcesSheet}
                                activeOpacity={0.8}
                            >
                                <SourcesIcon size={14} color={theme.colors.primary} />
                                <Text style={[styles.sourcesChipText, { color: theme.colors.primary }]}
                                >
                                    {t('post.sourcesChip', { defaultValue: 'Sources' })}
                                    {` (${sourcesList.length})`}
                                </Text>
                            </TouchableOpacity>
                        </View>
                    );
                }

                if (section === 'media' && sections.media) {
                    return (
                        <PostMiddle
                            key="media"
                            media={(viewPost as any).content?.media || []}
                            attachments={attachments || undefined}
                            nestedPost={originalPost ?? null}
                            leftOffset={BOTTOM_LEFT_PAD}
                            pollData={(viewPost as any).content?.poll}
                            pollId={pollIdMemo as any}
                            nestingDepth={nestingDepth}
                            postId={viewPostId}
                            article={articleContent ? {
                                title: articleContent.title,
                                body: articleContent.excerpt || articleContent.body,
                                articleId: articleContent.articleId,
                            } : null}
                            onArticlePress={hasArticle ? openArticleSheet : undefined}
                        />
                    );
                }

                return null;
            })}

            {/* Only show engagement buttons for non-nested posts */}
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
                        hideLikeCounts={hideLikeCounts}
                        hideShareCounts={hideShareCounts}
                        hideReplyCounts={hideReplyCounts}
                        hideSaveCounts={hideSaveCounts}
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

            {/* Post Insights Modal - removed, now using bottom sheet */}
        </Container>
    );
};

const styles = StyleSheet.create({
    postContainer: {
        flexDirection: 'column',
        gap: 8,
        paddingVertical: 8,
        borderBottomWidth: 1,
    },
    nestedPostContainer: {
        flexDirection: 'column',
        gap: 8,
        paddingVertical: 8,
        flex: 1,
        borderWidth: 1,
        borderRadius: 15,
        maxHeight: 400, // Prevent nested posts from growing too large
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
});

// Custom comparison function to prevent unnecessary re-renders
const arePropsEqual = (prevProps: PostItemProps, nextProps: PostItemProps) => {
    // Only re-render if the post ID changes or meaningful post data changes
    const prevPost = prevProps.post as any;
    const nextPost = nextProps.post as any;

    // Check if it's the same post
    if (prevPost?.id !== nextPost?.id) {
        return false;
    }

    // Check if nested flag changed
    if (prevProps.isNested !== nextProps.isNested) {
        return false;
    }

    // Check if nesting depth changed
    if (prevProps.nestingDepth !== nextProps.nestingDepth) {
        return false;
    }

    // Check if style prop changed (shallow comparison)
    if (prevProps.style !== nextProps.style) {
        return false;
    }

    // For same post, check if engagement or interaction states changed
    const prevEngagement = prevPost?.engagement;
    const nextEngagement = nextPost?.engagement;

    if (
        prevEngagement?.likes !== nextEngagement?.likes ||
        prevEngagement?.reposts !== nextEngagement?.reposts ||
        prevEngagement?.replies !== nextEngagement?.replies ||
        prevPost?.isLiked !== nextPost?.isLiked ||
        prevPost?.isReposted !== nextPost?.isReposted ||
        prevPost?.isSaved !== nextPost?.isSaved
    ) {
        return false;
    }

    // Props are equal, skip re-render
    return true;
};

export default React.memo(PostItem, arePropsEqual);
