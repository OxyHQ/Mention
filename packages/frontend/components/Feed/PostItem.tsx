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

    // Safely extract boolean states with proper fallbacks
    const isLiked = post?.isLiked ?? false;
    const isReposted = post?.isReposted ?? false;
    const isSaved = post?.isSaved ?? false;

    // Handle reposts - if this is a repost, we need to get the original post
    const [originalPost, setOriginalPost] = React.useState<any>(null);
    const [isLoadingOriginal, setIsLoadingOriginal] = React.useState(false);

    // Handle replies - if this is a reply, we might want to show the parent post
    const [parentPost, setParentPost] = React.useState<any>(null);
    const [isLoadingParent, setIsLoadingParent] = React.useState(false);

    const findFromStore = useCallback((id: string) => {
        try {
            const { feeds } = usePostsStore.getState();
            const types: Array<'posts' | 'mixed' | 'media' | 'replies' | 'reposts' | 'likes'> = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes'];
            for (const t of types) {
                const match = feeds[t]?.items?.find((p: any) => p.id === id);
                if (match) return match;
            }
        } catch { }
        return null;
    }, []);

    React.useEffect(() => {

        const loadOriginalPost = async () => {
            if (!isNested && 'originalPostId' in post && post.originalPostId) {
                // Try store first for fully hydrated user data
                const fromStore = findFromStore(post.originalPostId);
                if (fromStore) {
                    setOriginalPost(fromStore);
                    return;
                }
                setIsLoadingOriginal(true);
                try {
                    const original = await getPostById(post.originalPostId);
                    setOriginalPost(original);
                } catch (error) {
                    console.error('Error loading original post:', error);
                } finally {
                    setIsLoadingOriginal(false);
                }
            }
        };

        const loadParentPost = async () => {
            // Only load parent post for replies when we're at the top level
            if ('postId' in post && post.postId && !isNested) {
                // Try store first for fully hydrated user data
                const fromStore = findFromStore(post.postId);
                if (fromStore) {
                    setParentPost(fromStore);
                    return;
                }
                setIsLoadingParent(true);
                try {
                    const parent = await getPostById(post.postId);
                    setParentPost(parent);
                } catch (error) {
                    console.error('Error loading parent post:', error);
                } finally {
                    setIsLoadingParent(false);
                }
            }
        };

        loadOriginalPost();
        loadParentPost();
    }, [post, getPostById, isNested]);


    const handleLike = useCallback(async () => {
        try {
            if (isLiked) {
                await unlikePost({ postId: post.id, type: 'post' });
            } else {
                await likePost({ postId: post.id, type: 'post' });
            }
        } catch (error) {
            console.error('Error toggling like:', error);
        }
    }, [isLiked, likePost, unlikePost, post.id]);

    const handleReply = useCallback(() => {
        if (onReply) return onReply();
        router.push(`/p/${post.id}/reply`);
    }, [onReply, router, post.id]);

    const handleRepost = useCallback(async () => {
        try {
            if (isReposted) {
                await unrepostPost({ postId: post.id });
            } else {
                await repostPost({ postId: post.id });
            }
        } catch (error) {
            console.error('Error toggling repost:', error);
        }
    }, [isReposted, post.id, repostPost, unrepostPost]);

    const handleShare = useCallback(async () => {
        try {
            const postUrl = `https://mention.earth/p/${post.id}`;
            const contentText = ('content' in post && typeof post.content === 'object' && post.content?.text)
                ? post.content.text
                : ('content' in post && typeof post.content === 'string')
                ? post.content
                : '';
            const shareMessage = contentText
                ? `${post.user.name} (@${post.user.handle}): ${contentText}`
                : `${post.user.name} (@${post.user.handle}) shared a post`;

            if (Platform.OS === 'web') {
                if (navigator.share) {
                    await navigator.share({
                        title: `${post.user.name} on Mention`,
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
                    title: `${post.user.name} on Mention`
                });
            }
        } catch (error) {
            console.error('Error sharing post:', error);
            Alert.alert('Error', 'Failed to share post');
        }
    }, [post]);

    const handleSave = useCallback(async () => {
        try {
            if (isSaved) {
                await unsavePost({ postId: post.id });
            } else {
                await savePost({ postId: post.id });
            }
        } catch (error) {
            console.error('Error toggling save:', error);
        }
    }, [isSaved, post.id, savePost, unsavePost]);

    // Keep this in sync with PostAvatar defaults
    const HPAD = 16;
    const AVATAR_SIZE = 40;
    const AVATAR_GAP = 12;
    const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP; // 52
    const BOTTOM_LEFT_PAD = HPAD + AVATAR_OFFSET;

    const avatarUri = post?.user?.avatar ? oxyServices.getFileDownloadUrl(post.user.avatar as string, 'thumb') : undefined;
    const isPostDetail = (pathname || '').startsWith('/p/');
    const goToPost = useCallback(() => {
        if (!isPostDetail && post?.id) router.push(`/p/${post.id}`);
    }, [router, post?.id, isPostDetail]);
    const goToUser = useCallback(() => {
        const handle = post?.user?.handle || '';
        if (handle) router.push(`/@${handle}`);
    }, [router, post?.user?.handle]);

    // Early return if post is invalid
    if (!post || !post.user) {
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
                user={post.user}
                date={post.date || 'Just now'}
                showRepost={Boolean((post as any).originalPostId) && !isNested}
                showReply={Boolean((post as any).postId) && !isNested}
                avatarUri={avatarUri}
                onPressUser={goToUser}
                onPressAvatar={goToUser}
            >
                {/* Top: text content */}
                {'content' in post && !!(post as any).content && (
                    <PostContentText content={(post as any).content} postId={post.id} />
                )}
            </PostHeader>

            {/* Location information if available */}
            {(() => {
                const postContent = (post as any)?.content;
                const location = postContent?.location;
                const hasValidLocation = location?.coordinates && location.coordinates.length >= 2;
                
                // Debug logging for all posts to see location data
                console.log('🗺️ Location check for post:', {
                    postId: post.id,
                    text: postContent?.text || 'No text',
                    hasLocation: !!location,
                    hasValidLocation,
                    coordinates: location?.coordinates,
                    address: location?.address,
                    locationType: location?.type
                });
                
                return hasValidLocation;
            })() && (
                <PostLocation 
                    location={(post as any).content.location} 
                    paddingHorizontal={BOTTOM_LEFT_PAD}
                />
            )}

            {/* Middle: horizontal scroller with media and nested post (repost/parent) */}
            <PostMiddle
                media={(post as any).content?.media || []}
                nestedPost={(originalPost || parentPost) ?? null}
                leftOffset={BOTTOM_LEFT_PAD}
                pollData={(post as any).content?.poll}
                pollId={(() => {
                    // Check for poll ID in content.pollId first (new structure)
                    const postContent = (post as any).content;
                    if (postContent?.pollId) {
                        return postContent.pollId;
                    }
                    
                    // Fallback to legacy metadata structure
                    const md: any = (post as any).metadata;
                    try {
                        if (!md) return null;
                        // support object, stringified JSON, and direct pollId
                        if (typeof md === 'string') {
                            const parsed = JSON.parse(md);
                            return parsed?.poll?.id || parsed?.pollId || null;
                        }
                        return md?.pollId || md?.poll?.id || null;
                    } catch {
                        return null;
                    }
                })() as any}
            />

            {/* Only show engagement buttons for non-nested posts */}
            {!isNested && (
                <View style={[styles.bottomPadding, { paddingLeft: BOTTOM_LEFT_PAD, paddingRight: HPAD }]}>
                    <PostActions
                        engagement={post.engagement}
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
        gap: 12,
        paddingVertical: 12,
        borderBottomWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.primaryLight,
    },
    nestedPostContainer: {
        borderWidth: 1,
        borderRadius: 16,
        width: '100%',
    },

    bottomPadding: {
        // Values injected from constants above
    },

});

export default PostItem; 
