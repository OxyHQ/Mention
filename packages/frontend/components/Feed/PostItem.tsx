import React, { useCallback } from 'react';
import { StyleSheet, View, Share, Platform, Alert, Pressable } from 'react-native';
import { useRouter, usePathname } from 'expo-router';

import { UIPost, Reply, FeedRepost as Repost } from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';
import PostHeader from '../Post/PostHeader';
import PostContentText from '../Post/PostContentText';
import PostActions from '../Post/PostActions';
import PostLocation from '../Post/PostLocation';
import { colors } from '../../styles/colors';
import PostMiddle from '../Post/PostMiddle';
import { useOxy } from '@oxyhq/services';
import { useUsersStore } from '@/stores/usersStore';

interface PostItemProps {
    post: UIPost | Reply | Repost;
    isNested?: boolean; // Flag to indicate if this is a nested post (for reposts/replies)
    style?: object; // Additional styles for the post container
    onReply?: () => void; // Optional override for reply action
}

const PostItem: React.FC<PostItemProps> = ({
    post,
    isNested = false,
    style,
    onReply,
}) => {
    const { oxyServices } = useOxy();
    const router = useRouter();
    const pathname = usePathname();
    const { likePost, unlikePost, repostPost, unrepostPost, savePost, unsavePost, getPostById } = usePostsStore();

    // Subscribe to latest post state using entity cache first, then fallback to scanning feeds
    const postId = (post as any)?.id;
    const storePost = usePostsStore(React.useCallback((state) => {
        if (!postId) return null;
        // Prefer entity cache for minimal updates and less scanning
        const cached = state.postsById[postId as string];
        if (cached) return cached as any;
        const types: ('posts' | 'mixed' | 'media' | 'replies' | 'reposts' | 'likes')[] = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes'];
        for (const t of types) {
            const match = state.feeds[t]?.items?.find((p: any) => p.id === postId);
            if (match) return match;
        }
        return null;
    }, [postId]));
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
            const types: ('posts' | 'mixed' | 'media' | 'replies' | 'reposts' | 'likes')[] = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes'];
            for (const t of types) {
                const match = feeds[t]?.items?.find((p: any) => p.id === id);
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
    }, [viewPost, getPostById, isNested, findFromStore]);

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
                try { handle = useUsersStore.getState().usersById[id]?.data?.username || ''; } catch {}
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
                    Alert.alert('Link copied', 'Post link has been copied to clipboard');
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
            Alert.alert('Error', 'Failed to share post');
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

    const avatarUri = ((viewPost as any)?.user?.avatar && oxyServices && typeof (oxyServices as any).getFileDownloadUrl === 'function')
        ? (oxyServices as any).getFileDownloadUrl((viewPost as any).user.avatar as string, 'thumb')
        : undefined;
    const isPostDetail = (pathname || '').startsWith('/p/');
    const goToPost = useCallback(() => {
        if (!isPostDetail && viewPostId) router.push(`/p/${viewPostId}`);
    }, [router, viewPostId, isPostDetail]);
    const goToUser = useCallback(() => {
        const user = (viewPost as any)?.user || {};
        const id = String(user.id || user._id || '');
        let handle = user.handle || user.username || viewPostHandle || '';
        if (!handle && id) {
            try { handle = useUsersStore.getState().usersById[id]?.data?.username || ''; } catch {}
        }
        if (handle) router.push(`/@${handle}`);
        else if (id) router.push(`/${id}`);
    }, [router, viewPost, viewPostHandle]);

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
            style={[styles.postContainer, isNested && styles.nestedPostContainer, style]}
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
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.primaryLight,
    },
    nestedPostContainer: {
        borderWidth: 1,
        borderRadius: 16,
        width: '100%',
    },
});

export default React.memo(PostItem);
