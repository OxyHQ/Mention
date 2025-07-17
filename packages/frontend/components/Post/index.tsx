import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { RepostIcon, RepostIconActive } from '@/assets/icons/repost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import type { Post as IPost } from '@/interfaces/Post';
import { toast } from '@/lib/sonner';
import { colors } from '@/styles/colors';
import api from '@/utils/api';
import { Ionicons } from "@expo/vector-icons";
import { FollowButton, Models, useOxy } from '@oxyhq/services/full';

import { format } from 'date-fns';
import { Link, router } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Animated, Share, Text, TouchableOpacity, View, ViewStyle } from 'react-native';
import Avatar from '../Avatar';
import MediaGrid from './MediaGrid';

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

const Post = React.memo<PostProps>(function Post({ postData, quotedPost, className, style, showActions = true }) {
    const { t } = useTranslation();
    const [isLiked, setIsLiked] = useState(postData.isLiked || false);
    const [likesCount, setLikesCount] = useState(postData._count?.likes || 0);
    const [isReposted, setIsReposted] = useState(postData.isReposted || false);
    const [repostsCount, setRepostsCount] = useState(postData._count?.reposts || 0);
    const [isBookmarked, setIsBookmarked] = useState(postData.isBookmarked || false);
    const [bookmarksCount, setBookmarksCount] = useState(postData._count?.bookmarks || 0);
    const [poll, setPoll] = useState<PollData | null>(null);
    const [selectedOption, setSelectedOption] = useState<number | null>(null);
    const { user, isAuthenticated } = useOxy();
    const animatedScale = useRef(new Animated.Value(1)).current;

    // Memoize author ID to prevent unnecessary re-calculations
    const authorId = useMemo(() => postData.author?.id, [postData.author?.id]);

    // Memoize expensive calculations
    const authorDisplayName = useMemo(() => {
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
    }, [postData.author, t]);

    const authorUsername = useMemo(() => {
        return postData.author?.username || 'unknown';
    }, [postData.author?.username]);

    const isPremiumUser = useMemo(() => {
        return postData.author?.premium?.isPremium || false;
    }, [postData.author?.premium?.isPremium]);

    const formattedTimeAgo = useMemo(() => {
        const now = new Date();
        const postDate = new Date(postData.created_at);
        const diffInMinutes = Math.floor((now.getTime() - postDate.getTime()) / (1000 * 60));

        if (diffInMinutes < 1) return 'just now';
        if (diffInMinutes < 60) return `${diffInMinutes}m`;
        if (diffInMinutes < 1440) return `${Math.floor(diffInMinutes / 60)}h`;
        return format(postDate, 'MMM d');
    }, [postData.created_at]);

    // Reset states when post data changes - optimized to only update when necessary
    useEffect(() => {
        const newIsLiked = postData.isLiked || false;
        const newLikesCount = postData._count?.likes || 0;
        const newIsReposted = postData.isReposted || false;
        const newRepostsCount = postData._count?.reposts || 0;
        const newIsBookmarked = postData.isBookmarked || false;
        const newBookmarksCount = postData._count?.bookmarks || 0;

        // Only update state if values actually changed
        setIsLiked(current => current !== newIsLiked ? newIsLiked : current);
        setLikesCount(current => current !== newLikesCount ? newLikesCount : current);
        setIsReposted(current => current !== newIsReposted ? newIsReposted : current);
        setRepostsCount(current => current !== newRepostsCount ? newRepostsCount : current);
        setIsBookmarked(current => current !== newIsBookmarked ? newIsBookmarked : current);
        setBookmarksCount(current => current !== newBookmarksCount ? newBookmarksCount : current);
    }, [postData.isLiked, postData._count?.likes, postData.isReposted, postData._count?.reposts, postData.isBookmarked, postData._count?.bookmarks]);

    // Memoized animation function
    const animateInteraction = useCallback(() => {
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
    }, [animatedScale]);

    // Memoized event handlers
    const handleLike = useCallback(async () => {
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
    }, [isAuthenticated, isLiked, animateInteraction, postData.id, t]);

    const handleReply = useCallback(() => {
        router.push(`/p/${postData.id}/reply`);
    }, [postData.id]);

    const handleRepost = useCallback(async () => {
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
    }, [isAuthenticated, isReposted, animateInteraction, postData.id, t]);

    const handleBookmark = useCallback(async () => {
        if (!isAuthenticated) {
            toast.error(t('Please sign in to bookmark posts'));
            return;
        }

        try {
            const newIsBookmarked = !isBookmarked;

            // Optimistic update
            setIsBookmarked(newIsBookmarked);
            setBookmarksCount(prev => prev + (newIsBookmarked ? 1 : -1));

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
    }, [isAuthenticated, isBookmarked, postData.id, t]);

    const handlePollOptionPress = useCallback(async (optionIndex: number) => {
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
    }, [poll, selectedOption]);

    const handleShare = useCallback(async () => {
        try {
            await Share.share({
                message: `${postData.text}\n\nShared from Mention`,
                url: `https://mention.earth/p/${postData.id}`
            });
        } catch (error) {
            console.error('Error sharing post:', error);
        }
    }, [postData.text, postData.id]);

    const handleMediaPress = useCallback((media: any, index: number) => {
        // Handle media press - could open full screen viewer
        console.log('Media pressed:', media, index);
    }, []);

    // Memoize style objects to prevent recreation
    const containerStyle = useMemo(() => ({
        borderBottomWidth: 1,
        borderBottomColor: '#f3f4f6',
        ...(style || {})
    }), [style]);

    const repostIndicatorStyle = useMemo(() => ({
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 12,
        marginBottom: 8
    }), []);

    const mainContentStyle = useMemo(() => ({
        flexDirection: 'row' as const,
        gap: 10,
        paddingHorizontal: 12,
        alignItems: 'flex-start' as const
    }), []);

    const showFollowButton = useMemo(() => {
        return isAuthenticated && user?.id !== authorId && authorId;
    }, [isAuthenticated, user?.id, authorId]);

    return (
        <View style={containerStyle}>
            {postData.repost_of && (
                <View style={repostIndicatorStyle}>
                    <RepostIcon size={16} color="#536471" />
                    <Text style={{ color: '#536471', marginLeft: 8 }}>{authorDisplayName} {t('Reposted')}</Text>
                </View>
            )}
            <View style={mainContentStyle}>
                <Link href={`/@${authorUsername}`} asChild>
                    <TouchableOpacity onPress={(e) => e.stopPropagation()}>
                        <Avatar id={postData.author?.avatar} size={40} />
                    </TouchableOpacity>
                </Link>
                <View style={{ flex: 1 }}>
                    <Link href={`/p/${postData.id}`} asChild>
                        <TouchableOpacity style={{ flex: 1 }} activeOpacity={0.7}>
                            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 4 }}>
                                    <TouchableOpacity
                                        onPress={(e) => {
                                            e.stopPropagation();
                                            router.push(`/@${authorUsername}`);
                                        }}
                                    >
                                        <Text style={{ fontWeight: 'bold' }}>
                                            {authorDisplayName}
                                        </Text>
                                    </TouchableOpacity>
                                    {postData.author?.labels && postData.author.labels.includes('verified') && (
                                        <Ionicons name="checkmark-circle" size={16} color={colors.primaryColor} />
                                    )}
                                    {isPremiumUser && (
                                        <Ionicons name="star" size={14} color="#FFD700" />
                                    )}
                                    <Text style={{ color: '#536471' }}>·</Text>
                                    <Text style={{ color: '#536471' }}>{formattedTimeAgo}</Text>
                                </View>
                                {showFollowButton && (
                                    <FollowButton userId={authorId!} size="small" />
                                )}
                            </View>
                            {postData.author?.username && (
                                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                    <Text style={{ color: '#536471', fontSize: 14 }}>@{postData.author.username}</Text>
                                    {postData.author.location && (
                                        <Text style={{ color: '#536471', fontSize: 14, marginLeft: 8 }}>· {postData.author.location}</Text>
                                    )}
                                </View>
                            )}
                            <Text style={{ color: '#000', fontSize: 16, marginTop: 4 }}>{postData.text}</Text>
                            <MediaGrid
                                media={postData.media || []}
                                onMediaPress={handleMediaPress}
                            />
                            {quotedPost && (
                                <View style={{ marginTop: 12, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 12, padding: 12 }}>
                                    <Post postData={quotedPost} showActions={false} />
                                </View>
                            )}
                        </TouchableOpacity>
                    </Link>
                    {showActions && (
                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, marginBottom: 8, paddingRight: 64 }}>
                            <TouchableOpacity onPress={handleReply} style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Ionicons name="chatbubble-outline" size={18} color="#536471" />
                                {(postData._count?.replies ?? 0) > 0 && (
                                    <Text style={{ color: '#536471', marginLeft: 8 }}>{postData._count?.replies ?? 0}</Text>
                                )}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleRepost} style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                    {isReposted ? (
                                        <RepostIconActive size={18} color={colors.primaryColor} />
                                    ) : (
                                        <RepostIcon size={18} color="#536471" />
                                    )}
                                </Animated.View>
                                {repostsCount > 0 && (
                                    <Text style={{
                                        marginLeft: 8,
                                        color: isReposted ? colors.primaryColor : '#536471'
                                    }}>
                                        {repostsCount}
                                    </Text>
                                )}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleLike} style={{ flexDirection: 'row', alignItems: 'center' }}>
                                <Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                    {isLiked ? (
                                        <HeartIconActive size={18} color={colors.primaryColor} />
                                    ) : (
                                        <HeartIcon size={18} color="#536471" />
                                    )}
                                </Animated.View>
                                {likesCount > 0 && (
                                    <Text style={{
                                        marginLeft: 8,
                                        color: isLiked ? colors.primaryColor : '#536471'
                                    }}>
                                        {likesCount}
                                    </Text>
                                )}
                            </TouchableOpacity>
                            <TouchableOpacity onPress={handleBookmark} style={{ flexDirection: 'row', alignItems: 'center' }}>
                                {isBookmarked ? (
                                    <BookmarkActive size={18} color={colors.primaryColor} />
                                ) : (
                                    <Bookmark size={18} color="#536471" />
                                )}
                                {bookmarksCount > 0 && (
                                    <Text style={{
                                        marginLeft: 8,
                                        color: isBookmarked ? colors.primaryColor : '#536471'
                                    }}>
                                        {bookmarksCount}
                                    </Text>
                                )}
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
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
});

export default Post;
