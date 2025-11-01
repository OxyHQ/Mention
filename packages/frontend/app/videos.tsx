import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View, Text, Dimensions, Pressable, FlatList, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { usePostsStore } from '@/stores/postsStore';
import { feedService } from '@/services/feedService';
import LoadingTopSpinner from '@/components/LoadingTopSpinner';
import Avatar from '@/components/Avatar';

const windowHeight = Dimensions.get('window').height;

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
    isSaved?: boolean;
    createdAt: string;
}

// Separate VideoItem component to properly use hooks
const VideoItem: React.FC<{
    item: VideoPost;
    index: number;
    isVisible: boolean;
    theme: any;
    onLike: (postId: string, isLiked: boolean) => void;
    formatCount: (count: number) => string;
    globalMuted: boolean;
    onMuteChange: (muted: boolean) => void;
    bottomBarHeight: number;
}> = ({ item, index, isVisible, theme, onLike, formatCount, globalMuted, onMuteChange, bottomBarHeight }) => {
    const { oxyServices } = useOxy();

    // Create player instance - each video gets its own unique player
    // Use the video URL and item ID as part of the key to ensure unique instances
    const player = useVideoPlayer(item.videoUrl || '', (player) => {
        if (player) {
            player.loop = false;
            // Start muted for autoplay (browser policy requires this)
            player.muted = true;
        }
    });

    // Track local muted state - sync with global state
    const [isMuted, setIsMuted] = React.useState(globalMuted);
    const [hasUserInteracted, setHasUserInteracted] = React.useState(false);
    const [videoError, setVideoError] = React.useState(false);

    // Sync with global muted state
    React.useEffect(() => {
        if (player && player.muted !== globalMuted) {
            player.muted = globalMuted;
            setIsMuted(globalMuted);
        }
    }, [globalMuted, player]);

    // Toggle mute/unmute - updates global state so all videos follow
    const toggleMute = useCallback(() => {
        if (!player) return;

        // Mark that user has interacted
        setHasUserInteracted(true);

        try {
            const newMutedState = !isMuted;

            // Update global mute state (this will propagate to all videos)
            onMuteChange(newMutedState);

            // Update local player and state
            player.muted = newMutedState;
            setIsMuted(newMutedState);

            // If unmuting, try to play with audio
            if (!newMutedState && isVisible) {
                try {
                    const playResult: any = player.play();
                    // Check if play() returns a Promise (may be void on some platforms)
                    if (playResult != null && typeof playResult === 'object' && 'catch' in playResult && typeof playResult.catch === 'function') {
                        playResult.catch((error: any) => {
                            // If unmuting fails, revert to muted
                            console.log('Unmuting failed:', error?.message || error);
                            onMuteChange(true);
                            player.muted = true;
                            setIsMuted(true);
                        });
                    }
                } catch (error) {
                    console.log('Error calling play:', error);
                }
            }
        } catch (error) {
            console.log('Error toggling mute:', error);
            // On error, keep current state
        }
    }, [player, isMuted, isVisible, onMuteChange]);

    // Pause/play based on visibility with error handling - Instagram Reels style
    // Only play when video is fully visible, pause immediately when not
    React.useEffect(() => {
        if (!player || !item.videoUrl) return;

        // Ensure player methods exist before calling
        if (typeof player.play !== 'function' || typeof player.pause !== 'function') {
            return;
        }

        // Small delay to prevent flickering when scrolling fast
        const timeoutId = setTimeout(() => {
            if (isVisible) {
                // Try to play, but handle autoplay policy errors gracefully
                // Use global muted state
                try {
                    // Ensure player muted state matches global state
                    if (player.muted !== globalMuted) {
                        player.muted = globalMuted;
                        setIsMuted(globalMuted);
                    }

                    try {
                        const playResult: any = player.play();
                        // Check if play() returns a Promise (may be void on some platforms)
                        if (playResult != null && typeof playResult === 'object' && 'catch' in playResult && typeof playResult.catch === 'function') {
                            playResult.catch((error: any) => {
                                // Autoplay blocked - this is expected without user interaction
                                // Videos will start muted, user can unmute by interacting
                                if (error) {
                                    console.log('Autoplay blocked:', error?.message || error);
                                }
                            });
                        }
                    } catch (playError) {
                        // Handle if play() throws synchronously
                        console.log('Error calling play:', playError);
                    }
                } catch (error) {
                    // Handle synchronous errors
                    console.log('Error calling play:', error);
                }
            } else {
                // Immediately pause when not visible
                try {
                    player.pause();
                } catch (error) {
                    console.log('Error calling pause:', error);
                }
            }
        }, isVisible ? 50 : 0); // Small delay for play, immediate pause

        return () => clearTimeout(timeoutId);
    }, [isVisible, player, item.videoUrl, globalMuted]);

    // Only render VideoView if we have both a valid URL and player instance
    // Use item.id and index as part of key to ensure React creates new instances
    const videoKey = `videoview-${item.id}-${index}`;

    return (
        <View style={styles.videoContainer} key={`video-container-${item.id}-${index}`}>
            {item.videoUrl && player && !videoError ? (
                <VideoView
                    key={videoKey}
                    player={player}
                    style={styles.video}
                    contentFit="contain"
                    nativeControls={false}
                    allowsFullscreen={false}
                    allowsPictureInPicture={false}
                    crossOrigin="anonymous"
                />
            ) : (
                <View style={[styles.video, { backgroundColor: theme.colors.backgroundSecondary, justifyContent: 'center', alignItems: 'center' }]}>
                    <Ionicons name="videocam-outline" size={48} color={theme.colors.textSecondary} />
                    {videoError && (
                        <Text style={{ color: theme.colors.textSecondary, marginTop: 8, fontSize: 12 }}>
                            Video unavailable
                        </Text>
                    )}
                </View>
            )}

            {/* Mute/Unmute button */}
            <Pressable
                style={styles.muteButton}
                onPress={toggleMute}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
                <View style={styles.muteButtonInner}>
                    <Ionicons
                        name={isMuted ? "volume-mute" : "volume-high"}
                        size={22}
                        color="white"
                    />
                </View>
            </Pressable>

            {/* Overlay with user info and actions */}
            <View style={[styles.overlay, { paddingBottom: bottomBarHeight + 20 }]}>
                {/* Gradient overlay for better text readability */}
                <View style={styles.gradientOverlay} />

                {/* Bottom user info */}
                <View style={styles.bottomInfo}>
                    <View style={styles.userInfo}>
                        <View style={styles.userHeader}>
                            <Avatar
                                source={item.user?.avatar ? oxyServices?.getFileDownloadUrl(item.user.avatar) : undefined}
                                size={48}
                                verified={item.user?.verified || false}
                                style={styles.userAvatar}
                            />
                            <View style={styles.userNameContainer}>
                                <View style={styles.userNameRow}>
                                    <Text style={styles.userFullName} numberOfLines={1}>
                                        {item.user?.name || ''}
                                    </Text>
                                    {item.user?.verified ? (
                                        <Ionicons name="checkmark-circle" size={16} color="#1DA1F2" style={styles.verifiedIcon} />
                                    ) : null}
                                </View>
                                <Text style={styles.userHandle}>@{item.user?.handle || 'unknown'}</Text>
                            </View>
                        </View>
                        {item.content?.text && item.content.text.trim() ? (
                            <Text style={styles.postText} numberOfLines={3}>
                                {item.content.text}
                            </Text>
                        ) : null}
                    </View>
                </View>

                {/* Right side actions */}
                <View style={styles.rightActions}>
                    <Pressable
                        style={styles.actionButton}
                        onPress={() => onLike(item.id, item.isLiked || false)}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                        <View style={[styles.actionButtonIcon, item.isLiked ? styles.actionButtonIconActive : null]}>
                            <Ionicons
                                name={item.isLiked ? "heart" : "heart-outline"}
                                size={32}
                                color={item.isLiked ? "#FF3040" : "white"}
                            />
                        </View>
                        <Text style={[styles.actionCount, item.isLiked ? styles.actionCountActive : null]}>
                            {formatCount(item.stats?.likesCount || 0)}
                        </Text>
                    </Pressable>

                    <Pressable
                        style={styles.actionButton}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                        <View style={styles.actionButtonIcon}>
                            <Ionicons name="chatbubble-outline" size={32} color="white" />
                        </View>
                        <Text style={styles.actionCount}>{formatCount(item.stats?.commentsCount || 0)}</Text>
                    </Pressable>

                    <Pressable
                        style={styles.actionButton}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                        <View style={styles.actionButtonIcon}>
                            <Ionicons name="repeat-outline" size={32} color="white" />
                        </View>
                        <Text style={styles.actionCount}>{formatCount(item.stats?.repostsCount || 0)}</Text>
                    </Pressable>

                    <Pressable
                        style={styles.actionButton}
                        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                        <View style={styles.actionButtonIcon}>
                            <Ionicons name="share-outline" size={32} color="white" />
                        </View>
                    </Pressable>
                </View>
            </View>
        </View>
    );
};

const VideosScreen: React.FC = () => {
    const { t } = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { oxyServices } = useOxy();
    const { likePost, unlikePost, getPostById } = usePostsStore();

    const [posts, setPosts] = useState<VideoPost[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [hasMore, setHasMore] = useState(true);
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    const [loadingMore, setLoadingMore] = useState(false);
    const [currentVisibleIndex, setCurrentVisibleIndex] = useState(0);
    const [globalMuted, setGlobalMuted] = useState(true); // Global mute state for all videos

    const flatListRef = useRef<FlatList<VideoPost>>(null);

    // Filter posts to only include those with exactly one video (no other media) AND valid video URL
    const filterVideoPosts = useCallback((allPosts: any[]): VideoPost[] => {
        return allPosts
            .filter((post: any) => {
                // Get media items from various possible locations
                const media = post?.content?.media || [];
                const mediaIds = post?.mediaIds || post?.allMediaIds || [];

                // Count ALL media items (images, videos, etc.)
                const totalMediaCount = media.length;
                const totalMediaIdsCount = mediaIds.length;

                // Count videos specifically
                const videoCount = media.filter((m: any) => m?.type === 'video').length;

                // Post should have:
                // 1. Exactly ONE video AND no other media (totalMediaCount === 1 AND videoCount === 1)
                // Only include posts with explicit video type - don't assume single mediaId is a video
                const hasOnlyOneMedia = totalMediaCount === 1 && videoCount === 1;

                // Also check if videoMedia exists even if media array structure is different
                const hasVideoMedia = media.some((m: any) => m?.type === 'video');

                return hasOnlyOneMedia || (hasVideoMedia && videoCount === 1);
            })
            .map((post: any) => {
                const media = post?.content?.media || [];
                const mediaIds = post?.mediaIds || post?.allMediaIds || [];
                const videoMedia = media.find((m: any) => m?.type === 'video');

                // Get video URL - only from explicit video media, not from media IDs
                let videoUrl = videoMedia?.id;

                // If we have a videoMedia with a URL property, use that instead
                if (videoMedia?.url) {
                    videoUrl = videoMedia.url;
                }

                // Only use mediaIds if we have explicit video type confirmation
                if (!videoUrl && mediaIds.length === 1 && videoMedia) {
                    videoUrl = mediaIds[0];
                }

                // Resolve URL using Oxy services
                if (videoUrl && oxyServices?.getFileDownloadUrl) {
                    // Only resolve if it's not already a full URL
                    if (!videoUrl.startsWith('http://') && !videoUrl.startsWith('https://')) {
                        videoUrl = oxyServices.getFileDownloadUrl(videoUrl);
                    }
                }

                return {
                    ...post,
                    videoUrl,
                } as VideoPost;
            })
            // Filter out posts without valid video URLs
            .filter((post: VideoPost) => {
                return post.videoUrl && post.videoUrl.trim().length > 0;
            });
    }, [oxyServices]);

    // Fetch initial video posts
    const fetchVideos = useCallback(async (cursor?: string) => {
        try {
            const state = usePostsStore.getState();

            // Use media feed type to get posts with media
            const response = await feedService.getFeed({
                type: 'media',
                cursor,
                limit: 20,
            });

            const videoPosts = filterVideoPosts(response.items || []);

            if (cursor) {
                // Loading more
                setPosts(prev => [...prev, ...videoPosts]);
            } else {
                // Initial load
                setPosts(videoPosts);
            }

            setHasMore(response.hasMore || false);
            setNextCursor(response.nextCursor);

            return videoPosts;
        } catch (error) {
            console.error('Error fetching videos:', error);
            return [];
        }
    }, [filterVideoPosts]);

    // Initial load
    useEffect(() => {
        const load = async () => {
            setIsLoading(true);
            const videoPosts = await fetchVideos();
            console.log('Loaded video posts:', videoPosts.length);
            setIsLoading(false);
        };
        load();
    }, [fetchVideos]);

    // Load more when scrolling near end
    const handleLoadMore = useCallback(async () => {
        if (loadingMore || !hasMore || !nextCursor) return;

        setLoadingMore(true);
        await fetchVideos(nextCursor);
        setLoadingMore(false);
    }, [fetchVideos, hasMore, nextCursor, loadingMore]);

    // Handle viewable items changed for auto-play - Instagram Reels style
    // Must be stable reference - cannot change on the fly per FlatList requirements
    const handleViewableItemsChangedRef = useRef(({ viewableItems }: any) => {
        if (viewableItems && viewableItems.length > 0) {
            // Get the most visible item (should be the one in center)
            const mostVisibleItem = viewableItems.find((item: any) => item.isViewable) || viewableItems[0];
            const index = mostVisibleItem?.index;

            if (index !== null && index !== undefined) {
                setCurrentVisibleIndex(index);
            }
        } else if (viewableItems && viewableItems.length === 0) {
            // No items visible - pause all
            setCurrentVisibleIndex(-1);
        }
    });

    const handleViewableItemsChanged = useCallback((info: any) => {
        handleViewableItemsChangedRef.current(info);
    }, []);

    const viewabilityConfig = {
        itemVisiblePercentThreshold: 60, // Higher threshold for better detection
        waitForInteraction: false,
        minimumViewTime: 100, // Minimum time item must be visible
    };

    // Handle like/unlike
    const handleLike = useCallback(async (postId: string, isLiked: boolean) => {
        try {
            if (isLiked) {
                await unlikePost({ postId, type: 'post' });
            } else {
                await likePost({ postId, type: 'post' });
            }

            // Update local state
            setPosts(prev => prev.map(p =>
                p.id === postId
                    ? {
                        ...p,
                        isLiked: !isLiked,
                        stats: {
                            ...p.stats,
                            likesCount: isLiked ? p.stats.likesCount - 1 : p.stats.likesCount + 1,
                        }
                    }
                    : p
            ));
        } catch (error) {
            console.error('Error toggling like:', error);
        }
    }, [likePost, unlikePost]);

    const formatCount = useCallback((count: number): string => {
        if (count == null || isNaN(count)) {
            return '0';
        }
        const numCount = Number(count);
        if (numCount >= 1000000) {
            return `${(numCount / 1000000).toFixed(1)}M`;
        } else if (numCount >= 1000) {
            return `${(numCount / 1000).toFixed(1)}K`;
        }
        return numCount.toString();
    }, []);

    // Handle mute state change - updates all videos
    const handleMuteChange = useCallback((muted: boolean) => {
        setGlobalMuted(muted);
    }, []);

    // Render a single video item
    const renderVideoItem = useCallback(({ item, index }: { item: VideoPost; index: number }) => {
        const isVisible = index === currentVisibleIndex;
        // Calculate bottom bar height: 60px base + safe area insets
        const bottomBarHeight = Platform.OS === 'web' ? 60 : 60 + insets.bottom;
        return (
            <VideoItem
                item={item}
                index={index}
                isVisible={isVisible}
                theme={theme}
                onLike={handleLike}
                formatCount={formatCount}
                globalMuted={globalMuted}
                onMuteChange={handleMuteChange}
                bottomBarHeight={bottomBarHeight}
            />
        );
    }, [currentVisibleIndex, handleLike, theme, formatCount, globalMuted, handleMuteChange, insets.bottom]);

    const keyExtractor = useCallback((item: VideoPost, index: number) => item.id || index.toString(), []);

    return (
        <ThemedView style={[styles.container, { paddingTop: 0, marginTop: 0 }]}>
            <LoadingTopSpinner showLoading={isLoading && posts.length === 0} />

            {posts.length > 0 && (
                <FlatList
                    ref={flatListRef}
                    data={posts}
                    renderItem={renderVideoItem}
                    keyExtractor={keyExtractor}
                    pagingEnabled={true}
                    snapToInterval={windowHeight}
                    snapToAlignment="start"
                    decelerationRate={0.85} // Slightly slower for smoother magnetic effect
                    onEndReached={handleLoadMore}
                    onEndReachedThreshold={0.5}
                    onViewableItemsChanged={handleViewableItemsChanged}
                    viewabilityConfig={viewabilityConfig}
                    showsVerticalScrollIndicator={false}
                    removeClippedSubviews={true}
                    maxToRenderPerBatch={2}
                    windowSize={3}
                    initialNumToRender={2}
                    style={{ flex: 1 }}
                    contentContainerStyle={{ flexGrow: 1, paddingTop: 0, paddingBottom: 0 }}
                    contentInsetAdjustmentBehavior="never"
                    getItemLayout={(_, index) => ({
                        length: windowHeight,
                        offset: windowHeight * index,
                        index,
                    })}
                    onMomentumScrollEnd={(event) => {
                        // Additional snap to nearest item on scroll end - Instagram Reels style
                        const offsetY = event.nativeEvent.contentOffset.y;
                        const index = Math.round(offsetY / windowHeight);
                        if (flatListRef.current && index >= 0 && index < posts.length) {
                            try {
                                flatListRef.current.scrollToIndex({
                                    index,
                                    animated: true,
                                    viewPosition: 0 // Align to top
                                });
                            } catch (error) {
                                // Fallback to scrollToOffset if scrollToIndex fails
                                try {
                                    flatListRef.current.scrollToOffset({
                                        offset: index * windowHeight,
                                        animated: true
                                    });
                                } catch (e) {
                                    // Ignore scroll errors
                                }
                            }
                        }
                    }}
                />
            )}

            {!isLoading && posts.length === 0 && (
                <View style={styles.emptyState}>
                    <Ionicons name="videocam-outline" size={64} color={theme.colors.textSecondary} />
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        {t('No video posts yet')}
                    </Text>
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary, fontSize: 12, marginTop: 8 }]}>
                        {isLoading ? 'Loading...' : 'No posts found'}
                    </Text>
                </View>
            )}

            {loadingMore && (
                <View style={styles.loadingMore}>
                    <View style={[styles.loadingIndicator, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Text style={{ color: theme.colors.textSecondary }}>Loading...</Text>
                    </View>
                </View>
            )}
        </ThemedView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        width: '100%',
        height: '100%',
        backgroundColor: 'black',
        paddingTop: 0,
        marginTop: 0,
        paddingBottom: 0,
        marginBottom: 0,
    },
    videoContainer: {
        width: '100%',
        height: windowHeight,
        backgroundColor: 'black',
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
    actionButtonIconActive: {
        backgroundColor: 'rgba(255, 48, 64, 0.2)',
        borderColor: 'rgba(255, 48, 64, 0.4)',
    },
    actionCount: {
        color: 'white',
        fontSize: 13,
        fontWeight: '700',
        textShadowColor: 'rgba(0, 0, 0, 0.8)',
        textShadowOffset: { width: 0, height: 1 },
        textShadowRadius: 2,
    },
    actionCountActive: {
        color: '#FF3040',
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
        color: 'white',
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
});

export default VideosScreen;

