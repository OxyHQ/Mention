import React, { useState, useEffect, useRef, useContext } from 'react';
import { View, Text, TouchableOpacity, Animated, StyleSheet, Platform, ViewStyle, ActivityIndicator } from 'react-native';
import { router, Link } from "expo-router";
import api from '@/utils/api';
import { renderMedia, renderPoll, renderLocation } from './renderers';
import Avatar from '../Avatar';
import { colors } from '@/styles/colors';
import { SessionContext } from '@/modules/oxyhqservices/components/SessionProvider';
import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { RepostIcon, RepostIconActive } from '@/assets/icons/repost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { toast } from '@/lib/sonner';
import { format } from 'date-fns';
import type { Post as IPost } from '@/interfaces/Post';
import { oxyClient } from '@/modules/oxyhqservices/services/OxyClient';
import type { OxyProfile } from '@/modules/oxyhqservices/types';
import { Share } from 'react-native';
import { Ionicons } from "@expo/vector-icons";
import { profileService } from '@/modules/oxyhqservices/services';
import { useTranslation } from 'react-i18next';

interface PollData {
    id: string;
    options: Array<{
        text: string;
        votes: number;
    }>;
}

interface PostProps {
    postData: IPost;
    quotedPost?: IPost;
    className?: string;
    style?: ViewStyle;
    showActions?: boolean;
}

// Global cache for profile data to avoid unnecessary API calls
const profileCache = new Map<string, OxyProfile>();

export default function Post({ postData, quotedPost, className, style, showActions = true }: PostProps) {
    const { t } = useTranslation();
    const [isLiked, setIsLiked] = useState(postData.isLiked || false);
    const [likesCount, setLikesCount] = useState(postData._count?.likes || 0);
    const [isReposted, setIsReposted] = useState(postData.isReposted || false);
    const [repostsCount, setRepostsCount] = useState(postData._count?.reposts || 0);
    const [isBookmarked, setIsBookmarked] = useState(postData.isBookmarked || false);
    const [bookmarksCount, setBookmarksCount] = useState(postData._count?.bookmarks || 0);
    const [poll, setPoll] = useState<PollData | null>(null);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const [authorProfile, setAuthorProfile] = useState<OxyProfile | null>(() => {
        // Initialize from cache if available
        return postData.author?.id ? profileCache.get(postData.author.id) || null : null;
    });
    const [isLoadingProfile, setIsLoadingProfile] = useState<boolean>(!authorProfile);
    const [profileError, setProfileError] = useState<string | null>(null);
    const [isFollowing, setIsFollowing] = useState<boolean>(false);
    const session = useContext(SessionContext);

    const animatedScale = useRef(new Animated.Value(1)).current;

    useEffect(() => {
        const fetchAuthorProfile = async () => {
            if (!postData.author?.id) {
                setProfileError("No author ID available");
                setIsLoadingProfile(false);
                return;
            }

            // Check cache first
            const cachedProfile = profileCache.get(postData.author.id);
            if (cachedProfile) {
                setAuthorProfile(cachedProfile);
                setIsLoadingProfile(false);
                return;
            }

            setIsLoadingProfile(true);
            setProfileError(null);

            try {
                // Use profileService for more comprehensive profile data
                const profile = await profileService.getProfileById(postData.author.id);

                // Update cache
                profileCache.set(postData.author.id, profile);
                setAuthorProfile(profile);

                // Check if the current user is following this author
                if (session?.isAuthenticated && session.getCurrentUserId() !== postData.author.id) {
                    try {
                        const followingStatus = await profileService.getFollowingStatus(postData.author.id);
                        setIsFollowing(followingStatus);
                    } catch (error) {
                        console.error('Error checking following status:', error);
                    }
                }
            } catch (error) {
                console.error('Error fetching author profile:', error);
                setProfileError("Failed to load profile");
            } finally {
                setIsLoadingProfile(false);
            }
        };

        // Only fetch if we don't have profile data
        if (!authorProfile) {
            fetchAuthorProfile();
        }
    }, [postData.author?.id, authorProfile, session]);

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
                await api.post(`posts/${postData.id}/repost`);
            } else {
                await api.delete(`posts/${postData.id}/repost`);
            }
        } catch (error) {
            console.error('Error reposting:', error);
            setIsReposted(prev => !prev);
            setRepostsCount(prev => prev + (isReposted ? 1 : -1));
        }
    };

    const handleBookmark = async () => {
        try {
            const newIsBookmarked = !isBookmarked;
            setIsBookmarked(newIsBookmarked);
            setBookmarksCount(prev => prev + (newIsBookmarked ? 1 : -1));

            if (newIsBookmarked) {
                await api.post(`posts/${postData.id}/bookmark`);
            } else {
                await api.delete(`posts/${postData.id}/bookmark`);
            }
        } catch (error) {
            console.error('Error bookmarking:', error);
            setIsBookmarked(prev => !prev);
            setBookmarksCount(prev => prev + (isBookmarked ? 1 : -1));
            toast.error('Failed to bookmark post');
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

    // Format the author's full name
    const getAuthorDisplayName = () => {
        if (!authorProfile) return t('Unknown');

        if (authorProfile.name?.first) {
            return `${authorProfile.name.first} ${authorProfile.name.last || ''}`.trim();
        }

        return authorProfile.username;
    };

    // Get author's username for profile links
    const getAuthorUsername = () => {
        return authorProfile?.username || 'unknown';
    };

    // Check if user has premium status
    const isPremiumUser = () => {
        return authorProfile?.premium?.isPremium || false;
    };

    // Get premium tier if available
    const getPremiumTier = () => {
        return authorProfile?.premium?.subscriptionTier || null;
    };

    // Handle follow/unfollow
    const handleFollowToggle = async () => {
        if (!session?.isAuthenticated) {
            toast.error(t('Please sign in to follow users'));
            return;
        }

        if (!authorProfile) return;

        try {
            setIsFollowing(prevState => !prevState);
            const result = await profileService.follow(authorProfile.userID);

            // Update the following status based on the server response
            setIsFollowing(result.action === 'follow');

            toast.success(
                result.action === 'follow'
                    ? t('Now following {{name}}', { name: getAuthorDisplayName() })
                    : t('Unfollowed {{name}}', { name: getAuthorDisplayName() })
            );
        } catch (error) {
            console.error('Error toggling follow status:', error);
            // Revert the optimistic update
            setIsFollowing(prevState => !prevState);
            toast.error(t('Failed to update follow status'));
        }
    };

    return (
        <View className={`bg-white border-b border-gray-100 ${className}`} style={style}>
            {postData.repost_of && (
                <View className="flex-row items-center px-3 mb-2">
                    <RepostIcon size={16} color="#536471" />
                    <Text className="text-gray-500 ml-2">{getAuthorDisplayName()} {t('Reposted')}</Text>
                </View>
            )}
            <View className="flex-row gap-2.5 px-3 items-start">
                <Link href={`/@${getAuthorUsername()}`} asChild>
                    <TouchableOpacity onPress={(e) => e.stopPropagation()}>
                        {isLoadingProfile ? (
                            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#f0f0f0', justifyContent: 'center', alignItems: 'center' }}>
                                <ActivityIndicator size="small" color={colors.primaryColor} />
                            </View>
                        ) : (
                            <Avatar id={authorProfile?.avatar} size={40} />
                        )}
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
                                                {isLoadingProfile ? t('Loading...') : getAuthorDisplayName()}
                                            </Text>
                                        </TouchableOpacity>
                                    </Link>
                                    {authorProfile?.labels && authorProfile.labels.includes('verified') && (
                                        <Ionicons name="checkmark-circle" size={16} color={colors.primaryColor} />
                                    )}
                                    {isPremiumUser() && (
                                        <Ionicons name="star" size={14} color="#FFD700" />
                                    )}
                                    <Text className="text-gray-500">·</Text>
                                    <Text className="text-gray-500">{formatTimeAgo(postData.created_at)}</Text>
                                </View>
                                {session?.isAuthenticated &&
                                    session.getCurrentUserId() !== postData.author?.id &&
                                    !isLoadingProfile && (
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
                            {!isLoadingProfile && authorProfile?.username && (
                                <View className="flex-row items-center">
                                    <Text className="text-gray-500 text-sm">@{authorProfile.username}</Text>
                                    {authorProfile.location && (
                                        <Text className="text-gray-500 text-sm ml-2">· {authorProfile.location}</Text>
                                    )}
                                </View>
                            )}
                            <Text className="text-black text-base mt-1">{postData.text}</Text>
                            {postData.media && renderMedia(postData.media)}
                            {poll && renderPoll(poll, selectedOption, handlePollOptionPress)}
                            {typeof postData.location === 'string' && renderLocation(postData.location)}
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
