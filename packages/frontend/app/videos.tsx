import React, { useCallback, useEffect, useRef, useState, useMemo, memo } from 'react';
import { StyleSheet, View, Text, Dimensions, Pressable, FlatList, Platform, Share } from 'react-native';
import { toast } from '@/lib/sonner';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import { VideoView, useVideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { usePostsStore } from '@/stores/postsStore';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import { feedService } from '@/services/feedService';
import LoadingTopSpinner from '@/components/LoadingTopSpinner';
import Avatar from '@/components/Avatar';
import SEO from '@/components/SEO';

// Constants
const WINDOW_HEIGHT = Dimensions.get('window').height;
const FLATLIST_CONFIG = {
    INITIAL_NUM_TO_RENDER: 2,
    MAX_TO_RENDER_PER_BATCH: 2,
    WINDOW_SIZE: 3,
    END_REACHED_THRESHOLD: 0.3,
} as const;

const VIEWABILITY_CONFIG = {
    itemVisiblePercentThreshold: 60,
    waitForInteraction: false,
    minimumViewTime: 100,
} as const;

// Types
interface VideoPost {
    id: string;
    user: {
        id: string;
        name: string;
        handle: string;
        avatar: string;
        verified: boolean;
    };
    content: {
        text?: string;
        media?: { id: string; type: 'image' | 'video' }[];
    };
    videoUrl?: string;
    stats: {
        likesCount: number;
        repostsCount: number;
        commentsCount: number;
        viewsCount: number;
    };
    isLiked?: boolean;
    isReposted?: boolean;
    isSaved?: boolean;
    createdAt: string;
}

interface VideoItemProps {
    item: VideoPost;
    index: number;
    isVisible: boolean;
    theme: ReturnType<typeof useTheme>;
    onLike: (postId: string, isLiked: boolean) => void;
    onComment: (postId: string) => void;
    onRepost: (postId: string, isReposted: boolean) => void;
    onShare: (post: VideoPost) => void;
    formatCount: (count: number) => string;
    globalMuted: boolean;
    onMuteChange: (muted: boolean) => void;
    bottomBarHeight: number;
    t: (key: string) => string;
}

// Memoized VideoItem component for performance
const VideoItem = memo<VideoItemProps>(({
    item,
    index,
    isVisible,
    theme,
    onLike,
    onComment,
    onRepost,
    onShare,
    formatCount,
    globalMuted,
    onMuteChange,
    bottomBarHeight,
    t,
}) => {
    const { oxyServices } = useOxy();
    const router = useRouter();
    const [isMuted, setIsMuted] = useState(globalMuted);
    const [videoError, setVideoError] = useState(false);

    // Create player instance with proper configuration
    const player = useVideoPlayer(item.videoUrl || '', (player) => {
        if (player) {
            player.loop = true;
            player.muted = globalMuted; // Use global muted state (platform-specific default)
        }
    });

    // Sync with global muted state
    useEffect(() => {
        if (player && player.muted !== globalMuted) {
            player.muted = globalMuted;
            setIsMuted(globalMuted);
        }
    }, [globalMuted, player]);

    // Toggle mute/unmute handler
    const toggleMute = useCallback(() => {
        if (!player) return;

        try {
            const newMutedState = !isMuted;
            onMuteChange(newMutedState);
            player.muted = newMutedState;
            setIsMuted(newMutedState);

            if (!newMutedState && isVisible) {
                try {
                    const playResult = player.play() as Promise<void> | void;
                    if (playResult instanceof Promise) {
                        playResult.catch(() => {
                            onMuteChange(true);
                            player.muted = true;
                            setIsMuted(true);
                        });
                    }
                } catch (error) {
                    // Silently handle play errors
                }
            }
        } catch (error) {
            // Silently handle mute toggle errors
        }
    }, [player, isMuted, isVisible, onMuteChange]);

    // Handle play/pause based on visibility
    useEffect(() => {
        if (!player || !item.videoUrl) return;

        if (typeof player.play !== 'function' || typeof player.pause !== 'function') {
            return;
        }

        const timeoutId = setTimeout(() => {
            try {
                if (player.muted !== globalMuted) {
                    player.muted = globalMuted;
                    setIsMuted(globalMuted);
                }

                if (isVisible) {
                    // Reset video to start when it becomes visible
                    try {
                        if (typeof player.currentTime !== 'undefined') {
                            player.currentTime = 0;
                        }
                    } catch (error) {
                        // Silently handle currentTime reset errors
                    }
                    
                    const playResult = player.play() as Promise<void> | void;
                    if (playResult instanceof Promise) {
                        playResult.catch(() => {
                            // Autoplay blocked - expected without user interaction
                        });
                    }
                } else {
                    player.pause();
                }
            } catch (error) {
                // Silently handle play/pause errors
            }
        }, isVisible ? 50 : 0);

        return () => clearTimeout(timeoutId);
    }, [isVisible, player, item.videoUrl, globalMuted]);

    // Memoized avatar source
    const avatarSource = useMemo(() => {
        return item.user?.avatar && oxyServices?.getFileDownloadUrl
            ? oxyServices.getFileDownloadUrl(item.user.avatar)
            : undefined;
    }, [item.user?.avatar, oxyServices]);

    // Memoized user name
    const userName = useMemo(() => item.user?.name || '', [item.user?.name]);
    const userHandle = useMemo(() => item.user?.handle || t('common.unknown'), [item.user?.handle, t]);
    const postText = useMemo(() => item.content?.text?.trim() || '', [item.content?.text]);

    // Navigate to profile with videos tab
    const handleProfilePress = useCallback(() => {
        if (item.user?.handle) {
            router.push(`/@${item.user.handle}/videos`);
        }
    }, [item.user?.handle, router]);

    return (
        <View style={styles.videoContainer}>
            {item.videoUrl && player && !videoError ? (
                <VideoView
                    key={`video-${item.id}-${index}`}
                    player={player}
                    style={styles.video}
                    contentFit="contain"
                    nativeControls={false}
                    allowsFullscreen={false}
                    allowsPictureInPicture={false}
                />
            ) : (
                <View style={[styles.video, styles.videoPlaceholder, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <Ionicons name="videocam-outline" size={48} color={theme.colors.textSecondary} />
                    {videoError && (
                        <Text style={[styles.errorText, { color: theme.colors.textSecondary }]}>
                            {t('videos.unavailable')}
                        </Text>
                    )}
                </View>
            )}

            <Pressable
                style={styles.muteButton}
                onPress={toggleMute}
                hitSlop={HIT_SLOP}
            >
                <View style={styles.muteButtonInner}>
                    <Ionicons
                        name={isMuted ? "volume-mute" : "volume-high"}
                        size={22}
                        color="white"
                    />
                </View>
            </Pressable>

            <View style={[styles.overlay, { paddingBottom: bottomBarHeight + 20 }]}>
                <LinearGradient
                    colors={['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.8)', '#000000']}
                    locations={[0, 0.4, 0.7, 1]}
                    style={styles.gradientOverlay}
                />

                <View style={styles.bottomInfo}>
                    <View style={styles.userInfo}>
                        <Pressable onPress={handleProfilePress} style={styles.userHeader}>
                            <Avatar
                                source={avatarSource}
                                size={40}
                                verified={item.user?.verified || false}
                                style={styles.userAvatar}
                            />
                            <View style={styles.userNameContainer}>
                                <View style={styles.userNameRow}>
                                    <Text style={styles.userFullName} numberOfLines={1}>
                                        {userName}
                                    </Text>
                                    {item.user?.verified && (
                                        <Ionicons name="checkmark-circle" size={14} color="#1DA1F2" style={styles.verifiedIcon} />
                                    )}
                                </View>
                            </View>
                        </Pressable>
                        {postText ? (
                            <Text style={styles.postText} numberOfLines={2}>
                                {postText}
                            </Text>
                        ) : null}
                    </View>
                </View>

                <View style={styles.rightActions}>
                    <ActionButton
                        icon={item.isLiked ? "heart" : "heart-outline"}
                        count={item.stats?.likesCount || 0}
                        isActive={item.isLiked}
                        activeColor="#FF3040"
                        onPress={() => onLike(item.id, item.isLiked || false)}
                        formatCount={formatCount}
                    />
                    <ActionButton
                        icon="chatbubble-outline"
                        count={item.stats?.commentsCount || 0}
                        onPress={() => onComment(item.id)}
                        formatCount={formatCount}
                    />
                    <ActionButton
                        icon={item.isReposted ? "repeat" : "repeat-outline"}
                        count={item.stats?.repostsCount || 0}
                        isActive={item.isReposted}
                        activeColor="#10B981"
                        onPress={() => onRepost(item.id, item.isReposted || false)}
                        formatCount={formatCount}
                    />
                    <ActionButton
                        icon="share-outline"
                        count={0}
                        onPress={() => onShare(item)}
                        formatCount={formatCount}
                        hideCount={true}
                    />
                </View>
            </View>
        </View>
    );
});

VideoItem.displayName = 'VideoItem';

// Memoized ActionButton component
interface ActionButtonProps {
    icon: string;
    count: number;
    isActive?: boolean;
    activeColor?: string;
    onPress: () => void;
    formatCount: (count: number) => string;
    hideCount?: boolean;
}

const ActionButton = memo<ActionButtonProps>(({ icon, count, isActive, activeColor, onPress, formatCount, hideCount = false }) => (
    <Pressable style={styles.actionButton} onPress={onPress} hitSlop={HIT_SLOP}>
        <Ionicons
            name={icon as any}
            size={28}
            color={isActive && activeColor ? activeColor : "white"}
            style={styles.actionIcon}
        />
        {!hideCount && (
            <Text style={[styles.actionCount, isActive && activeColor && { color: activeColor }]}>
                {formatCount(count)}
            </Text>
        )}
    </Pressable>
));

ActionButton.displayName = 'ActionButton';

// Helper function
const hexToRgb = (hex: string): string => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
        ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
        : '255, 48, 64';
};

const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 };

export default function VideosScreen() {
    const { t } = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const router = useRouter();
    const params = useLocalSearchParams<{ postId?: string }>();
    const { oxyServices } = useOxy();
    const { likePost, unlikePost, repostPost, unrepostPost, getPostById } = usePostsStore();

    const [posts, setPosts] = useState<VideoPost[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [hasMore, setHasMore] = useState(true);
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    const [loadingMore, setLoadingMore] = useState(false);
    const [currentVisibleIndex, setCurrentVisibleIndex] = useState(0);
    const { isMuted: globalMuted, toggleMuted, loadMutedState } = useVideoMuteStore();
    const [targetPostId] = useState<string | undefined>(params.postId);
    const [hasScrolledToTarget, setHasScrolledToTarget] = useState(false);

    const flatListRef = useRef<FlatList<VideoPost>>(null);

    // Memoized bottom bar height
    const bottomBarHeight = useMemo(
        () => Platform.OS === 'web' ? 60 : 60 + insets.bottom,
        [insets.bottom]
    );

    // Memoized filter function
    const filterVideoPosts = useCallback((allPosts: any[]): VideoPost[] => {
        if (!oxyServices?.getFileDownloadUrl) return [];

        return allPosts
            .filter((post: any) => {
                const media = post?.content?.media || [];
                const videoCount = media.filter((m: any) => m?.type === 'video').length;
                return media.length === 1 && videoCount === 1;
            })
            .map((post: any) => {
                const media = post?.content?.media || [];
                const videoMedia = media.find((m: any) => m?.type === 'video');
                let videoUrl = videoMedia?.url || videoMedia?.id;

                if (videoUrl && !videoUrl.startsWith('http') && oxyServices?.getFileDownloadUrl) {
                    videoUrl = oxyServices.getFileDownloadUrl(videoUrl);
                }

                return { ...post, videoUrl } as VideoPost;
            })
            .filter((post: VideoPost) => post.videoUrl && post.videoUrl.trim().length > 0);
    }, [oxyServices]);

    // Fetch specific post by ID
    const fetchPostById = useCallback(async (postId: string): Promise<VideoPost | null> => {
        try {
            const post = await getPostById(postId);
            if (!post) return null;
            const videoPosts = filterVideoPosts([post]);
            return videoPosts[0] || null;
        } catch {
            return null;
        }
    }, [getPostById, filterVideoPosts]);

    // Fetch videos
    const fetchVideos = useCallback(async (cursor?: string, prependTarget?: boolean) => {
        try {
            const response = await feedService.getFeed({
                type: 'media',
                cursor,
                limit: 20,
            });

            const videoPosts = filterVideoPosts(response.items || []);

            if (cursor) {
                setPosts(prev => {
                    const existingIds = new Set(prev.map(p => p.id));
                    const newPosts = videoPosts.filter(p => !existingIds.has(p.id));
                    return [...prev, ...newPosts];
                });
            } else {
                let postsToSet = videoPosts;

                if (targetPostId && !hasScrolledToTarget && prependTarget) {
                    const targetPost = await fetchPostById(targetPostId);
                    if (targetPost && !videoPosts.some(p => p.id === targetPostId)) {
                        postsToSet = [targetPost, ...videoPosts];
                    }
                }

                setPosts(postsToSet);
            }

            setHasMore(response.hasMore || false);
            setNextCursor(response.nextCursor);

            return videoPosts;
        } catch {
            return [];
        }
    }, [filterVideoPosts, targetPostId, hasScrolledToTarget, fetchPostById]);

    // Initial load
    useEffect(() => {
        let isMounted = true;

        const load = async () => {
            setIsLoading(true);
            const videoPosts = await fetchVideos(undefined, !!targetPostId);

            if (!isMounted) return;

            if (targetPostId && !hasScrolledToTarget && videoPosts.length > 0) {
                setTimeout(() => {
                    if (!isMounted) return;
                    setPosts(currentPosts => {
                        const targetIndex = currentPosts.findIndex(p => p.id === targetPostId);

                        if (targetIndex >= 0 && flatListRef.current) {
                            setTimeout(() => {
                                try {
                                    flatListRef.current?.scrollToIndex({
                                        index: targetIndex,
                                        animated: false,
                                        viewPosition: 0,
                                    });
                                    setCurrentVisibleIndex(targetIndex);
                                    setHasScrolledToTarget(true);
                                } catch {
                                    try {
                                        flatListRef.current?.scrollToOffset({
                                            offset: targetIndex * WINDOW_HEIGHT,
                                            animated: false,
                                        });
                                        setCurrentVisibleIndex(targetIndex);
                                        setHasScrolledToTarget(true);
                                    } catch {
                                        // Failed to scroll
                                    }
                                }
                            }, 200);
                        } else if (targetIndex < 0) {
                            fetchPostById(targetPostId).then(targetPost => {
                                if (!isMounted || !targetPost) return;
                                setPosts(prev => {
                                    if (prev.some(p => p.id === targetPostId)) return prev;
                                    const newPosts = [targetPost, ...prev];
                                    setTimeout(() => {
                                        try {
                                            flatListRef.current?.scrollToIndex({ index: 0, animated: false, viewPosition: 0 });
                                            setCurrentVisibleIndex(0);
                                            setHasScrolledToTarget(true);
                                        } catch {
                                            try {
                                                flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
                                                setCurrentVisibleIndex(0);
                                                setHasScrolledToTarget(true);
                                            } catch {
                                                // Failed to scroll
                                            }
                                        }
                                    }, 200);
                                    return newPosts;
                                });
                            });
                        }
                        return currentPosts;
                    });
                }, 100);
            }

            setIsLoading(false);
        };

        load();

        return () => {
            isMounted = false;
        };
    }, [targetPostId, hasScrolledToTarget, fetchPostById, fetchVideos]);

    // Load more handler
    const handleLoadMore = useCallback(async () => {
        if (loadingMore || !hasMore || !nextCursor) return;
        setLoadingMore(true);
        try {
            await fetchVideos(nextCursor, false);
        } finally {
            setLoadingMore(false);
        }
    }, [fetchVideos, hasMore, nextCursor, loadingMore]);

    // Viewable items changed handler
    const handleViewableItemsChangedRef = useRef(({ viewableItems }: any) => {
        if (viewableItems?.length > 0) {
            const mostVisibleItem = viewableItems.find((item: any) => item.isViewable) || viewableItems[0];
            const index = mostVisibleItem?.index;
            if (index != null && index !== undefined) {
                setCurrentVisibleIndex(index);
            }
        } else if (viewableItems?.length === 0) {
            setCurrentVisibleIndex(-1);
        }
    });

    const handleViewableItemsChanged = useCallback((info: any) => {
        handleViewableItemsChangedRef.current(info);
    }, []);

    // Handlers
    const handleLike = useCallback(async (postId: string, isLiked: boolean) => {
        try {
            if (isLiked) {
                await unlikePost({ postId, type: 'post' });
            } else {
                await likePost({ postId, type: 'post' });
            }
            setPosts(prev => prev.map(p =>
                p.id === postId
                    ? { ...p, isLiked: !isLiked, stats: { ...p.stats, likesCount: isLiked ? p.stats.likesCount - 1 : p.stats.likesCount + 1 } }
                    : p
            ));
        } catch (error) {
            toast.error(t('common.error'), {
                description: t('videos.action_failed') || 'Action failed. Please try again.',
            });
        }
    }, [likePost, unlikePost, t]);

    const handleComment = useCallback((postId: string) => {
        router.push(`/p/${postId}/reply`);
    }, [router]);

    const handleRepost = useCallback(async (postId: string, isReposted: boolean) => {
        try {
            if (isReposted) {
                await unrepostPost({ postId });
            } else {
                await repostPost({ postId });
            }
            setPosts(prev => prev.map(p =>
                p.id === postId
                    ? { ...p, isReposted: !isReposted, stats: { ...p.stats, repostsCount: isReposted ? p.stats.repostsCount - 1 : p.stats.repostsCount + 1 } }
                    : p
            ));
        } catch (error) {
            toast.error(t('common.error'), {
                description: t('videos.action_failed') || 'Action failed. Please try again.',
            });
        }
    }, [repostPost, unrepostPost, t]);

    const handleShare = useCallback(async (post: VideoPost) => {
        try {
            const postUrl = `https://mention.earth/p/${post.id}`;
            const contentText = post?.content?.text || '';
            const user = post?.user || {};
            const name = typeof user.name === 'string' ? user.name : user.name || user.handle || t('common.someone');
            const handle = user.handle || '';
            const shareMessage = contentText
                ? `${name}${handle ? ` (@${handle})` : ''}: ${contentText}`
                : `${name}${handle ? ` (@${handle})` : ''} ${t('videos.shared_a_post')}`;

            const shareTitle = `${name} ${t('videos.on_mention')}`;

            if (Platform.OS === 'web') {
                if (navigator.share) {
                    await navigator.share({
                        title: shareTitle,
                        text: shareMessage,
                        url: postUrl,
                    });
                } else if (navigator.clipboard) {
                    await navigator.clipboard.writeText(`${shareMessage}\n\n${postUrl}`);
                    toast.success(t('videos.link_copied'), {
                        description: t('videos.link_copied_to_clipboard'),
                    });
                } else {
                    toast.error(t('videos.sharing_not_available'), {
                        description: t('videos.copy_link_manually'),
                    });
                }
            } else {
                await Share.share({
                    message: `${shareMessage}\n\n${postUrl}`,
                    url: postUrl,
                    title: shareTitle,
                });
            }
        } catch (error: any) {
            if (error?.message !== 'User did not share' && error?.code !== 'ERR_SHARE_CANCELLED') {
                toast.error(t('videos.share_failed'), {
                    description: t('common.error'),
                });
            }
        }
    }, [t]);

    const formatCount = useCallback((count: number): string => {
        if (count == null || isNaN(count)) return '0';
        const numCount = Number(count);
        if (numCount >= 1000000) return `${(numCount / 1000000).toFixed(1)}M`;
        if (numCount >= 1000) return `${(numCount / 1000).toFixed(1)}K`;
        return numCount.toString();
    }, []);

    const handleMuteChange = useCallback((muted: boolean) => {
        useVideoMuteStore.getState().setMuted(muted);
    }, []);

    // Load muted state on mount
    useEffect(() => {
        loadMutedState();
    }, [loadMutedState]);

    // Memoized render item
    const renderVideoItem = useCallback(({ item, index }: { item: VideoPost; index: number }) => (
        <VideoItem
            item={item}
            index={index}
            isVisible={index === currentVisibleIndex}
            theme={theme}
            onLike={handleLike}
            onComment={handleComment}
            onRepost={handleRepost}
            onShare={handleShare}
            formatCount={formatCount}
            globalMuted={globalMuted}
            onMuteChange={handleMuteChange}
            bottomBarHeight={bottomBarHeight}
            t={t}
        />
    ), [currentVisibleIndex, theme, handleLike, handleComment, handleRepost, handleShare, formatCount, globalMuted, handleMuteChange, bottomBarHeight, t]);

    const keyExtractor = useCallback((item: VideoPost) => item.id, []);

    // Memoized getItemLayout
    const getItemLayout = useCallback((_: any, index: number) => ({
        length: WINDOW_HEIGHT,
        offset: WINDOW_HEIGHT * index,
        index,
    }), []);

    // Memoized onMomentumScrollEnd
    const onMomentumScrollEnd = useCallback((event: any) => {
        const offsetY = event.nativeEvent.contentOffset.y;
        const index = Math.round(offsetY / WINDOW_HEIGHT);
        if (flatListRef.current && index >= 0 && index < posts.length) {
            try {
                flatListRef.current.scrollToIndex({
                    index,
                    animated: true,
                    viewPosition: 0,
                });
            } catch {
                try {
                    flatListRef.current.scrollToOffset({
                        offset: index * WINDOW_HEIGHT,
                        animated: true,
                    });
                } catch {
                    // Ignore scroll errors
                }
            }
        }
    }, [posts.length]);

    return (
        <>
            <SEO
                title={t('seo.videos.title')}
                description={t('seo.videos.description')}
            />
            <ThemedView style={styles.container}>
                <LoadingTopSpinner showLoading={isLoading && posts.length === 0} />

            {posts.length > 0 && (
                <FlatList
                    ref={flatListRef}
                    data={posts}
                    renderItem={renderVideoItem}
                    keyExtractor={keyExtractor}
                    pagingEnabled
                    snapToInterval={WINDOW_HEIGHT}
                    snapToAlignment="start"
                    decelerationRate={0.85}
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={FLATLIST_CONFIG.END_REACHED_THRESHOLD}
                    onViewableItemsChanged={handleViewableItemsChanged}
                    viewabilityConfig={VIEWABILITY_CONFIG}
                    showsVerticalScrollIndicator={false}
                    removeClippedSubviews
                    maxToRenderPerBatch={FLATLIST_CONFIG.MAX_TO_RENDER_PER_BATCH}
                    windowSize={FLATLIST_CONFIG.WINDOW_SIZE}
                    initialNumToRender={FLATLIST_CONFIG.INITIAL_NUM_TO_RENDER}
                    style={styles.list}
                    contentContainerStyle={styles.listContent}
                    contentInsetAdjustmentBehavior="never"
                    getItemLayout={getItemLayout}
                    onMomentumScrollEnd={onMomentumScrollEnd}
                />
            )}

            {!isLoading && posts.length === 0 && (
                <View style={styles.emptyState}>
                    <Ionicons name="videocam-outline" size={64} color={theme.colors.textSecondary} />
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        {t('videos.no_video_posts_yet')}
                    </Text>
                    <Text style={[styles.emptyText, styles.emptySubtext, { color: theme.colors.textSecondary }]}>
                        {t('videos.no_posts_found')}
                    </Text>
                </View>
            )}

            {loadingMore && (
                <View style={styles.loadingMore}>
                    <View style={[styles.loadingIndicator, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Text style={[styles.loadingText, { color: theme.colors.textSecondary }]}>
                            {t('videos.loading')}
                        </Text>
                    </View>
                </View>
            )}
        </ThemedView>
        </>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        width: '100%',
        height: '100%',
        backgroundColor: '#000000',
    },
    list: {
        flex: 1,
    },
    listContent: {
        flexGrow: 1,
    },
    videoContainer: {
        width: '100%',
        height: WINDOW_HEIGHT,
        backgroundColor: '#000000',
        position: 'relative',
        overflow: 'hidden',
        justifyContent: 'center',
        alignItems: 'center',
    },
    video: {
        flex: 1,
        width: '100%',
        height: '100%',
        alignSelf: 'center',
    },
    videoPlaceholder: {
        justifyContent: 'center',
        alignItems: 'center',
    },
    errorText: {
        marginTop: 8,
        fontSize: 12,
    },
    muteButton: {
        position: 'absolute',
        top: 50,
        right: 16,
        zIndex: 10,
    },
    muteButtonInner: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.2)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 4,
    },
    overlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 16,
        backgroundColor: 'transparent',
        zIndex: 5,
    },
    gradientOverlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 180,
        pointerEvents: 'none',
    },
    rightActions: {
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 24,
        zIndex: 6,
        paddingRight: 4,
    },
    actionButton: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        minWidth: 40,
    },
    actionIcon: {
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },
    actionCount: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '600',
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 2,
        marginTop: 0,
        textAlign: 'center',
    },
    bottomInfo: {
        flex: 1,
        justifyContent: 'flex-end',
        marginRight: 70,
        maxWidth: '70%',
        zIndex: 6,
        paddingBottom: 0,
    },
    userInfo: {
        gap: 8,
    },
    userHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    userAvatar: {
        borderWidth: 0,
    },
    userNameContainer: {
        flex: 1,
    },
    userNameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    userFullName: {
        color: '#FFFFFF',
        fontSize: 15,
        fontWeight: '600',
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },
    userHandle: {
        color: 'rgba(255, 255, 255, 0.9)',
        fontSize: 14,
        fontWeight: '600',
        textShadowColor: 'rgba(0, 0, 0, 0.9)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 4,
    },
    verifiedIcon: {
        marginLeft: 2,
    },
    postText: {
        color: '#FFFFFF',
        fontSize: 14,
        lineHeight: 18,
        fontWeight: '400',
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
        marginTop: 4,
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 20,
        paddingHorizontal: 32,
    },
    emptyText: {
        fontSize: 18,
        fontWeight: '700',
        textAlign: 'center',
    },
    emptySubtext: {
        fontSize: 14,
        fontWeight: '500',
        marginTop: 4,
        textAlign: 'center',
        opacity: 0.8,
    },
    loadingMore: {
        position: 'absolute',
        bottom: 40,
        left: 0,
        right: 0,
        alignItems: 'center',
    },
    loadingIndicator: {
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 20,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 4,
    },
    loadingText: {
        fontSize: 14,
        fontWeight: '600',
    },
});
