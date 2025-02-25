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
import { Chat } from "@/assets/icons/chat-icon";
import { Bookmark, BookmarkActive } from "@/assets/icons/bookmark-icon";
import { RepostIcon, RepostIconActive } from "@/assets/icons/repost-icon";
import { HeartIcon, HeartIconActive } from "@/assets/icons/heart-icon";
import { CommentIcon, CommentIconActive } from "@/assets/icons/comment-icon";
import { colors } from "@/styles/colors";
import { Post as PostType } from "@/interfaces/Post";
import { getSocket } from '@/utils/socket';
import { RootState } from "@/store/store";
import { Socket } from 'socket.io-client';
import { router } from "expo-router";
import { getReconnectDelay } from '@/utils/socketConfig';
import { fetchData, postData } from "@/utils/api";
import { ShareIcon } from "@/assets/icons/share-icon";
import { SOCKET_URL } from "@/config";
import io from 'socket.io-client';
import api from "@/utils/api";
import { getData } from '@/utils/storage';
import { toast } from "sonner";

interface PostProps {
    postData: PostType;
    style?: ViewStyle;
    quotedPost?: boolean;
    showActions?: boolean;
    className?: string;
}

interface PollOption {
    id: string;
    text: string;
    votes: number;
}

interface Poll {
    id: string;
    question: string;
    options: PollOption[];
    totalVotes: number;
    endsAt: string;
    voted?: boolean;
}

interface APIResponse<T> {
    success: boolean;
    data: T;
}

const maxSocketInitAttempts = 5;

export default function Post({ postData, quotedPost, className, style, showActions = true }: PostProps) {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [socketError, setSocketError] = useState<string | null>(null);
    const [isLiked, setIsLiked] = useState(postData.isLiked || false);
    const [likesCount, setLikesCount] = useState(postData._count?.likes || 0);
    const [repliesCount, setRepliesCount] = useState(postData._count?.replies || 0);
    const [isReposted, setIsReposted] = useState(postData.isReposted || false);
    const [repostsCount, setRepostsCount] = useState(postData._count?.reposts || 0);
    const [selectedOption, setSelectedOption] = useState<string | null>(null);
    const [poll, setPoll] = useState<Poll | null>(null);
    const [pollLoading, setPollLoading] = useState(false);
    const socketInitAttemptsRef = useRef(0);
    const socketInitTimeoutRef = useRef<NodeJS.Timeout>();
    const mounted = useRef(true);
    const dispatch = useDispatch<AppDispatch>();
    const animatedScale = useRef(new Animated.Value(1)).current;
    const colorScheme = useColorScheme();
    const isDarkMode = colorScheme === 'dark';
    const [isBookmarked, setIsBookmarked] = useState(postData.isBookmarked || false);
    const [bookmarksCount, setBookmarksCount] = useState(postData._count?.bookmarks || 0);

    // Debug post data structure
    useEffect(() => {
        if (__DEV__ && !quotedPost) {
            // Only log for main posts, not quoted posts to avoid excessive logging
            console.log(`Post component received data for post ${postData.id}:`, {
                hasAuthor: !!postData.author,
                authorType: postData.author ? typeof postData.author : 'undefined',
                authorFields: postData.author ? Object.keys(postData.author) : [],
                authorName: postData.author?.name,
                authorUsername: postData.author?.username,
                hasQuotedPost: !!postData.quoted_post,
                hasRepostOf: !!postData.repost_of,
                quotedPostAuthor: postData.quoted_post?.author?.username,
                repostOfAuthor: postData.repost_of?.author?.username
            });
        }
    }, [postData.id, quotedPost]);

    useEffect(() => {
        if (postData.metadata) {
            try {
                const metadata = JSON.parse(postData.metadata);
                if (metadata.poll) {
                    setPoll(metadata.poll);
                    if (metadata.poll.voted) {
                        setSelectedOption(metadata.poll.voted);
                    }
                }
            } catch (error) {
                console.error('Error parsing post metadata:', error);
            }
        }
    }, [postData.metadata]);

    useEffect(() => {
        if (postData.id) {
            const initSocket = async () => {
                try {
                    const accessToken = await getData('accessToken');
                    console.log('Initializing socket for post:', postData.id);
                    const socket = io(`${SOCKET_URL}/api/posts`, {
                        query: {
                            postId: postData.id
                        },
                        auth: {
                            token: accessToken
                        },
                        reconnectionAttempts: maxSocketInitAttempts,
                        reconnectionDelay: 1000,
                        reconnectionDelayMax: 5000,
                        timeout: 10000
                    });

                    socket.on('connect', () => {
                        console.log('Socket connected for post:', postData.id);
                        socket.emit('joinPost', postData.id);
                        setSocketError(null);
                    });

                    socket.on('connect_error', (error) => {
                        console.error('Socket connection error:', error);
                        setSocketError(error.message);
                    });

                    socket.on('postUpdate', (data: {
                        type: string;
                        postId: string;
                        userId: string;
                        _count: {
                            likes: number;
                            reposts: number;
                            replies: number;
                            bookmarks: number;
                        }
                    }) => {
                        console.log('Received post update:', data);
                        if (data.postId === postData.id) {
                            if (data._count) {
                                setLikesCount(data._count.likes);
                                setRepliesCount(data._count.replies);
                                setRepostsCount(data._count.reposts);
                                setBookmarksCount(data._count.bookmarks);
                            }
                        }
                    });

                    setSocket(socket);
                } catch (error) {
                    console.error('Error initializing socket:', error);
                    setSocketError(error instanceof Error ? error.message : 'Failed to initialize socket');
                }
            };

            initSocket();

            return () => {
                console.log('Cleaning up socket for post:', postData.id);
                if (socket) {
                    socket.emit('leavePost', postData.id);
                    socket.disconnect();
                }
            };
        }
    }, [postData.id]);

    // Update local state when postData changes
    useEffect(() => {
        setIsLiked(postData.isLiked || false);
        setIsReposted(postData.isReposted || false);
        setIsBookmarked(postData.isBookmarked || false);
        setLikesCount(postData._count?.likes || 0);
        setRepliesCount(postData._count?.replies || 0);
        setRepostsCount(postData._count?.reposts || 0);
        setBookmarksCount(postData._count?.bookmarks || 0);
    }, [postData]);

    const handlePollOptionPress = async (optionId: string) => {
        if (!poll || selectedOption || pollLoading) return;

        try {
            setPollLoading(true);
            const response = await fetchData<APIResponse<Poll>>(`polls/${poll.id}/vote`, {
                params: { optionId }
            });

            if (response.data.success) {
                setSelectedOption(optionId);
                setPoll(prevPoll => {
                    if (!prevPoll) return null;
                    return {
                        ...prevPoll,
                        options: prevPoll.options.map(option => ({
                            ...option,
                            votes: option.id === optionId ? option.votes + 1 : option.votes
                        })),
                        totalVotes: prevPoll.totalVotes + 1,
                        voted: true
                    };
                });
            }
        } catch (error) {
            console.error('Error voting in poll:', error);
        } finally {
            setPollLoading(false);
        }
    };

    const handleLike = async () => {
        try {
            const newIsLiked = !isLiked;
            setIsLiked(newIsLiked);
            setLikesCount(prev => prev + (newIsLiked ? 1 : -1));

            Animated.sequence([
                Animated.spring(animatedScale, {
                    toValue: 1.2,
                    useNativeDriver: true,
                }),
                Animated.spring(animatedScale, {
                    toValue: 1,
                    useNativeDriver: true,
                }),
            ]).start();

            if (newIsLiked) {
                await api.post(`posts/${postData.id}/like`);
            } else {
                await api.delete(`posts/${postData.id}/like`);
            }
        } catch (error) {
            console.error('Error liking post:', error);
            setIsLiked(prev => !prev);
            setLikesCount(prev => prev + (isLiked ? 1 : -1));
        }
    };

    const handleReply = () => {
        router.push(`/post/${postData.id}/reply`);
    };

    const handleRepost = async () => {
        try {
            const newIsReposted = !isReposted;
            setIsReposted(newIsReposted);
            setRepostsCount(prev => prev + (newIsReposted ? 1 : -1));

            Animated.sequence([
                Animated.spring(animatedScale, {
                    toValue: 1.2,
                    useNativeDriver: true,
                }),
                Animated.spring(animatedScale, {
                    toValue: 1,
                    useNativeDriver: true,
                }),
            ]).start();

            if (newIsReposted) {
                await api.post(`posts/${postData.id}/repost`, {
                    text: "",
                    repost_of: postData.id
                });
            } else {
                await api.delete(`posts/${postData.id}/repost`);
            }
        } catch (error) {
            console.error('Error reposting:', error);
            setIsReposted(prev => !prev);
            setRepostsCount(prev => prev + (isReposted ? 1 : -1));
        }
    };

    const handleQuote = () => {
        router.push(`/post/${postData.id}/quote`);
    };

    const handleShare = async () => {
        try {
            await Share.share({
                message: `${postData.text}\n\nShared from Mention`,
                url: `https://mention.earth/post/${postData.id}`
            });
        } catch (error) {
            console.error('Error sharing post:', error);
        }
    };

    const handleBookmark = async () => {
        try {
            const newIsBookmarked = !isBookmarked;
            setIsBookmarked(newIsBookmarked);
            setBookmarksCount(prev => prev + (newIsBookmarked ? 1 : -1));

            Animated.sequence([
                Animated.spring(animatedScale, {
                    toValue: 1.2,
                    useNativeDriver: true,
                }),
                Animated.spring(animatedScale, {
                    toValue: 1,
                    useNativeDriver: true,
                }),
            ]).start();

            // Get the current access token to ensure it's fresh
            const accessToken = await getData('accessToken');
            if (!accessToken) {
                throw new Error('Authentication required');
            }

            // Make sure we're using the configured API with proper auth headers
            if (newIsBookmarked) {
                await api.post(`posts/${postData.id}/bookmark`);
                console.log('Successfully bookmarked post:', postData.id);
            } else {
                await api.delete(`posts/${postData.id}/bookmark`);
                console.log('Successfully removed bookmark from post:', postData.id);
            }
        } catch (error: any) {
            console.error('Error bookmarking post:', error);

            // Show error message to user
            if (error.response?.data?.message) {
                toast.error(`Bookmark failed: ${error.response.data.message}`);
            } else {
                toast.error('Failed to bookmark post. Please try again.');
            }

            // Revert the optimistic update if the API call fails
            setIsBookmarked(prev => !prev);
            setBookmarksCount(prev => prev + (isBookmarked ? 1 : -1));
        }
    };

    const renderPoll = () => {
        if (!poll) return null;

        const totalVotes = poll.totalVotes;
        const isPollEnded = new Date(poll.endsAt) < new Date();
        const showResults = selectedOption !== null || isPollEnded;

        return (
            <View className="mt-4 bg-gray-50 rounded-lg p-4">
                <Text className="font-medium mb-2">{poll.question}</Text>
                {poll.options.map(option => {
                    const percentage = totalVotes > 0 ? (option.votes / totalVotes) * 100 : 0;

                    return (
                        <TouchableOpacity
                            key={option.id}
                            onPress={() => handlePollOptionPress(option.id)}
                            disabled={showResults || pollLoading}
                            className={`
                                mt-2 p-3 rounded-lg border
                                ${selectedOption === option.id ? 'border-primary bg-primary/10' : 'border-gray-200'}
                                ${showResults ? 'relative overflow-hidden' : ''}
                            `}
                        >
                            {showResults && (
                                <View
                                    className="absolute left-0 top-0 bottom-0 bg-primary/10"
                                    style={{ width: `${percentage}%` }}
                                />
                            )}
                            <View className="flex-row justify-between items-center relative z-10">
                                <Text>{option.text}</Text>
                                {showResults && (
                                    <Text className="text-sm text-gray-500">{percentage.toFixed(1)}%</Text>
                                )}
                            </View>
                        </TouchableOpacity>
                    );
                })}
                <Text className="text-sm text-gray-500 mt-2">
                    {totalVotes} votes • {isPollEnded ? 'Final results' : 'Poll ends ' + new Date(poll.endsAt).toLocaleDateString()}
                </Text>
            </View>
        );
    };

    return (
        <View className={`flex flex-col py-3 ${isDarkMode ? 'bg-black' : 'bg-white'} ${className}`} style={style}>
            {postData.repost_of && (
                <View className="flex-row items-center px-3 mb-2">
                    <RepostIcon size={16} color="#536471" />
                    <Text className="text-gray-500 ml-2">{postData.author?.name?.first} Reposted</Text>
                </View>
            )}
            <View className="flex-row gap-2.5 px-3 items-start">
                <Link href={`/@${postData.author?.username}`} asChild>
                    <TouchableOpacity onPress={(e) => e.stopPropagation()}>
                        <Avatar id={postData.author?.avatar} size={40} />
                    </TouchableOpacity>
                </Link>
                <View className="flex-1">
                    <Link href={`/post/${postData.id}`} asChild>
                        <TouchableOpacity className="flex-1" activeOpacity={0.7}>
                            <View className="flex-row items-center">
                                <View className="flex-row items-center flex-1 gap-1">
                                    <Link href={`/@${postData.author?.username}`} asChild>
                                        <TouchableOpacity onPress={(e) => e.stopPropagation()}>
                                            <Text className="font-bold">{postData.author?.name?.first} {postData.author?.name?.last}</Text>
                                        </TouchableOpacity>
                                    </Link>
                                    <Link href={`/@${postData.author?.username}`} asChild>
                                        <TouchableOpacity onPress={(e) => e.stopPropagation()}>
                                            <Text className="text-gray-500">@{postData.author?.username}</Text>
                                        </TouchableOpacity>
                                    </Link>
                                    <Text className="text-gray-500">
                                        · {new Date(postData.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                    </Text>
                                </View>
                                <TouchableOpacity onPress={(e) => e.stopPropagation()}>
                                    <Ionicons name="ellipsis-horizontal" size={20} color={colors.primaryColor} />
                                </TouchableOpacity>
                            </View>
                            {postData?.text && (
                                <Text className={`mt-1 leading-5`}>
                                    {detectHashtags(postData.text)}
                                </Text>
                            )}
                        </TouchableOpacity>
                    </Link>
                </View>
            </View>
            <View className="flex-1">
                <TouchableOpacity className="flex-1" activeOpacity={0.7}>
                    {postData?.media && renderMedia(postData.media)}
                    <View className="flex-1 px-3 pl-[62px]">
                        {renderPoll()}
                        {renderLocation(undefined)}
                        {!quotedPost && postData.quoted_post && (
                            <View className="mt-3 border border-gray-200 rounded-2xl overflow-hidden">
                                <Post postData={postData.quoted_post} quotedPost={true} showActions={false} />
                            </View>
                        )}
                        {!quotedPost && postData.repost_of && (
                            <View className="mt-3 border border-gray-200 rounded-2xl overflow-hidden">
                                <Post postData={postData.repost_of} quotedPost={true} showActions={false} />
                            </View>
                        )}
                    </View>
                </TouchableOpacity>
            </View>
            {showActions && (
                <View className="flex-row mt-3 justify-between max-w-[400px] pl-[62px]">
                    <TouchableOpacity
                        className="flex-row items-center mr-4 gap-1"
                        onPress={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleReply();
                        }}
                    >
                        {false ? <CommentIconActive size={20} color="#F91880" /> : <CommentIcon size={20} color="#536471" />}
                        <AnimatedNumbers includeComma animateToNumber={repliesCount} animationDuration={300} fontStyle={{ color: "#536471" }} />
                    </TouchableOpacity>
                    <View className="flex-row items-center mr-4 gap-1">
                        <TouchableOpacity
                            onPress={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleRepost();
                            }}
                        >
                            {isReposted ? <RepostIconActive size={20} color="#00BA7C" /> : <RepostIcon size={20} color="#536471" />}
                        </TouchableOpacity>
                        <TouchableOpacity
                            onPress={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                handleQuote();
                            }}
                        >
                            <Text style={{ color: isReposted ? "#00BA7C" : "#536471", marginLeft: 4 }}>Quote</Text>
                        </TouchableOpacity>
                        <AnimatedNumbers includeComma animateToNumber={repostsCount} animationDuration={300} fontStyle={{ color: isReposted ? "#00BA7C" : "#536471" }} />
                    </View>
                    <TouchableOpacity
                        className="flex-row items-center mr-4 gap-1"
                        onPress={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleLike();
                        }}
                    >
                        <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                            {isLiked ? <HeartIconActive size={20} color="#F91880" /> : <HeartIcon size={20} color="#536471" />}
                        </Animated.View>
                        <AnimatedNumbers includeComma animateToNumber={likesCount} animationDuration={300} fontStyle={{ color: isLiked ? "#F91880" : "#536471" }} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        className="flex-row items-center mr-4 gap-1"
                        onPress={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleBookmark();
                        }}
                    >
                        {isBookmarked ? <BookmarkActive size={20} color="#1D9BF0" /> : <Bookmark size={20} color="#536471" />}
                        <AnimatedNumbers includeComma animateToNumber={bookmarksCount} animationDuration={300} fontStyle={{ color: isBookmarked ? "#1D9BF0" : "#536471" }} />
                    </TouchableOpacity>
                    <TouchableOpacity
                        className="flex-row items-center gap-1"
                        onPress={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            handleShare();
                        }}
                    >
                        <ShareIcon size={20} color="#536471" />
                    </TouchableOpacity>
                </View>
            )}
        </View>
    );
}
