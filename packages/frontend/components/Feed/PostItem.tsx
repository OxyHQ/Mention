import React, { useCallback, useMemo, useRef, useContext } from 'react';
import { StyleSheet, View, Share, Platform, Alert, Pressable, TouchableOpacity, Text } from 'react-native';
import { useRouter, usePathname } from 'expo-router';

import { UIPost, Reply, FeedRepost as Repost, FeedType } from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';
import PostHeader from '../Post/PostHeader';
import PostContentText from '../Post/PostContentText';
import PostActions from '../Post/PostActions';
import PostLocation from '../Post/PostLocation';
import { colors } from '../../styles/colors';
import PostMiddle from '../Post/PostMiddle';
import { useOxy } from '@oxyhq/services';
import { useUsersStore } from '@/stores/usersStore';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { Ionicons } from '@expo/vector-icons';
import { feedService } from '../../services/feedService';
import { confirmDialog } from '@/utils/alerts';
import { useTheme } from '@/hooks/useTheme';

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
    const router = useRouter();
    const pathname = usePathname();
    const { likePost, unlikePost, repostPost, unrepostPost, savePost, unsavePost, getPostById } = usePostsStore();
    const bottomSheet = useContext(BottomSheetContext);
    const removePostEverywhere = usePostsStore((s: any) => (s as any).removePostEverywhere);

    // Subscribe to latest post state using entity cache only for performance
    const postId = (post as any)?.id;

    // Use a ref to cache the selector to prevent recreation
    const selectorRef = useRef<((state: any) => any) | null>(null);
    if (!selectorRef.current && postId) {
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

    // Safely extract boolean states with proper fallbacks
    const isLiked = (viewPost as any)?.isLiked ?? false;
    const isReposted = (viewPost as any)?.isReposted ?? false;
    const isSaved = (viewPost as any)?.isSaved ?? false;

    // Handle reposts and quotes - prefer embedded original/quoted data from backend
    const [originalPost, setOriginalPost] = React.useState<any>(() => {
        const p: any = post;
        // Support both 'original' and 'quoted' keys; 'original' takes precedence for reposts
        return p?.original || p?.quoted || null;
    });

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
                } catch (error) {
                    console.error('Error loading original/quoted post:', error);
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


    const handleLike = useCallback(async () => {
        try {
            if (isLiked) {
                await unlikePost({ postId: (viewPost as any).id, type: 'post' });
            } else {
                await likePost({ postId: (viewPost as any).id, type: 'post' });
            }
        } catch (error) {
            console.error('Error toggling like:', error);
        }
    }, [isLiked, likePost, unlikePost, viewPost]);

    const handleReply = useCallback(() => {
        if (onReply) return onReply();
        router.push(`/p/${(viewPost as any).id}/reply`);
    }, [onReply, router, viewPost]);

    const handleRepost = useCallback(async () => {
        try {
            if (isReposted) {
                await unrepostPost({ postId: (viewPost as any).id });
            } else {
                await repostPost({ postId: (viewPost as any).id });
            }
        } catch (error) {
            console.error('Error toggling repost:', error);
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

    const handleSave = useCallback(async () => {
        try {
            if (isSaved) {
                await unsavePost({ postId: (viewPost as any).id });
            } else {
                await savePost({ postId: (viewPost as any).id });
            }
        } catch (error) {
            console.error('Error toggling save:', error);
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
                    const ActionRow: React.FC<{ icon: any; text: string; onPress: () => void; color?: string }> = ({ icon, text, onPress, color }) => (
                        <TouchableOpacity style={styles.sheetItem} onPress={() => { onPress(); }}>
                            <View style={styles.sheetItemLeft}>{icon}</View>
                            <Text style={[styles.sheetItemText, color ? { color } : null]}>{text}</Text>
                        </TouchableOpacity>
                    );

                    bottomSheet.setBottomSheetContent(
                        <View style={styles.sheetContainer}>
                            <ActionRow icon={<Ionicons name="link" size={18} color={theme.colors.textSecondary} />} text="Copy link" onPress={async () => {
                                try {
                                    if (Platform.OS === 'web') {
                                        await navigator.clipboard.writeText(postUrl);
                                    } else {
                                        const { Clipboard } = require('react-native');
                                        Clipboard.setString(postUrl);
                                    }
                                } catch { }
                                bottomSheet.openBottomSheet(false);
                            }} />
                            <ActionRow icon={<Ionicons name="share-outline" size={18} color={theme.colors.textSecondary} />} text="Share" onPress={async () => { await handleShare(); bottomSheet.openBottomSheet(false); }} />
                            {!isSaved ? (
                                <ActionRow icon={<Ionicons name="bookmark-outline" size={18} color={theme.colors.textSecondary} />} text="Save" onPress={async () => { await handleSave(); bottomSheet.openBottomSheet(false); }} />
                            ) : (
                                <ActionRow icon={<Ionicons name="bookmark" size={18} color={theme.colors.textSecondary} />} text="Unsave" onPress={async () => { await handleSave(); bottomSheet.openBottomSheet(false); }} />
                            )}
                            {isOwner && (
                                <ActionRow icon={<Ionicons name="trash-outline" size={18} color={theme.colors.error} />} text="Delete" onPress={handleDelete} color={theme.colors.error} />
                            )}
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

            {/* Location information if available */}
            {locationMemo.hasValidLocation && (
                <PostLocation
                    location={locationMemo.location}
                    paddingHorizontal={BOTTOM_LEFT_PAD}
                />
            )}

            {/* Middle: horizontal scroller with media and nested post (repost/quote only, not replies) */}
            <PostMiddle
                media={(viewPost as any).content?.media || []}
                nestedPost={originalPost ?? null}
                leftOffset={BOTTOM_LEFT_PAD}
                pollData={(viewPost as any).content?.poll}
                pollId={pollIdMemo as any}
                nestingDepth={nestingDepth}
            />

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
                    />
                </View>
            )}
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
        paddingVertical: 8,
    },
    sheetItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
    },
    sheetItemLeft: {
        width: 22,
        alignItems: 'center',
    },
    sheetItemText: {
        fontSize: 16,
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
