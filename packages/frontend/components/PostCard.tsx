import React, { useState, useCallback, useEffect } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    Image,
    Dimensions,
    Alert
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { colors } from '../styles/colors';

interface PostCardProps {
    post: {
        id: string;
        user: {
            id: string;
            name: string;
            handle: string;
            avatar: string;
            verified: boolean;
        };
        content: {
            text: string;
            images?: string[];
        } | string;
        createdAt?: string;
        date?: string;
        stats?: {
            likesCount: number;
            repostsCount: number;
            commentsCount: number;
            viewsCount: number;
            sharesCount: number;
        };
        engagement?: {
            replies: number;
            reposts: number;
            likes: number;
        };
        media?: string[];
        isLiked?: boolean;
        isReposted?: boolean;
        isSaved?: boolean;
        type?: string;
        visibility?: string;
        hashtags?: string[];
        mentions?: string[];
        parentPostId?: string;
        threadId?: string;
        repostOf?: string;
        quoteOf?: string;
        isEdited?: boolean;
        language?: string;
    };
    onPostPress?: () => void;
    onUserPress?: () => void;
    onReplyPress?: () => void;
    onRepostPress?: () => void;
    onLikePress?: () => void;
    onSharePress?: () => void;
    onSavePress?: () => void;
}

const { width: screenWidth } = Dimensions.get('window');
const MAX_IMAGE_HEIGHT = 200;

const PostCard: React.FC<PostCardProps> = ({
    post,
    onPostPress,
    onUserPress,
    onReplyPress,
    onRepostPress,
    onLikePress,
    onSharePress,
    onSavePress
}) => {
    const [isLiked, setIsLiked] = useState(post.isLiked !== undefined ? post.isLiked : false);
    const [isReposted, setIsReposted] = useState(post.isReposted !== undefined ? post.isReposted : false);
    const [isSaved, setIsSaved] = useState(post.isSaved !== undefined ? post.isSaved : false);

    // Update local state when post props change
    useEffect(() => {
        setIsLiked(post.isLiked !== undefined ? post.isLiked : false);
        setIsReposted(post.isReposted !== undefined ? post.isReposted : false);
        setIsSaved(post.isSaved !== undefined ? post.isSaved : false);
    }, [post.isLiked, post.isReposted, post.isSaved]);

    // Format date
    const formatDate = useCallback((dateString: string) => {
        const date = new Date(dateString);
        const now = new Date();
        const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));

        if (diffInHours < 1) {
            const diffInMinutes = Math.floor((now.getTime() - date.getTime()) / (1000 * 60));
            return `${diffInMinutes}m`;
        } else if (diffInHours < 24) {
            return `${diffInHours}h`;
        } else {
            const diffInDays = Math.floor(diffInHours / 24);
            return `${diffInDays}d`;
        }
    }, []);

    // Handle like toggle
    const handleLikePress = useCallback(() => {
        setIsLiked(!isLiked);
        onLikePress?.();
    }, [isLiked, onLikePress]);

    // Handle repost toggle
    const handleRepostPress = useCallback(() => {
        setIsReposted(!isReposted);
        onRepostPress?.();
    }, [isReposted, onRepostPress]);

    // Handle save toggle
    const handleSavePress = useCallback(() => {
        setIsSaved(!isSaved);
        onSavePress?.();
    }, [isSaved, onSavePress]);

    // Handle post press
    const handlePostPress = useCallback(() => {
        onPostPress?.();
    }, [onPostPress]);

    // Handle user press
    const handleUserPress = useCallback(() => {
        onUserPress?.();
    }, [onUserPress]);

    // Handle reply press
    const handleReplyPress = useCallback(() => {
        onReplyPress?.();
    }, [onReplyPress]);

    // Handle share press
    const handleSharePress = useCallback(() => {
        onSharePress?.();
    }, [onSharePress]);

    // Render media content
    const renderMedia = useCallback(() => {
        if (!post.media || post.media.length === 0) return null;

        if (post.media.length === 1) {
            return (
                <Image
                    source={{ uri: post.media[0] }}
                    style={styles.singleMedia}
                    resizeMode="cover"
                />
            );
        }

        if (post.media.length === 2) {
            return (
                <View style={styles.twoMediaContainer}>
                    <Image
                        source={{ uri: post.media[0] }}
                        style={styles.twoMediaLeft}
                        resizeMode="cover"
                    />
                    <Image
                        source={{ uri: post.media[1] }}
                        style={styles.twoMediaRight}
                        resizeMode="cover"
                    />
                </View>
            );
        }

        if (post.media.length >= 3) {
            return (
                <View style={styles.fourMediaContainer}>
                    <View style={styles.fourMediaTop}>
                        <Image
                            source={{ uri: post.media[0] }}
                            style={styles.fourMediaTopLeft}
                            resizeMode="cover"
                        />
                        <Image
                            source={{ uri: post.media[1] }}
                            style={styles.fourMediaTopRight}
                            resizeMode="cover"
                        />
                    </View>
                    <View style={styles.fourMediaBottom}>
                        <Image
                            source={{ uri: post.media[2] }}
                            style={styles.fourMediaBottomLeft}
                            resizeMode="cover"
                        />
                        {post.media.length > 3 && (
                            <View style={styles.fourMediaBottomRight}>
                                <Image
                                    source={{ uri: post.media[3] }}
                                    style={styles.fourMediaBottomRightImage}
                                    resizeMode="cover"
                                />
                                {post.media.length > 4 && (
                                    <View style={styles.mediaOverlay}>
                                        <Text style={styles.mediaOverlayText}>+{post.media.length - 4}</Text>
                                    </View>
                                )}
                            </View>
                        )}
                    </View>
                </View>
            );
        }

        return null;
    }, [post.media]);

    return (
        <TouchableOpacity style={styles.container} onPress={handlePostPress} activeOpacity={0.9}>
            {/* User Info */}
            <View style={styles.userInfo}>
                <TouchableOpacity onPress={handleUserPress} style={styles.avatarContainer}>
                    <Image source={{ uri: post.user.avatar }} style={styles.avatar} />
                    {post.user.verified && (
                        <View style={styles.verifiedBadge}>
                            <Ionicons name="checkmark-circle" size={16} color={colors.primaryColor} />
                        </View>
                    )}
                </TouchableOpacity>

                <View style={styles.userDetails}>
                    <TouchableOpacity onPress={handleUserPress}>
                        <Text style={styles.userName}>{post.user.name}</Text>
                    </TouchableOpacity>
                    <Text style={styles.userHandle}>@{post.user.handle}</Text>
                </View>

                <Text style={styles.timestamp}>{formatDate(post.createdAt || post.date)}</Text>
            </View>

            {/* Post Content */}
            <View style={styles.content}>
                <Text style={styles.postText}>{post.content?.text || post.content}</Text>
                {renderMedia()}
            </View>

            {/* Engagement Stats */}
            <View style={styles.engagement}>
                <TouchableOpacity style={styles.engagementItem} onPress={handleReplyPress}>
                    <Ionicons name="chatbubble-outline" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                    <Text style={styles.engagementText}>{post.stats?.commentsCount || post.engagement?.replies || 0}</Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.engagementItem} onPress={handleRepostPress}>
                    <Ionicons
                        name={isReposted ? "repeat" : "repeat-outline"}
                        size={20}
                        color={isReposted ? colors.online : colors.COLOR_BLACK_LIGHT_4}
                    />
                    <Text style={[styles.engagementText, isReposted && styles.engagementTextActive]}>
                        {post.stats?.repostsCount || post.engagement?.reposts || 0}
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.engagementItem} onPress={handleLikePress}>
                    <Ionicons
                        name={isLiked ? "heart" : "heart-outline"}
                        size={20}
                        color={isLiked ? colors.busy : colors.COLOR_BLACK_LIGHT_4}
                    />
                    <Text style={[styles.engagementText, isLiked && styles.engagementTextActive]}>
                        {post.stats?.likesCount || post.engagement?.likes || 0}
                    </Text>
                </TouchableOpacity>

                <TouchableOpacity style={styles.engagementItem} onPress={handleSharePress}>
                    <Ionicons name="share-outline" size={20} color={colors.COLOR_BLACK_LIGHT_4} />
                </TouchableOpacity>

                <TouchableOpacity style={styles.engagementItem} onPress={handleSavePress}>
                    <Ionicons
                        name={isSaved ? "bookmark" : "bookmark-outline"}
                        size={20}
                        color={isSaved ? colors.primaryColor : colors.COLOR_BLACK_LIGHT_4}
                    />
                </TouchableOpacity>
            </View>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    container: {
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_7,
        padding: 16,
    },
    userInfo: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    avatarContainer: {
        position: 'relative',
        marginRight: 12,
    },
    avatar: {
        width: 40,
        height: 40,
        borderRadius: 20,
    },
    verifiedBadge: {
        position: 'absolute',
        bottom: -2,
        right: -2,
        backgroundColor: colors.COLOR_BLACK_LIGHT_9,
        borderRadius: 8,
    },
    userDetails: {
        flex: 1,
    },
    userName: {
        fontSize: 16,
        fontWeight: '600',
        color: colors.COLOR_BLACK_LIGHT_1,
        marginBottom: 2,
    },
    userHandle: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    timestamp: {
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    content: {
        marginBottom: 16,
    },
    postText: {
        fontSize: 16,
        lineHeight: 22,
        color: colors.COLOR_BLACK_LIGHT_1,
        marginBottom: 0,
    },
    singleMedia: {
        width: '100%',
        height: MAX_IMAGE_HEIGHT,
        borderRadius: 12,
    },
    twoMediaContainer: {
        flexDirection: 'row',
        gap: 4,
    },
    twoMediaLeft: {
        flex: 1,
        height: MAX_IMAGE_HEIGHT,
        borderRadius: 12,
    },
    twoMediaRight: {
        flex: 1,
        height: MAX_IMAGE_HEIGHT,
        borderRadius: 12,
    },
    fourMediaContainer: {
        gap: 4,
    },
    fourMediaTop: {
        flexDirection: 'row',
        gap: 4,
    },
    fourMediaTopLeft: {
        flex: 1,
        height: MAX_IMAGE_HEIGHT / 2,
        borderRadius: 12,
    },
    fourMediaTopRight: {
        flex: 1,
        height: MAX_IMAGE_HEIGHT / 2,
        borderRadius: 12,
    },
    fourMediaBottom: {
        flexDirection: 'row',
        gap: 4,
    },
    fourMediaBottomLeft: {
        flex: 1,
        height: MAX_IMAGE_HEIGHT / 2,
        borderRadius: 12,
    },
    fourMediaBottomRight: {
        flex: 1,
        height: MAX_IMAGE_HEIGHT / 2,
        borderRadius: 12,
        position: 'relative',
    },
    fourMediaBottomRightImage: {
        width: '100%',
        height: '100%',
        borderRadius: 12,
    },
    mediaOverlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        borderRadius: 12,
        justifyContent: 'center',
        alignItems: 'center',
    },
    mediaOverlayText: {
        color: colors.COLOR_BLACK_LIGHT_9,
        fontSize: 18,
        fontWeight: '600',
    },
    engagement: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 8,
    },
    engagementItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 20,
    },
    engagementText: {
        marginLeft: 6,
        fontSize: 14,
        color: colors.COLOR_BLACK_LIGHT_4,
    },
    engagementTextActive: {
        color: colors.COLOR_BLACK_LIGHT_1,
        fontWeight: '600',
    },
});

export default PostCard;
