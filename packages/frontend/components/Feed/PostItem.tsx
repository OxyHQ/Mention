import { Ionicons } from '@expo/vector-icons';
import React, { useState } from 'react';
import {
    Image,
    StyleSheet,
    Text,
    TouchableOpacity,
    View
} from 'react-native';

import { UIPost, Reply, FeedRepost as Repost, PostAction } from '@mention/shared-types';

interface PostItemProps {
    post: UIPost | Reply | Repost;
    onReply?: () => void;
    onRepost?: () => void;
    onLike?: () => void;
    onShare?: () => void;
}

const PostItem: React.FC<PostItemProps> = ({
    post,
    onReply,
    onRepost,
    onLike,
    onShare
}) => {
    const [isLiked, setIsLiked] = useState(false);
    const [isReposted, setIsReposted] = useState(false);

    const handleLike = () => {
        setIsLiked(!isLiked);
        onLike?.();
    };

    const handleRepost = () => {
        setIsReposted(!isReposted);
        onRepost?.();
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
                    <TouchableOpacity style={styles.engagementButton} onPress={onReply}>
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
                    <TouchableOpacity style={styles.engagementButton} onPress={onShare}>
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