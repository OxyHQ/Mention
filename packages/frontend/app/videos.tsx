import React, { useCallback, useEffect, useRef, useState, useMemo, memo } from 'react';
import { StyleSheet, View, Text, Dimensions, Pressable, FlatList, Platform, Alert, Share } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { usePostsStore } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import LoadingTopSpinner from '@/components/LoadingTopSpinner';
import Avatar from '@/components/Avatar';

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
    const [isMuted, setIsMuted] = useState(globalMuted);
    const [videoError, setVideoError] = useState(false);

    // Create player instance with proper configuration
    const player = useVideoPlayer(item.videoUrl || '', (player) => {
        if (player) {
            player.loop = true;
            player.muted = true;
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
                <View style={styles.gradientOverlay} />

                <View style={styles.bottomInfo}>
                    <View style={styles.userInfo}>
                        <View style={styles.userHeader}>
                            <Avatar
                                source={avatarSource}
                                size={48}
                                verified={item.user?.verified || false}
                                style={styles.userAvatar}
                            />
                            <View style={styles.userNameContainer}>
                                <View style={styles.userNameRow}>
                                    <Text style={styles.userFullName} numberOfLines={1}>
                                        {userName}
                                    </Text>
                                    {item.user?.verified && (
                                        <Ionicons name="checkmark-circle" size={16} color="#1DA1F2" style={styles.verifiedIcon} />
                                    )}
                                </View>
                                <Text style={styles.userHandle}>@{userHandle}</Text>
                            </View>
                        </View>
                        {postText ? (
                            <Text style={styles.postText} numberOfLines={3}>
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
                    <Pressable
                        style={styles.actionButton}
                        onPress={() => onShare(item)}
                        hitSlop={HIT_SLOP}
                    >
                        <View style={styles.actionButtonIcon}>
                            <Ionicons name="share-outline" size={32} color="white" />
                        </View>
                    </Pressable>
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
}

const ActionButton = memo<ActionButtonProps>(({ icon, count, isActive, activeColor, onPress, formatCount }) => (
    <Pressable style={styles.actionButton} onPress={onPress} hitSlop={HIT_SLOP}>
        <View style={[styles.actionButtonIcon, isActive && activeColor && { backgroundColor: `rgba(${hexToRgb(activeColor)}, 0.2)`, borderColor: `rgba(${hexToRgb(activeColor)}, 0.4)` }]}>
            <Ionicons
                name={icon as any}
                size={32}
                color={isActive && activeColor ? activeColor : "white"}
            />
        </View>
        <Text style={[styles.actionCount, isActive && activeColor && { color: activeColor }]}>
            {formatCount(count)}
        </Text>
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

const VideosScreen: React.FC = () => {
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
    const [globalMuted, setGlobalMuted] = useState(true);
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
        } catch {
            // Silently handle errors
        }
    }, [likePost, unlikePost]);

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
        } catch {
            // Silently handle errors
        }
    }, [repostPost, unrepostPost]);

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
                    Alert.alert(t('videos.link_copied'), t('videos.link_copied_to_clipboard'));
                } else {
                    Alert.alert(t('videos.sharing_not_available'), t('videos.copy_link_manually'));
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
                Alert.alert(t('common.error'), t('videos.share_failed'));
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
        setGlobalMuted(muted);
    }, []);

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
    );
};

export default VideosScreen;

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
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.1)',
    },
    overlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingTop: 20,
        backgroundColor: 'transparent',
        zIndex: 5,
    },
    gradientOverlay: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '70%',
        backgroundColor: 'rgba(0, 0, 0, 0.3)',
        pointerEvents: 'none',
    },
    rightActions: {
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: 24,
        zIndex: 6,
    },
    actionButton: {
        alignItems: 'center',
        gap: 6,
        minWidth: 44,
    },
    actionButtonIcon: {
        width: 48,
        height: 48,
        borderRadius: 24,
        backgroundColor: 'rgba(0, 0, 0, 0.4)',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.15)',
    },
    actionCount: {
        color: '#FFFFFF',
        fontSize: 13,
        fontWeight: '700',
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 2,
    },
    bottomInfo: {
        flex: 1,
        justifyContent: 'flex-end',
        marginRight: 80,
        maxWidth: '70%',
        zIndex: 6,
    },
    userInfo: {
        gap: 10,
    },
    userHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    userAvatar: {
        borderWidth: 2,
        borderColor: 'rgba(255, 255, 255, 0.3)',
    },
    userNameContainer: {
        flex: 1,
        gap: 4,
    },
    userNameRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    userFullName: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '700',
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },
    userHandle: {
        color: 'rgba(255, 255, 255, 0.85)',
        fontSize: 14,
        fontWeight: '600',
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },
    verifiedIcon: {
        marginLeft: 2,
    },
    postText: {
        color: 'rgba(255, 255, 255, 0.95)',
        fontSize: 15,
        lineHeight: 22,
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 3,
    },
    emptyState: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        gap: 16,
    },
    emptyText: {
        fontSize: 16,
        fontWeight: '500',
    },
    emptySubtext: {
        fontSize: 12,
        marginTop: 8,
    },
    loadingMore: {
        position: 'absolute',
        bottom: 40,
        left: 0,
        right: 0,
        alignItems: 'center',
    },
    loadingIndicator: {
        paddingHorizontal: 16,
        paddingVertical: 8,
        borderRadius: 16,
    },
    loadingText: {
        fontSize: 14,
    },
});
