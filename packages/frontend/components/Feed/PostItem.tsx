import React from 'react';
import { StyleSheet, View, Share, Platform, Alert } from 'react-native';
import { useRouter } from 'expo-router';

import { UIPost, Reply, FeedRepost as Repost } from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';
import PostHeader from '../Post/PostHeader';
import PostContentText from '../Post/PostContentText';
import PostActions from '../Post/PostActions';
import { colors } from '../../styles/colors';
import PostMiddle from '../Post/PostMiddle';

interface PostItemProps {
    post: UIPost | Reply | Repost;
    isNested?: boolean; // Flag to indicate if this is a nested post (for reposts/replies)
}

const PostItem: React.FC<PostItemProps> = ({
    post,
    isNested = false
}) => {
    const router = useRouter();
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

    React.useEffect(() => {
        const findFromStore = (id: string) => {
            try {
                const { feeds } = usePostsStore.getState();
                const types: Array<'posts' | 'mixed' | 'media' | 'replies' | 'reposts' | 'likes'> = ['posts', 'mixed', 'media', 'replies', 'reposts', 'likes'];
                for (const t of types) {
                    const match = feeds[t]?.items?.find((p: any) => p.id === id);
                    if (match) return match;
                }
            } catch { }
            return null;
        };

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


    const handleLike = async () => {
        try {
            if (isLiked) {
                await unlikePost({ postId: post.id, type: 'post' });
            } else {
                await likePost({ postId: post.id, type: 'post' });
            }
        } catch (error) {
            console.error('Error toggling like:', error);
        }
    };

    const handleReply = () => {
        router.push(`/p/${post.id}/reply`);
    };

    const handleRepost = async () => {
        try {
            if (isReposted) {
                await unrepostPost({ postId: post.id });
            } else {
                await repostPost({ postId: post.id });
            }
        } catch (error) {
            console.error('Error toggling repost:', error);
        }
    };

    const handleShare = async () => {
        try {
            const postUrl = `https://mention.earth/p/${post.id}`;
            const shareMessage = ('content' in post && post.content)
                ? `${post.user.name} (@${post.user.handle}): ${post.content}`
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
    };

    const handleSave = async () => {
        try {
            if (isSaved) {
                await unsavePost({ postId: post.id });
            } else {
                await savePost({ postId: post.id });
            }
        } catch (error) {
            console.error('Error toggling save:', error);
        }
    };

    // Keep this in sync with PostAvatar defaults
    const AVATAR_SIZE = 40;
    const AVATAR_GAP = 12;
    const AVATAR_OFFSET = AVATAR_SIZE + AVATAR_GAP; // 52

    // Early return if post is invalid
    if (!post || !post.user) {
        return null;
    }

    return (
        <View style={[styles.postContainer, isNested && styles.nestedPostContainer]}>
            <View style={styles.postContent}>
                <PostHeader
                    user={post.user}
                    date={post.date || 'Just now'}
                    showRepost={Boolean((post as any).originalPostId) && !isNested}
                    showReply={Boolean((post as any).postId) && !isNested}
                    avatarUri={post.user.avatar}
                >
                    {/* Top: text content */}
                    {'content' in post && !!post.content && (
                        <PostContentText content={post.content} />
                    )}
                </PostHeader>

                {/* Middle: horizontal scroller with media and nested post (repost/parent) */}
                <PostMiddle
                    media={(post as any).media}
                    nestedPost={(originalPost || parentPost) ?? null}
                    leftOffset={AVATAR_OFFSET}
                />

                {/* Only show engagement buttons for non-nested posts */}
                {!isNested && (
                    <View style={styles.bottomPadding}>
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
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    postContainer: {
        flexDirection: 'row',
        paddingVertical: 16,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
    },
    postContent: {
        flex: 1,
        gap: 12,
    },
    nestedPostContainer: {
        borderLeftWidth: 0,
        paddingLeft: 0,
        marginLeft: 0,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: colors.COLOR_BLACK_LIGHT_8,
        paddingTop: 8,
    },
    
    bottomPadding: {
        paddingLeft: 16 + 40 + 12, // header horizontal padding + avatar + gap
        paddingRight: 16,
    },

});

export default PostItem; 
