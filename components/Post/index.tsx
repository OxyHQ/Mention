import React, { useRef, useState, useEffect, useCallback } from "react";
import { View, Text, TouchableOpacity, Animated, Easing, Share, ViewStyle, useColorScheme } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useDispatch, useSelector } from "react-redux";
import { AppDispatch } from "@/store/store";
import AnimatedNumbers from "react-native-animated-numbers";
import Avatar from "@/components/Avatar";
import { detectHashtags } from "./utils";
import { renderMedia, renderPoll, renderLocation } from "./renderers";
import QuotedPost from "./QuotedPost";
import { updateLikes, bookmarkPost, fetchBookmarkedPosts, likePost, unlikePost, setPosts, updatePostLikes, createReply } from "@/store/reducers/postsReducer";
import { Chat } from "@/assets/icons/chat-icon";
import { Bookmark, BookmarkActive } from "@/assets/icons/bookmark-icon";
import { RepostIcon } from "@/assets/icons/repost-icon";
import { HeartIcon, HeartIconActive } from "@/assets/icons/heart-icon";
import { CommentIcon, CommentIconActive } from "@/assets/icons/comment-icon";
import { colors } from "@/styles/colors";
import { Post as PostType } from "@/interfaces/Post";
import { getSocket } from '@/utils/socket';
import { RootState } from "@/store/store";
import { Socket } from 'socket.io-client';
import { router } from "expo-router";
import { getReconnectDelay } from '@/utils/socketConfig';

interface PostProps {
    postData: PostType;
    style?: ViewStyle;
    quotedPost?: boolean;
    showActions?: boolean;
    className?: string;
}

const maxSocketInitAttempts = 5;

export default function Post({ postData, quotedPost, className, showActions = true }: PostProps) {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [socketError, setSocketError] = useState<string | null>(null);
    const socketInitAttemptsRef = useRef(0);
    const socketInitTimeoutRef = useRef<NodeJS.Timeout>();
    const mounted = useRef(true);
    const dispatch = useDispatch<AppDispatch>();
    const allPosts = useSelector((state: RootState) => state.posts.posts);
    const post = allPosts.find((p) => p.id === postData.id) || postData;
    const likesCount = post?._count?.likes || 0;
    const isLiked = post?.isLiked || false;
    const [_isBookmarked, setIsBookmarked] = useState(false);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [isReposted, setIsReposted] = useState(false);
    const [repostsCount, setRepostsCount] = useState(postData?._count?.reposts || 0);
    const [bookmarksCount, setBookmarksCount] = useState(postData?._count?.bookmarks || 0);
    const [repliesCount, setRepliesCount] = useState(postData?._count?.replies || 0);

    const animatedScale = useRef(new Animated.Value(1)).current;
    const animatedOpacity = useRef(new Animated.Value(1)).current;
    const animatedRepostsCount = useRef(new Animated.Value(postData?._count?.reposts || 0)).current;
    const animatedBookmarksCount = useRef(new Animated.Value(postData?._count?.bookmarks || 0)).current;
    const animatedRepliesCount = useRef(new Animated.Value(postData?._count?.replies || 0)).current;

    const colorScheme = useColorScheme();
    const isDarkMode = colorScheme === "dark";

    useEffect(() => {
        dispatch(fetchBookmarkedPosts() as any);
    }, [dispatch]);

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

    const initSocket = async () => {
        try {
            if (socketInitAttemptsRef.current >= maxSocketInitAttempts) {
                setSocketError('Max connection attempts reached');
                return;
            }

            const socketInstance = await getSocket('posts');
            if (!mounted.current) return;

            if (socketInstance) {
                console.log('Socket initialized for post:', postData.id);
                setSocket(socketInstance);
                setSocketError(null);
                socketInitAttemptsRef.current = 0;

                // Join the post's room
                socketInstance.emit('joinPost', postData.id);
            } else {
                socketInitAttemptsRef.current++;
                if (mounted.current) {
                    const delay = getReconnectDelay(socketInitAttemptsRef.current);
                    socketInitTimeoutRef.current = setTimeout(initSocket, delay);
                }
            }
        } catch (error) {
            console.error('Error initializing socket:', error);
            if (mounted.current) {
                socketInitAttemptsRef.current++;
                setSocketError(error instanceof Error ? error.message : 'Connection failed');
                
                if (socketInitAttemptsRef.current < maxSocketInitAttempts) {
                    const delay = getReconnectDelay(socketInitAttemptsRef.current);
                    socketInitTimeoutRef.current = setTimeout(initSocket, delay);
                }
            }
        }
    };

    useEffect(() => {
        mounted.current = true;
        initSocket();
        
        return () => {
            mounted.current = false;
            if (socketInitTimeoutRef.current) {
                clearTimeout(socketInitTimeoutRef.current);
            }
            if (socket) {
                socket.emit('leavePost', postData.id);
                socket.disconnect();
            }
        };
    }, [postData.id]);

    // Handle socket events
    useEffect(() => {
        if (!socket) return;

        const handleError = (error: Error) => {
            console.error('Socket error:', error);
            setSocketError(error.message);
        };

        const handleConnect = () => {
            console.log('Socket connected for post:', postData.id);
            setSocketError(null);
            socket.emit('joinPost', postData.id);
        };

        const handleDisconnect = (reason: string) => {
            console.log('Socket disconnected:', reason);
            if (reason === 'io server disconnect' || reason === 'transport close') {
                socket.connect();
            }
            setSocketError('Disconnected from server');
        };

        const handlePostLiked = (data: any) => {
            if (data.postId === postData.id) {
                dispatch({
                    type: 'posts/updatePost',
                    payload: {
                        id: postData.id,
                        changes: {
                            _count: data._count,
                            isLiked: data.isLiked
                        }
                    }
                });
            }
        };

        const handlePostUnliked = (data: any) => {
            if (data.postId === postData.id) {
                dispatch({
                    type: 'posts/updatePost',
                    payload: {
                        id: postData.id,
                        changes: {
                            _count: data._count,
                            isLiked: data.isLiked
                        }
                    }
                });
            }
        };

        socket.on('error', handleError);
        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);
        socket.on('connect_error', handleError);
        socket.on('postLiked', handlePostLiked);
        socket.on('postUnliked', handlePostUnliked);

        return () => {
            socket.off('error', handleError);
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
            socket.off('connect_error', handleError);
            socket.off('postLiked', handlePostLiked);
            socket.off('postUnliked', handlePostUnliked);
        };
    }, [socket, postData.id, dispatch]);

    const handleLike = useCallback(async (event: any) => {
        event.preventDefault();
        event.stopPropagation();
        try {
            if (isLiked) {
                console.log('Unliking post:', postData.id);
                await dispatch(unlikePost(postData.id) as any);
            } else {
                console.log('Liking post:', postData.id);
                await dispatch(likePost(postData.id) as any);
            }
        } catch (error) {
            console.error('Error handling like:', error);
        }
    }, [dispatch, postData.id, isLiked]);

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
        // Navigate to the post screen where user can create a reply
        router.push(`/post/${postData.id}`);
    }, [postData.id]);

    const handlePollOptionPress = useCallback((index: number) => setSelectedOption(index), []);

    return (
        <View 
            className={`flex flex-col border-b border-gray-200 py-3 ${
                isDarkMode ? 'bg-black' : 'bg-white'
            } ${className}`}
        >
            <View className="flex-row gap-2.5 px-3 items-start">
                <Link href={`/@${postData.author?.username}`} asChild>
                    <TouchableOpacity>
                        <Avatar id={postData.author?.avatar} size={40} />
                    </TouchableOpacity>
                </Link>
                <View className="flex-1">
                    <View className="flex-row items-center">
                        <View className="flex-row items-center flex-1 gap-1">
                            <Link href={`/@${postData.author?.username}`} asChild>
                                <TouchableOpacity>
                                    <Text className="font-bold">{postData.author?.name?.first} {postData.author?.name?.last}</Text>
                                </TouchableOpacity>
                            </Link>
                            <Link href={`/@${postData.author?.username}`} asChild>
                                <TouchableOpacity>
                                    <Text className="text-gray-500">@{postData.author?.username}</Text>
                                </TouchableOpacity>
                            </Link>
                            <Text className="text-gray-500">
                                · {new Date(postData.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </Text>
                        </View>
                        <Ionicons name="ellipsis-horizontal" size={20} color={isDarkMode ? colors.COLOR_BLACK_LIGHT_1 : colors.primaryColor} />
                    </View>
                    {postData?.text && (
                        <Text className={`mt-1 leading-5 ${isDarkMode ? 'text-white' : 'text-black'}`}>
                            {detectHashtags(postData.text)}
                        </Text>
                    )}
                </View>
            </View>
            <View className="flex-1">
                {postData?.media && renderMedia(postData.media)}
                {renderPoll(undefined, selectedOption, handlePollOptionPress)}
                {renderLocation(undefined)}
                {!quotedPost && <QuotedPost id={postData.quoted_post_id ?? undefined} />}
                {showActions && (
                    <View className="flex-row mt-3 justify-between max-w-[300px] pl-[62px]">
                        <TouchableOpacity className="flex-row items-center mr-4 gap-1" onPress={handleLike}>
                            <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                {isLiked ? <HeartIconActive size={20} color="#F91880" /> : <HeartIcon size={20} color="#536471" />}
                            </Animated.View>
                            <AnimatedNumbers includeComma animateToNumber={likesCount} animationDuration={300} fontStyle={{ color: isLiked ? "#F91880" : "#536471" }} />
                        </TouchableOpacity>
                        <TouchableOpacity className="flex-row items-center mr-4 gap-1" onPress={handleReply}>
                            {false ? <CommentIconActive size={20} color="#F91880" /> : <CommentIcon size={20} color="#536471" />}
                            <AnimatedNumbers includeComma animateToNumber={repliesCount} animationDuration={300} fontStyle={{ color: "#536471" }} />
                        </TouchableOpacity>
                        <TouchableOpacity className="flex-row items-center mr-4 gap-1" onPress={handleRepost}>
                            {isReposted ? <RepostIcon size={20} color="#1DA1F2" /> : <RepostIcon size={20} color="#536471" />}
                            <AnimatedNumbers includeComma animateToNumber={repostsCount} animationDuration={300} fontStyle={{ color: isReposted ? "#1DA1F2" : "#536471" }} />
                        </TouchableOpacity>
                        <TouchableOpacity className="flex-row items-center mr-4 gap-1" onPress={handleShare}>
                            <Ionicons name="share-outline" size={20} color="#536471" />
                        </TouchableOpacity>
                        <TouchableOpacity className="flex-row items-center mr-4 gap-1" onPress={handleBookmark}>
                            {_isBookmarked ? <BookmarkActive size={20} color="#1DA1F2" /> : <Bookmark size={20} color="#536471" />}
                            <AnimatedNumbers includeComma animateToNumber={bookmarksCount} animationDuration={300} fontStyle={{ color: _isBookmarked ? "#1DA1F2" : "#536471" }} />
                        </TouchableOpacity>
                        <TouchableOpacity className="flex-row items-center gap-1">
                            <Chat size={20} color="#536471" />
                        </TouchableOpacity>
                    </View>
                )}
            </View>
        </View>
    );
}
