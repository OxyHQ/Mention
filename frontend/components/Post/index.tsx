import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { RepostIcon, RepostIconActive } from '@/assets/icons/repost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import type { Post as IPost } from '@/interfaces/Post';
import { toast } from '@/lib/sonner';
import { colors } from '@/styles/colors';
import api from '@/utils/api';
import { Ionicons } from "@expo/vector-icons";
import { Models, useOxy } from '@oxyhq/services';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Link, router } from "expo-router";
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Share, Text, TouchableOpacity, View, ViewStyle } from 'react-native';
import Avatar from '../Avatar';

interface PollData {
    id: string;
    options: {
        text: string;
        votes: number;
    }[];
}

interface PostProps {
    postData: IPost;
    quotedPost?: IPost;
    className?: string;
    style?: ViewStyle;
    showActions?: boolean;
}

// Global profile cache for API call optimization
// Each profile is keyed by userId to ensure correct access
declare global {
    var profileCacheMap: Map<string, Models.User>;
}

if (!global.profileCacheMap) {
    global.profileCacheMap = new Map<string, Models.User>();
}

export default function Post({ postData, quotedPost, className, style, showActions = true }: PostProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [isLiked, setIsLiked] = useState(postData.isLiked || false);
    const [likesCount, setLikesCount] = useState(postData._count?.likes || 0);
    const [isReposted, setIsReposted] = useState(postData.isReposted || false);
    const [repostsCount, setRepostsCount] = useState(postData._count?.reposts || 0);
    const [isBookmarked, setIsBookmarked] = useState(postData.isBookmarked || false);
    const [bookmarksCount, setBookmarksCount] = useState(postData._count?.bookmarks || 0);
    const [poll, setPoll] = useState<PollData | null>(null);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [isFollowing, setIsFollowing] = useState<boolean>(false);
    const { user, isAuthenticated } = useOxy();
    const animatedScale = useRef(new Animated.Value(1)).current;
    const authorId = postData.author?.id;

    // Reset states when post data changes
    useEffect(() => {
        setIsLiked(postData.isLiked || false);
        setLikesCount(postData._count?.likes || 0);
        setIsReposted(postData.isReposted || false);
        setRepostsCount(postData._count?.reposts || 0);
        setIsBookmarked(postData.isBookmarked || false);
        setBookmarksCount(postData._count?.bookmarks || 0);
    }, [postData]);

    // Check following status if we're authenticated and not looking at our own post
    useEffect(() => {
        const checkFollowingStatus = async () => {
            if (isAuthenticated && authorId && user?.id !== authorId) {
                try {
                    // Check if the user is already following the author
                } catch (error) {
                    console.error('Error checking following status:', error);
                }
            }
        };

        checkFollowingStatus();
    }, [authorId, user, isAuthenticated]);

    // Animation for interactions
    const animateInteraction = () => {
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
    };

    const handleLike = async () => {
        if (!isAuthenticated) {
            toast.error(t('Please sign in to like posts'));
            return;
        }

        try {
            const newIsLiked = !isLiked;

            // Optimistic update
            setIsLiked(newIsLiked);
            setLikesCount(prev => prev + (newIsLiked ? 1 : -1));
            animateInteraction();

            // Find all feed queries that might contain this post
            const feedQueries = queryClient.getQueriesData({
                queryKey: ['feed']
            });

            // Update all feed queries that might have this post
            feedQueries.forEach(([queryKey]) => {
                queryClient.setQueryData(queryKey, (oldData: any) => {
                    if (!oldData?.pages) return oldData;

                    return {
                        ...oldData,
                        pages: oldData.pages.map((page: any) => ({
                            ...page,
                            posts: page.posts.map((post: IPost) => {
                                if (post.id === postData.id) {
                                    const likesCount = (post._count?.likes || 0) + (newIsLiked ? 1 : -1);
                                    return {
                                        ...post,
                                        isLiked: newIsLiked,
                                        _count: { ...post._count, likes: likesCount >= 0 ? likesCount : 0 }
                                    };
                                }
                                return post;
                            })
                        }))
                    };
                });
            });

            // Make the API call
            if (newIsLiked) {
                await api.post(`posts/${postData.id}/like`);
            } else {
                await api.delete(`posts/${postData.id}/like`);
            }
        } catch (error) {
            // Revert optimistic update on error
            console.error('Error liking post:', error);
            setIsLiked(prev => !prev);
            setLikesCount(prev => prev + (isLiked ? 1 : -1));
            toast.error(t('Failed to update like status'));
        }
    };

    const handleReply = () => {
        router.push(`/post/${postData.id}/reply`);
    };

    const handleRepost = async () => {
        if (!isAuthenticated) {
            toast.error(t('Please sign in to repost'));
            return;
        }

        try {
            const newIsReposted = !isReposted;

            // Optimistic update
            setIsReposted(newIsReposted);
            setRepostsCount(prev => prev + (newIsReposted ? 1 : -1));
            animateInteraction();

            // Find all feed queries that might contain this post
            const feedQueries = queryClient.getQueriesData({
                queryKey: ['feed']
            });

            // Update all feed queries that might have this post
            feedQueries.forEach(([queryKey]) => {
                queryClient.setQueryData(queryKey, (oldData: any) => {
                    if (!oldData?.pages) return oldData;

                    return {
                        ...oldData,
                        pages: oldData.pages.map((page: any) => ({
                            ...page,
                            posts: page.posts.map((post: IPost) => {
                                if (post.id === postData.id) {
                                    const repostsCount = (post._count?.reposts || 0) + (newIsReposted ? 1 : -1);
                                    return {
                                        ...post,
                                        isReposted: newIsReposted,
                                        _count: { ...post._count, reposts: repostsCount >= 0 ? repostsCount : 0 }
                                    };
                                }
                                return post;
                            })
                        }))
                    };
                });
            });

            // Make the API call
            if (newIsReposted) {
                await api.post(`posts/${postData.id}/repost`);
            } else {
                await api.delete(`posts/${postData.id}/repost`);
            }
        } catch (error) {
            // Revert optimistic update on error
            console.error('Error reposting:', error);
            setIsReposted(prev => !prev);
            setRepostsCount(prev => prev + (isReposted ? 1 : -1));
            toast.error(t('Failed to update repost status'));
        }
    };

    const handleBookmark = async () => {
        if (!isAuthenticated) {
            toast.error(t('Please sign in to bookmark posts'));
            return;
        }

        try {
            const newIsBookmarked = !isBookmarked;

            // Optimistic update
            setIsBookmarked(newIsBookmarked);
            setBookmarksCount(prev => prev + (newIsBookmarked ? 1 : -1));

            // Find all feed queries that might contain this post
            const feedQueries = queryClient.getQueriesData({
                queryKey: ['feed']
            });

            // Update all feed queries that might have this post
            feedQueries.forEach(([queryKey]) => {
                queryClient.setQueryData(queryKey, (oldData: any) => {
                    if (!oldData?.pages) return oldData;

                    return {
                        ...oldData,
                        pages: oldData.pages.map((page: any) => ({
                            ...page,
                            posts: page.posts.map((post: IPost) => {
                                if (post.id === postData.id) {
                                    const bookmarksCount = (post._count?.bookmarks || 0) + (newIsBookmarked ? 1 : -1);
                                    return {
                                        ...post,
                                        isBookmarked: newIsBookmarked,
                                        _count: { ...post._count, bookmarks: bookmarksCount >= 0 ? bookmarksCount : 0 }
                                    };
                                }
                                return post;
                            })
                        }))
                    };
                });
            });

            // Make the API call
            if (newIsBookmarked) {
                await api.post(`posts/${postData.id}/bookmark`);
            } else {
                await api.delete(`posts/${postData.id}/bookmark`);
            }
        } catch (error) {
            // Revert optimistic update on error
            console.error('Error bookmarking:', error);
            setIsBookmarked(prev => !prev);
            setBookmarksCount(prev => prev + (isBookmarked ? 1 : -1));
            toast.error(t('Failed to update bookmark status'));
        }
    };

    const handlePollOptionPress = async (optionIndex: number) => {
        if (!poll || selectedOption !== null) return;

        try {
            await api.post(`polls/${poll.id}/vote`, { option: optionIndex });
            setPoll((prev: PollData | null) => {
                if (!prev) return null;
                const updatedOptions = prev.options.map((opt, idx) => ({
                    ...opt,
                    votes: idx === optionIndex ? opt.votes + 1 : opt.votes
                }));
                return { ...prev, options: updatedOptions };
            });
            setSelectedOption(optionIndex);
        } catch (error) {
            console.error('Error voting in poll:', error);
            toast.error('Failed to vote in poll');
        }
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

    const formatTimeAgo = (date: string) => {
        const now = new Date();
        const postDate = new Date(date);
        const diffInMinutes = Math.floor((now.getTime() - postDate.getTime()) / (1000 * 60));

        if (diffInMinutes < 1) return 'just now';
        if (diffInMinutes < 60) return `${diffInMinutes}m`;
        if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h`;
        return format(postDate, 'MMM d');
    };

    // Format the author's full name using profile data from post object
    const getAuthorDisplayName = () => {
        if (!postData.author) return t('Unknown');

        if (postData.author.name) {
            if (typeof postData.author.name === 'object') {
                const { first, last } = postData.author.name;
                return `${first} ${last || ''}`.trim();
            } else {
                return postData.author.name;
            }
        }

        return postData.author.username || t('Unknown');
    };

    // Get author's username for profile links from post object
    const getAuthorUsername = () => {
        return postData.author?.username || 'unknown';
    };

    // Check if user has premium status from post object
    const isPremiumUser = () => {
        return postData.author?.premium?.isPremium || false;
    };

    // Get premium tier if available from post object
    const getPremiumTier = () => {
        return postData.author?.premium?.subscriptionTier || null;
    };

    // Handle follow/unfollow
    const handleFollowToggle = async () => {
        if (!isAuthenticated) {
            toast.error(t('Please sign in to follow users'));
            return;
        }

        if (!authorId) return;

        try {
        } catch (error) {
            console.error('Error toggling follow status:', error);
            // Revert the optimistic update
            setIsFollowing(prevState => !prevState);
            toast.error(t('Failed to update follow status'));
        }
    };

    return (
        <View className={`border-b border-gray-100 ${className}`} style={style}>
            {postData.repost_of && (
                <View className="flex-row items-center px-3 mb-2">
                    <RepostIcon size={16} color="#536471" />
                    <Text className="text-gray-500 ml-2">{getAuthorDisplayName()} {t('Reposted')}</Text>
                </View>
            )}
            <View className="flex-row gap-2.5 px-3 items-start">
                <Link href={`/@${getAuthorUsername()}`} asChild>
                    <TouchableOpacity onPress={(e) => e.stopPropagation()}>
                        <Avatar id={postData.author?.avatar} size={40} />
                    </TouchableOpacity>
                </Link>
                <View className="flex-1">
                    <Link href={`/post/${postData.id}`} asChild>
                        <TouchableOpacity className="flex-1" activeOpacity={0.7}>
                            <View className="flex-row items-center">
                                <View className="flex-row items-center flex-1 gap-1">
                                    <Link href={`/@${getAuthorUsername()}`} asChild>
                                        <TouchableOpacity>
                                            <Text className="font-bold">
                                                {getAuthorDisplayName()}
                                            </Text>
                                        </TouchableOpacity>
                                    </Link>
                                    {postData.author?.labels && postData.author.labels.includes('verified') && (
                                        <Ionicons name="checkmark-circle" size={16} color={colors.primaryColor} />
                                    )}
                                    {isPremiumUser() && (
                                        <Ionicons name="star" size={14} color="#FFD700" />
                                    )}
                                    <Text className="text-gray-500">·</Text>
                                    <Text className="text-gray-500">{formatTimeAgo(postData.created_at)}</Text>
                                </View>
                                {isAuthenticated &&
                                    user?.id !== authorId && (
                                        <TouchableOpacity
                                            onPress={handleFollowToggle}
                                            style={{
                                                paddingHorizontal: 10,
                                                paddingVertical: 4,
                                                borderRadius: 16,
                                                backgroundColor: isFollowing ? 'transparent' : colors.primaryColor,
                                                borderWidth: 1,
                                                borderColor: colors.primaryColor
                                            }}
                                        >
                                            <Text style={{
                                                color: isFollowing ? colors.primaryColor : 'white',
                                                fontWeight: '600',
                                                fontSize: 12
                                            }}>
                                                {isFollowing ? t('Following') : t('Follow')}
                                            </Text>
                                        </TouchableOpacity>
                                    )}
                            </View>
                            {postData.author?.username && (
                                <View className="flex-row items-center">
                                    <Text className="text-gray-500 text-sm">@{postData.author.username}</Text>
                                    {postData.author.location && (
                                        <Text className="text-gray-500 text-sm ml-2">· {postData.author.location}</Text>
                                    )}
                                </View>
                            )}
                            <Text className="text-black text-base mt-1">{postData.text}</Text>
                            {quotedPost && (
                                <View className="mt-3 border border-gray-200 rounded-xl p-3">
                                    {quotedPost && <Post postData={quotedPost} showActions={false} />}
                                </View>
                            )}
                        </TouchableOpacity>
                    </Link>
                    {showActions && (
                        <View className="flex-row justify-between mt-3 mb-2 pr-16">
                            <TouchableOpacity onPress={handleReply} className="flex-row items-center">
                                <Ionicons name="chatbubble-outline" size={18} color="#536471" />
                                {(postData._count?.replies ?? 0) > 0 && (
                                    <Text className="text-gray-600 ml-2">{postData._count?.replies ?? 0}</Text>
                                )}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleRepost} className="flex-row items-center">
                                <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                    {isReposted ? (
                                        <RepostIconActive size={18} color={colors.primaryColor} />
                                    ) : (
                                        <RepostIcon size={18} color="#536471" />
                                    )}
                                </Animated.View>
                                {repostsCount > 0 && (
                                    <Text className={`ml-2 ${isReposted ? 'text-primary' : 'text-gray-600'}`}>
                                        {repostsCount}
                                    </Text>
                                )}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleLike} className="flex-row items-center">
                                <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                    {isLiked ? (
                                        <HeartIconActive size={18} color={colors.primaryColor} />
                                    ) : (
                                        <HeartIcon size={18} color="#536471" />
                                    )}
                                </Animated.View>
                                {likesCount > 0 && (
                                    <Text className={`ml-2 ${isLiked ? 'text-primary' : 'text-gray-600'}`}>
                                        {likesCount}
                                    </Text>
                                )}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleBookmark} className="flex-row items-center">
                                {isBookmarked ? (
                                    <BookmarkActive size={18} color={colors.primaryColor} />
                                ) : (
                                    <Bookmark size={18} color="#536471" />
                                )}
                                {bookmarksCount > 0 && (
                                    <Text className={`ml-2 ${isBookmarked ? 'text-primary' : 'text-gray-600'}`}>
                                        {bookmarksCount}
                                    </Text>
                                )}
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
            </View>
        </View>
    );
}
