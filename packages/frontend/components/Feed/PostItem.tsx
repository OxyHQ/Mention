import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
    Image,
    StyleSheet,
    Text,
    TouchableOpacity,
    View,
    Share,
    Platform,
    Alert
} from 'react-native';
import { useRouter } from 'expo-router';

import { UIPost, Reply, FeedRepost as Repost } from '@mention/shared-types';
import { usePostsStore } from '../../stores/postsStore';

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
        const loadOriginalPost = async () => {
            if ('originalPostId' in post && post.originalPostId) {
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

    // Early return if post is invalid
    if (!post || !post.user) {
        return null;
    }

    return (
        <View style={[styles.postContainer, isNested && styles.nestedPostContainer]}>
            <Image source={{ uri: post.user.avatar }} style={styles.postAvatar} />
            <View style={styles.postContent}>
                <View style={styles.postHeader}>
                    <Text style={styles.postUserName}>
                        {post.user.name}
                        {post.user.verified && (
                            <Ionicons name="checkmark-circle" size={16} color="#1DA1F2" style={styles.verifiedIcon} />
                        )}
                    </Text>
                    <Text style={styles.postHandle}>@{post.user.handle}</Text>
                    <Text style={styles.postDate}>· {post.date || 'Just now'}</Text>
                    {'originalPostId' in post && !isNested && (
                        <View style={styles.repostIndicator}>
                            <Ionicons name="repeat" size={12} color="#71767B" />
                            <Text style={styles.repostText}>Reposted</Text>
                        </View>
                    )}
                    {'postId' in post && !isNested && (
                        <View style={styles.repostIndicator}>
                            <Ionicons name="chatbubble" size={12} color="#71767B" />
                            <Text style={styles.repostText}>Replied</Text>
                        </View>
                    )}
                </View>

                {/* Show parent post for replies */}
                {'postId' in post && parentPost && !isNested && (
                    <View style={styles.parentPostContainer}>
                        {isLoadingParent ? (
                            <Text style={styles.repostText}>Loading original post...</Text>
                        ) : (
                            <PostItem post={parentPost} isNested={true} />
                        )}
                    </View>
                )}

                {'content' in post && post.content && (
                    <Text style={styles.postText}>{post.content}</Text>
                )}
                
                {/* Show original post for reposts */}
                {'originalPostId' in post && !('content' in post) && (
                    <View style={styles.repostContainer}>
                        {isLoadingOriginal ? (
                            <Text style={styles.repostText}>Loading original post...</Text>
                        ) : originalPost ? (
                            <PostItem post={originalPost} isNested={true} />
                        ) : (
                            <Text style={styles.repostText}>Original post not found</Text>
                        )}
                    </View>
                )}
                
                {/* Only show engagement buttons for non-nested posts */}
                {!isNested && (
                    <View style={styles.postEngagement}>
                        <TouchableOpacity style={styles.engagementButton} onPress={handleReply}>
                            <Ionicons name="chatbubble-outline" size={18} color="#71767B" />
                            <Text style={styles.engagementText}>{post.engagement?.replies ?? 0}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.engagementButton} onPress={handleRepost}>
                            <Ionicons
                                name={isReposted ? "repeat" : "repeat-outline"}
                                size={18}
                                color={isReposted ? "#00BA7C" : "#71767B"}
                            />
                            <Text style={[styles.engagementText, isReposted && styles.activeEngagementText]}>
                                {post.engagement?.reposts ?? 0}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.engagementButton} onPress={handleLike}>
                            <Ionicons
                                name={isLiked ? "heart" : "heart-outline"}
                                size={18}
                                color={isLiked ? "#F91880" : "#71767B"}
                            />
                            <Text style={[styles.engagementText, isLiked && styles.activeEngagementText]}>
                                {post.engagement?.likes ?? 0}
                            </Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.engagementButton} onPress={handleSave}>
                            <Ionicons
                                name={isSaved ? "bookmark" : "bookmark-outline"}
                                size={18}
                                color={isSaved ? "#1DA1F2" : "#71767B"}
                            />
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.engagementButton} onPress={handleShare}>
                            <Ionicons name="share-outline" size={18} color="#71767B" />
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    postContainer: {
        flexDirection: 'row',
        padding: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#2F3336',
        backgroundColor: '#000',
    },
    postAvatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
        marginRight: 12,
    },
    postContent: {
        flex: 1,
    },
    postHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    postUserName: {
        fontSize: 15,
        fontWeight: '700',
        color: '#FFF',
        marginRight: 4,
    },
    verifiedIcon: {
        marginRight: 4,
    },
    postHandle: {
        fontSize: 15,
        color: '#71767B',
        marginRight: 4,
    },
    postDate: {
        fontSize: 15,
        color: '#71767B',
    },
    postText: {
        fontSize: 15,
        color: '#FFF',
        lineHeight: 20,
        marginBottom: 12,
    },
    postEngagement: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        maxWidth: 300,
    },
    engagementButton: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    engagementText: {
        fontSize: 13,
        color: '#71767B',
        marginLeft: 4,
    },
    activeEngagementText: {
        color: '#F91880',
    },
    repostIndicator: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 8,
    },
    repostText: {
        fontSize: 12,
        color: '#71767B',
        marginLeft: 2,
    },
    repostContainer: {
        marginTop: 8,
        borderLeftWidth: 2,
        borderLeftColor: '#71767B',
        paddingLeft: 12,
        opacity: 0.8,
    },
    parentPostContainer: {
        marginTop: 8,
        marginBottom: 8,
        borderLeftWidth: 2,
        borderLeftColor: '#1DA1F2',
        paddingLeft: 12,
        opacity: 0.9,
    },
    nestedPostContainer: {
        borderLeftWidth: 0,
        paddingLeft: 0,
        marginLeft: 0,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: '#2F3336',
        backgroundColor: '#0a0a0a',
        marginTop: 8,
    },
});

export default PostItem; 