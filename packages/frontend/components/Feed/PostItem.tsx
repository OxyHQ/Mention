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
}

const PostItem: React.FC<PostItemProps> = ({
    post
}) => {
    const router = useRouter();
    const { likePost, unlikePost, repostPost, unrepostPost, savePost, unsavePost } = usePostsStore();
    // Use the actual data from the post instead of local state
    const isLiked = 'isLiked' in post ? (post.isLiked !== undefined ? post.isLiked : false) : false;
    const isReposted = 'isReposted' in post ? (post.isReposted !== undefined ? post.isReposted : false) : false;
    const isSaved = 'isSaved' in post ? (post.isSaved !== undefined ? post.isSaved : false) : false;


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
            const shareMessage = post.content
                ? `${post.user.name} (@${post.user.handle}): ${post.content}`
                : `${post.user.name} (@${post.user.handle})`;

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

    return (
        <View style={styles.postContainer}>
            <Image source={{ uri: post?.user?.avatar }} style={styles.postAvatar} />
            <View style={styles.postContent}>
                <View style={styles.postHeader}>
                    <Text style={styles.postUserName}>
                        {post.user?.name}
                        {post.user?.verified && (
                            <Ionicons name="checkmark-circle" size={16} color="#1DA1F2" style={styles.verifiedIcon} />
                        )}
                    </Text>
                    <Text style={styles.postHandle}>@{post.user?.handle}</Text>
                    <Text style={styles.postDate}>· {post.date}</Text>
                    {'originalPostId' in post && (
                        <View style={styles.repostIndicator}>
                            <Ionicons name="repeat" size={12} color="#71767B" />
                            <Text style={styles.repostText}>Reposted</Text>
                        </View>
                    )}
                </View>
                {'content' in post && post.content && (
                    <Text style={styles.postText}>{post.content}</Text>
                )}
                <View style={styles.postEngagement}>
                    <TouchableOpacity style={styles.engagementButton} onPress={handleReply}>
                        <Ionicons name="chatbubble-outline" size={18} color="#71767B" />
                        <Text style={styles.engagementText}>{post.engagement?.replies}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.engagementButton} onPress={handleRepost}>
                        <Ionicons
                            name={isReposted ? "repeat" : "repeat-outline"}
                            size={18}
                            color={isReposted ? "#00BA7C" : "#71767B"}
                        />
                        <Text style={[styles.engagementText, isReposted && styles.activeEngagementText]}>
                            {post.engagement?.reposts}
                        </Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.engagementButton} onPress={handleLike}>
                        <Ionicons
                            name={isLiked ? "heart" : "heart-outline"}
                            size={18}
                            color={isLiked ? "#F91880" : "#71767B"}
                        />
                        <Text style={[styles.engagementText, isLiked && styles.activeEngagementText]}>
                            {post.engagement?.likes}
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
});

export default PostItem; 