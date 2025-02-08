import React, { useRef, useState, useEffect, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Animated, Easing, Share, ViewStyle, useColorScheme } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch } from "@/store/store";
import AnimatedNumbers from "react-native-animated-numbers";
import Avatar from "@/components/Avatar";
import { detectHashtags } from "./utils";
import { renderMedia, renderPoll, renderLocation } from "./renderers";
import QuotedPost from "./QuotedPost";
import { updateLikes, bookmarkPost, fetchBookmarkedPosts, likePost, unlikePost, setPosts } from "@/store/reducers/postsReducer";
import { Chat } from "@/assets/icons/chat-icon";
import { Bookmark, BookmarkActive } from "@/assets/icons/bookmark-icon";
import { RepostIcon } from "@/assets/icons/repost-icon";
import { HeartIcon, HeartIconActive } from "@/assets/icons/heart-icon";
import { CommentIcon, CommentIconActive } from "@/assets/icons/comment-icon";
import { colors } from "@/styles/colors";
import { Post as PostType } from "@/interfaces/Post";
import { getSocket } from '@/utils/socket';

interface PostProps {
    postData: PostType;
    style?: ViewStyle;
    quotedPost?: boolean;
    showActions?: boolean;
}

export default function Post({ postData, style, quotedPost }: PostProps) {
    const socket = getSocket();
    const dispatch = useDispatch<AppDispatch>();
    const post = useSelector((state: any) => state.posts.posts.find((p: any) => p.id === postData.id));
    const likesCount = post?._count?.likes || 0;
    const isLiked = post?.isLiked || false;
    const [_isBookmarked, setIsBookmarked] = useState(false);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [isReposted, setIsReposted] = useState(false);
    const [repostsCount, setRepostsCount] = useState(postData?._count?.reposts);
    const [bookmarksCount, setBookmarksCount] = useState(postData?._count?.bookmarks);
    const [repliesCount, setRepliesCount] = useState(postData?._count?.replies);

    const animatedScale = useRef(new Animated.Value(1)).current;
    const animatedOpacity = useRef(new Animated.Value(1)).current;
    const animatedRepostsCount = useRef(new Animated.Value(postData?._count?.reposts)).current;
    const animatedBookmarksCount = useRef(new Animated.Value(postData?._count?.bookmarks)).current;
    const animatedRepliesCount = useRef(new Animated.Value(postData?._count?.replies)).current;

    const colorScheme = useColorScheme();
    const isDarkMode = colorScheme === "dark";

    useEffect(() => {
        dispatch(fetchBookmarkedPosts() as any);
    }, [dispatch]);

    useEffect(() => {
        // Join the post's room for real-time updates
        socket.emit('joinPost', postData.id);

        // Listen for like updates
        socket.on('postLiked', (data: { postId: string; likesCount: number; isLiked: boolean }) => {
            if (data.postId === postData.id) {
                dispatch(setPosts((posts: PostType[]) => posts.map((post: PostType) => 
                    post.id === data.postId 
                        ? { ...post, _count: { ...post._count, likes: data.likesCount }, isLiked: data.isLiked }
                        : post
                )));
            }
        });

        socket.on('postUnliked', (data: { postId: string; likesCount: number; isLiked: boolean }) => {
            if (data.postId === postData.id) {
                dispatch(setPosts((posts: PostType[]) => posts.map((post: PostType) => 
                    post.id === data.postId 
                        ? { ...post, _count: { ...post._count, likes: data.likesCount }, isLiked: data.isLiked }
                        : post
                )));
            }
        });

        // Cleanup
        return () => {
            socket.emit('leavePost', postData.id);
            socket.off('postLiked');
            socket.off('postUnliked');
        };
    }, [postData.id, socket, dispatch]);

    const scaleAnimation = useCallback(() => {
        Animated.sequence([
            Animated.timing(animatedScale, { toValue: 1.2, duration: 150, easing: Easing.ease, useNativeDriver: true }),
            Animated.timing(animatedScale, { toValue: 1, duration: 150, easing: Easing.ease, useNativeDriver: true }),
        ]).start();
    }, [animatedScale]);

    const fadeAnimation = useCallback(() => {
        Animated.sequence([
            Animated.timing(animatedOpacity, { toValue: 0, duration: 150, easing: Easing.ease, useNativeDriver: true }),
            Animated.timing(animatedOpacity, { toValue: 1, duration: 150, easing: Easing.ease, useNativeDriver: true }),
        ]).start();
    }, [animatedOpacity]);

    const handleLike = useCallback((event: any) => {
        event.preventDefault();
        event.stopPropagation();
        if (isLiked) {
            dispatch(unlikePost(postData.id) as any)
                .then(() => {
                    scaleAnimation();
                    fadeAnimation();
                });
        } else {
            dispatch(likePost(postData.id) as any)
                .then(() => {
                    scaleAnimation();
                    fadeAnimation();
                });
        }
    }, [dispatch, postData.id, isLiked, scaleAnimation, fadeAnimation]);

    const handleShare = useCallback(async (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        try {
            await Share.share({
                message: `Check out this post: https://mention.earth/post/${postData.id}`,
                title: "Share Post",
            });
        } catch (error: any) {
            alert("Error sharing post: " + (error.message || error));
        }
    }, [postData.id]);

    const handleBookmark = useCallback((event: any) => {
        event.preventDefault();
        event.stopPropagation();
        setIsBookmarked((prev) => !prev);
        const newCount = _isBookmarked ? bookmarksCount - 1 : bookmarksCount + 1;
        setBookmarksCount(newCount);
        dispatch(bookmarkPost(postData.id) as any);
        Animated.timing(animatedBookmarksCount, { toValue: newCount, duration: 300, easing: Easing.linear, useNativeDriver: true }).start();
    }, [_isBookmarked, bookmarksCount, dispatch, postData.id, animatedBookmarksCount]);

    const handleRepost = useCallback((event: any) => {
        event.preventDefault();
        event.stopPropagation();
        setIsReposted((prev) => !prev);
        const newCount = isReposted ? repostsCount - 1 : repostsCount + 1;
        setRepostsCount(newCount);
        Animated.timing(animatedRepostsCount, { toValue: newCount, duration: 300, easing: Easing.linear, useNativeDriver: true }).start();
    }, [isReposted, repostsCount, animatedRepostsCount]);

    const handleReply = useCallback((event: any) => {
        event.preventDefault();
        event.stopPropagation();
        const newCount = repliesCount + 1;
        setRepliesCount(newCount);
        Animated.timing(animatedRepliesCount, { toValue: newCount, duration: 300, easing: Easing.linear, useNativeDriver: true }).start();
    }, [repliesCount, animatedRepliesCount]);

    const handlePollOptionPress = useCallback((index: number) => setSelectedOption(index), []);

    return (
        <View style={[styles.container, style, isDarkMode ? styles.darkContainer : styles.lightContainer]}>
            <View style={styles.topContainer}>
                <Link href={`/@${postData.author?.username}`} asChild>
                    <TouchableOpacity>
                        <Avatar id={postData.author?.avatar} size={40} />
                    </TouchableOpacity>
                </Link>
                <View style={{ flex: 1 }}>
                    <View style={styles.headerContainer}>
                        <View style={styles.headerData}>
                            <Link href={`/@${postData.author?.username}`} asChild>
                                <TouchableOpacity>
                                    <Text style={styles.authorName}>{postData.author?.name?.first} {postData.author?.name?.last}</Text>
                                </TouchableOpacity>
                            </Link>
                            <Link href={`/@${postData.author?.username}`} asChild>
                                <TouchableOpacity>
                                    <Text style={styles.authorUsername}>@{postData.author?.username}</Text>
                                </TouchableOpacity>
                            </Link>
                            <Text style={[styles.postTime]}>
                                · {new Date(postData.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </Text>
                        </View>
                        <Ionicons name="ellipsis-horizontal" size={20} color={isDarkMode ? colors.COLOR_BLACK_LIGHT_1 : colors.primaryColor} />
                    </View>
                    {postData?.text && (
                        <Text style={[styles.postContent, isDarkMode ? styles.darkText : styles.lightText]}>
                            {detectHashtags(postData.text)}
                        </Text>
                    )}
                </View>
            </View>
            <View style={styles.contentContainer}>
                {postData?.media && renderMedia(postData.media)}
                {renderPoll(undefined, selectedOption, handlePollOptionPress)}
                {renderLocation(undefined)}
                {!quotedPost && <QuotedPost id={postData.quoted_post_id ?? undefined} />}
                <View style={styles.actionsContainer}>
                    <TouchableOpacity style={styles.actionButton} onPress={handleLike}>
                        <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                            {isLiked ? <HeartIconActive size={20} color="#F91880" /> : <HeartIcon size={20} color="#536471" />}
                        </Animated.View>
                        <AnimatedNumbers includeComma animateToNumber={likesCount} animationDuration={300} fontStyle={{ color: isLiked ? "#F91880" : "#536471" }} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton} onPress={handleReply}>
                        {false ? <CommentIconActive size={20} color="#F91880" /> : <CommentIcon size={20} color="#536471" />}
                        <AnimatedNumbers includeComma animateToNumber={repliesCount} animationDuration={300} fontStyle={{ color: "#536471" }} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton} onPress={handleRepost}>
                        {isReposted ? <RepostIcon size={20} color="#1DA1F2" /> : <RepostIcon size={20} color="#536471" />}
                        <AnimatedNumbers includeComma animateToNumber={repostsCount} animationDuration={300} fontStyle={{ color: isReposted ? "#1DA1F2" : "#536471" }} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton} onPress={handleShare}>
                        <Ionicons name="share-outline" size={20} color="#536471" />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton} onPress={handleBookmark}>
                        {_isBookmarked ? <BookmarkActive size={20} color="#1DA1F2" /> : <Bookmark size={20} color="#536471" />}
                        <AnimatedNumbers includeComma animateToNumber={bookmarksCount} animationDuration={300} fontStyle={{ color: _isBookmarked ? "#1DA1F2" : "#536471" }} />
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.actionButton}>
                        <Chat size={20} color="#536471" />
                    </TouchableOpacity>
                </View>
            </View>
        </View>
    );
}

const postPaddingLeft = 62;

const styles = StyleSheet.create({
    container: {
        flexDirection: "column",
        borderBottomColor: "#e1e8ed",
        borderBottomWidth: 1,
        paddingVertical: 12,
    },
    darkContainer: { backgroundColor: "#000" },
    lightContainer: { backgroundColor: "#fff" },
    topContainer: {
        flexDirection: "row",
        gap: 10,
        paddingHorizontal: 12,
        alignItems: "flex-start",
    },
    contentContainer: { flex: 1 },
    headerContainer: { flexDirection: "row", alignItems: "center" },
    headerData: {
        flexDirection: "row",
        alignItems: "center",
        flex: 1,
        gap: 4,
    },
    authorName: { fontWeight: "bold" },
    authorUsername: { color: "#536471" },
    postTime: { color: "#536471" },
    postContent: { marginTop: 4, lineHeight: 20 },
    darkText: { color: "#fff" },
    lightText: { color: "#000" },
    actionsContainer: {
        flexDirection: "row",
        marginTop: 12,
        justifyContent: "space-between",
        maxWidth: 300,
        paddingLeft: postPaddingLeft,
    },
    actionButton: {
        flexDirection: "row",
        alignItems: "center",
        marginRight: 16,
        gap: 4,
    },
    actionText: { color: "#536471", fontSize: 13, marginLeft: 4 },
    likedText: { color: "#F91880" },
});
