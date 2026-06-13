import React, { useCallback, useEffect, useRef, useState, useMemo, memo } from 'react';
import { StyleSheet, View, Text, Pressable, FlatList, Platform, Share, useWindowDimensions, type ViewStyle, type TextStyle, type ImageStyle } from 'react-native';
import { Image } from 'expo-image';
import { show as toast } from '@oxyhq/bloom/toast';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { VideoView, useVideoPlayer, type VideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { usePostsStore } from '@/stores/postsStore';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import { feedService } from '@/services/feedService';
import { proxyExternalUrl, videoPosterUrl } from '@/utils/imageUrlCache';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { Avatar } from '@oxyhq/bloom/avatar';
import SEO from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { Video } from '@/assets/icons/video-icon';
import { formatCompactNumber } from '@/utils/formatNumber';

// ── Tuning constants ─────────────────────────────────────────────
// One-screen vertical pager: keep the live-player window tight so only the
// active video and its neighbours hold a decoder.
const FEED_PAGE_LIMIT = 20;
// Players are live only for the active index ± this radius.
const ACTIVE_WINDOW_RADIUS = 1;
// FlatList must keep the window rows mounted (poster) so they can promote to a
// live player without a remount; WINDOW_SIZE is in screens (one screen = one row).
const FLATLIST_CONFIG = {
    INITIAL_NUM_TO_RENDER: 2,
    MAX_TO_RENDER_PER_BATCH: 2,
    WINDOW_SIZE: 3,
    END_REACHED_THRESHOLD: 0.4,
} as const;

const VIEWABILITY_CONFIG = {
    itemVisiblePercentThreshold: 60,
    waitForInteraction: false,
    minimumViewTime: 100,
} as const;

// When a `videos` page yields zero NEW posts but more pages exist, walk forward
// up to this many extra pages so the reel never dead-ends prematurely.
const MAX_AUTO_CONTINUE_PAGES = 3;

const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 };

const GRADIENT_COLORS = ['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.8)', '#000000'] as const;
const GRADIENT_LOCATIONS = [0, 0.4, 0.7, 1] as const;
const LIKE_ACTIVE_COLOR = '#FF3040';
const BOOST_ACTIVE_COLOR = '#10B981';
const VERIFIED_COLOR = '#1DA1F2';

// ── Types ────────────────────────────────────────────────────────
// Runtime media reference. The shared `MediaItem` only declares `id` + `type`,
// but hydrated/federated posts also carry an absolute `url`, so we type the
// superset we actually read here.
interface MediaRef {
    id?: string;
    url?: string;
    type?: 'image' | 'video' | 'gif';
}

interface RawPost {
    id?: string;
    _id?: string;
    user?: VideoPost['user'];
    content?: { text?: string; media?: MediaRef[] };
    videoUrl?: string;
    stats?: VideoPost['stats'];
    isLiked?: boolean;
    isBoosted?: boolean;
    isSaved?: boolean;
    createdAt?: string;
}

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
        media?: MediaRef[];
    };
    videoUrl: string;
    posterUrl?: string;
    stats: {
        likesCount: number;
        boostsCount: number;
        commentsCount: number;
        viewsCount: number;
    };
    isLiked?: boolean;
    isBoosted?: boolean;
    isSaved?: boolean;
    createdAt: string;
}

interface ViewableItem {
    index: number | null;
    isViewable: boolean;
}

interface VideoItemProps {
    item: VideoPost;
    isActive: boolean;
    isNear: boolean;
    theme: ReturnType<typeof useTheme>;
    onLike: (postId: string, isLiked: boolean) => void;
    onComment: (postId: string) => void;
    onBoost: (postId: string, isBoosted: boolean) => void;
    onShare: (post: VideoPost) => void;
    formatCompactNumber: (count: number) => string;
    globalMuted: boolean;
    onMuteChange: (muted: boolean) => void;
    bottomBarHeight: number;
    t: (key: string) => string;
    windowHeight: number;
}

// ── Active player surface ────────────────────────────────────────
// Mounted ONLY when the row is inside the live-player window. Holds the single
// `useVideoPlayer` instance (auto-released on unmount), so leaving the window
// tears the decoder down. A poster sits behind the surface until `readyToPlay`.
interface ActiveVideoSurfaceProps {
    videoUrl: string;
    posterUrl?: string;
    isActive: boolean;
    globalMuted: boolean;
    isMuted: boolean;
    onMutedChange: (muted: boolean) => void;
    onError: () => void;
    t: (key: string) => string;
    theme: ReturnType<typeof useTheme>;
}

const ActiveVideoSurface = memo<ActiveVideoSurfaceProps>(({
    videoUrl,
    posterUrl,
    isActive,
    globalMuted,
    isMuted,
    onMutedChange,
    onError,
    t,
    theme,
}) => {
    // `hasRendered` latches true on the FIRST `readyToPlay` and never flips back,
    // so a mid-playback re-buffer (status → loading) does NOT re-show the poster.
    const [hasRendered, setHasRendered] = useState(false);
    const [hasError, setHasError] = useState(false);
    // Poster frame can 404 (no extractable frame) or fail to load → fall back to
    // the neutral icon instead of a blank/broken image. Reset when the source changes.
    const [posterFailed, setPosterFailed] = useState(false);

    useEffect(() => {
        setPosterFailed(false);
    }, [posterUrl]);

    const handlePosterError = useCallback(() => setPosterFailed(true), []);

    const player = useVideoPlayer(videoUrl, (p: VideoPlayer) => {
        p.loop = true;
        // Single source of truth for the initial mute: the global store value
        // captured at mount. Subsequent changes flow through the sync effect below.
        p.muted = globalMuted;
    });

    // Surface readiness + errors so the poster can stay up until first frame and
    // a hard failure can fall back to the placeholder.
    useEffect(() => {
        const sub = player.addListener('statusChange', ({ status: next }) => {
            if (next === 'readyToPlay') {
                setHasRendered(true);
            } else if (next === 'error') {
                setHasError(true);
                onError();
            }
        });
        return () => sub.remove();
    }, [player, onError]);

    // Single place that syncs the live player's mute with the store.
    useEffect(() => {
        if (player.muted !== isMuted) {
            player.muted = isMuted;
        }
    }, [player, isMuted]);

    // Play only when this is the active index; otherwise the neighbour is
    // preloaded but paused. Restarts from the top each time it becomes active.
    useEffect(() => {
        if (isActive) {
            player.currentTime = 0;
            player.play();
        } else {
            player.pause();
        }
    }, [player, isActive]);

    const toggleMute = useCallback(() => {
        const next = !isMuted;
        onMutedChange(next);
        player.muted = next;
        if (!next && isActive) {
            player.play();
        }
    }, [isMuted, isActive, onMutedChange, player]);

    const showPoster = !hasRendered;

    return (
        <>
            <VideoView
                player={player}
                style={styles.video}
                contentFit="contain"
                nativeControls={false}
                fullscreenOptions={{ enable: false }}
                allowsPictureInPicture={false}
            />

            {showPoster && (
                <View style={styles.posterLayer} className="bg-secondary" pointerEvents="none">
                    {posterUrl && !posterFailed ? (
                        <Image
                            source={{ uri: posterUrl }}
                            style={styles.poster}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                            transition={150}
                            onError={handlePosterError}
                        />
                    ) : (
                        <Ionicons name="videocam-outline" size={48} color={theme.colors.textSecondary} />
                    )}
                </View>
            )}

            <Pressable style={styles.muteButton} onPress={toggleMute} hitSlop={HIT_SLOP}>
                <View style={styles.muteButtonInner}>
                    <Ionicons name={isMuted ? 'volume-mute' : 'volume-high'} size={22} color="white" />
                </View>
            </Pressable>

            {hasError && (
                <View style={styles.errorBadge} pointerEvents="none">
                    <Text className="text-xs text-white">{t('videos.unavailable')}</Text>
                </View>
            )}
        </>
    );
});

ActiveVideoSurface.displayName = 'ActiveVideoSurface';

// ── Row ──────────────────────────────────────────────────────────
// Always mounted while inside the FlatList window. The decoder-bearing
// ActiveVideoSurface is mounted only when `isNear`; otherwise we render the
// static poster so the row keeps its slot without holding a player.
const VideoItem = memo<VideoItemProps>(({
    item,
    isActive,
    isNear,
    theme,
    onLike,
    onComment,
    onBoost,
    onShare,
    formatCompactNumber,
    globalMuted,
    onMuteChange,
    bottomBarHeight,
    t,
    windowHeight,
}) => {
    const router = useRouter();
    const [videoError, setVideoError] = useState(false);
    // Out-of-window poster can 404/fail → fall back to the neutral icon.
    const [posterFailed, setPosterFailed] = useState(false);

    const handleError = useCallback(() => setVideoError(true), []);
    const handlePosterError = useCallback(() => setPosterFailed(true), []);

    const userName = useMemo(() => item.user?.name || '', [item.user?.name]);
    const userHandle = useMemo(() => item.user?.handle || t('common.unknown'), [item.user?.handle, t]);
    const postText = useMemo(() => item.content?.text?.trim() || '', [item.content?.text]);

    const handleProfilePress = useCallback(() => {
        if (item.user?.handle) {
            router.push(`/@${item.user.handle}/videos`);
        }
    }, [item.user?.handle, router]);

    const canRenderPlayer = isNear && !videoError && item.videoUrl.length > 0;

    return (
        <View style={[styles.videoContainer, { height: windowHeight }]}>
            {canRenderPlayer ? (
                <ActiveVideoSurface
                    videoUrl={item.videoUrl}
                    posterUrl={item.posterUrl}
                    isActive={isActive}
                    globalMuted={globalMuted}
                    isMuted={globalMuted}
                    onMutedChange={onMuteChange}
                    onError={handleError}
                    t={t}
                    theme={theme}
                />
            ) : (
                // Outside the live window (or errored): no decoder, just a poster.
                <View style={[styles.video, styles.videoPlaceholder]} className="bg-secondary">
                    {item.posterUrl && !posterFailed ? (
                        <Image
                            source={{ uri: item.posterUrl }}
                            style={styles.poster}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                            onError={handlePosterError}
                        />
                    ) : (
                        <Ionicons name="videocam-outline" size={48} color={theme.colors.textSecondary} />
                    )}
                    {videoError && (
                        <Text className="mt-2 text-xs text-muted-foreground">
                            {t('videos.unavailable')}
                        </Text>
                    )}
                </View>
            )}

            <View style={[styles.overlay, { paddingBottom: bottomBarHeight + 20 }]}>
                <LinearGradient
                    colors={GRADIENT_COLORS}
                    locations={GRADIENT_LOCATIONS}
                    style={styles.gradientOverlay}
                />

                <View style={styles.bottomInfo}>
                    <View style={styles.userInfo}>
                        <Pressable onPress={handleProfilePress} style={styles.userHeader}>
                            <Avatar
                                source={item.user?.avatar}
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
                                        <Ionicons name="checkmark-circle" size={14} color={VERIFIED_COLOR} style={styles.verifiedIcon} />
                                    )}
                                </View>
                                <Text style={styles.userHandle} numberOfLines={1}>
                                    @{userHandle}
                                </Text>
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
                        icon={item.isLiked ? 'heart' : 'heart-outline'}
                        count={item.stats?.likesCount || 0}
                        isActive={item.isLiked}
                        activeColor={LIKE_ACTIVE_COLOR}
                        onPress={() => onLike(item.id, item.isLiked || false)}
                        formatCompactNumber={formatCompactNumber}
                    />
                    <ActionButton
                        icon="chatbubble-outline"
                        count={item.stats?.commentsCount || 0}
                        onPress={() => onComment(item.id)}
                        formatCompactNumber={formatCompactNumber}
                    />
                    <ActionButton
                        icon={item.isBoosted ? 'repeat' : 'repeat-outline'}
                        count={item.stats?.boostsCount || 0}
                        isActive={item.isBoosted}
                        activeColor={BOOST_ACTIVE_COLOR}
                        onPress={() => onBoost(item.id, item.isBoosted || false)}
                        formatCompactNumber={formatCompactNumber}
                    />
                    <ActionButton
                        icon="share-outline"
                        count={0}
                        onPress={() => onShare(item)}
                        formatCompactNumber={formatCompactNumber}
                        hideCount={true}
                    />
                </View>
            </View>
        </View>
    );
});

VideoItem.displayName = 'VideoItem';

// ── Action button ────────────────────────────────────────────────
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface ActionButtonProps {
    icon: IoniconName;
    count: number;
    isActive?: boolean;
    activeColor?: string;
    onPress: () => void;
    formatCompactNumber: (count: number) => string;
    hideCount?: boolean;
}

const ActionButton = memo<ActionButtonProps>(({ icon, count, isActive, activeColor, onPress, formatCompactNumber, hideCount = false }) => (
    <Pressable style={styles.actionButton} onPress={onPress} hitSlop={HIT_SLOP}>
        <Ionicons
            name={icon}
            size={28}
            color={isActive && activeColor ? activeColor : 'white'}
            style={styles.actionIcon}
        />
        {!hideCount && (
            <Text style={[styles.actionCount, isActive && activeColor ? { color: activeColor } : null]}>
                {formatCompactNumber(count)}
            </Text>
        )}
    </Pressable>
));

ActionButton.displayName = 'ActionButton';

// ── Screen ───────────────────────────────────────────────────────
export default function VideosScreen() {
    const { t } = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { height: WINDOW_HEIGHT } = useWindowDimensions();
    const router = useRouter();
    const params = useLocalSearchParams<{ postId?: string; mediaIndex?: string }>();
    const { oxyServices } = useAuth();
    const { likePost, unlikePost, boostPost, unboostPost, getPostById } = usePostsStore();

    const [posts, setPosts] = useState<VideoPost[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [hasMore, setHasMore] = useState(true);
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    const [loadingMore, setLoadingMore] = useState(false);
    const [currentVisibleIndex, setCurrentVisibleIndex] = useState(0);
    const { isMuted: globalMuted, loadMutedState } = useVideoMuteStore();
    const [targetPostId] = useState<string | undefined>(params.postId);
    const [targetMediaIndex] = useState<number | undefined>(() => {
        const parsed = Number(params.mediaIndex);
        return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
    });

    const flatListRef = useRef<FlatList<VideoPost>>(null);

    const bottomBarHeight = useMemo(
        () => Platform.OS === 'web' ? 60 : 60 + insets.bottom,
        [insets.bottom]
    );

    // Resolve an Oxy/federated reference to a playable absolute URL. Federated /
    // external absolute URLs stream through the backend media proxy (CORS + HTTP
    // Range seeking + caching, survives expiring upstream links); Oxy file ids
    // resolve to our own URLs and are returned as-is.
    const resolveVideoUrl = useCallback((ref: MediaRef): string => {
        const raw = ref?.url || ref?.id || '';
        if (!raw) return '';
        if (raw.startsWith('http')) return proxyExternalUrl(raw);
        return oxyServices?.getFileDownloadUrl ? oxyServices.getFileDownloadUrl(raw) : '';
    }, [oxyServices]);

    // Resolve a static poster for a video reference from its RAW media id/url
    // (BEFORE proxy wrapping). Oxy asset ids resolve to the generated `thumb`
    // variant; federated absolute URLs resolve to the backend `/media/poster`
    // frame extractor. Returns undefined when nothing sensible → neutral
    // placeholder. The poster endpoint may 404 → the Image layer's own error
    // handling falls back to the placeholder, so this never yields a broken image.
    const resolvePosterUrl = useCallback((ref: MediaRef): string | undefined => {
        const raw = ref?.id || ref?.url || '';
        return videoPosterUrl(raw, oxyServices);
    }, [oxyServices]);

    // Build a VideoPost from a raw post, selecting the requested video. Posts
    // that merely CONTAIN a video qualify (multi-video, or a video among images).
    const toVideoPost = useCallback((post: RawPost, preferredMediaIndex?: number): VideoPost | null => {
        const media = post?.content?.media || [];
        if (media.length === 0) return null;

        let selected: MediaRef | undefined;
        if (
            preferredMediaIndex !== undefined &&
            media[preferredMediaIndex]?.type === 'video'
        ) {
            selected = media[preferredMediaIndex];
        } else {
            selected = media.find((m) => m?.type === 'video');
        }
        if (!selected) return null;

        const videoUrl = resolveVideoUrl(selected);
        if (!videoUrl) return null;

        const id = post?.id || post?._id;
        if (!id) return null;

        return {
            ...post,
            id: String(id),
            user: post.user as VideoPost['user'],
            content: post.content || {},
            stats: post.stats || { likesCount: 0, boostsCount: 0, commentsCount: 0, viewsCount: 0 },
            createdAt: post.createdAt || '',
            videoUrl,
            posterUrl: resolvePosterUrl(selected),
        };
    }, [resolveVideoUrl, resolvePosterUrl]);

    const filterVideoPosts = useCallback((allPosts: RawPost[]): VideoPost[] => {
        const out: VideoPost[] = [];
        for (const post of allPosts) {
            const vp = toVideoPost(post);
            if (vp) out.push(vp);
        }
        return out;
    }, [toVideoPost]);

    // Target post — fetched independently of the ranked chain and shown first.
    const fetchPostById = useCallback(async (postId: string): Promise<VideoPost | null> => {
        try {
            const post = await getPostById(postId);
            if (!post) return null;
            return toVideoPost(post, targetMediaIndex);
        } catch {
            return null;
        }
    }, [getPostById, toVideoPost, targetMediaIndex]);

    // Stable snapshot of currently-shown ids for StrictMode-safe de-dup counting
    // (the setPosts updater can run twice in dev; we must count deterministically).
    const shownIdsRef = useRef<Set<string>>(new Set());

    // Infinite-scroll source: the ranked `videos` MTN feed (native + federated,
    // single AND multi-video). De-dupes against everything already shown and
    // returns how many NEW posts were appended.
    const fetchVideos = useCallback(async (cursor?: string): Promise<number> => {
        try {
            const response = await feedService.getFeed({
                type: 'videos',
                cursor,
                limit: FEED_PAGE_LIMIT,
            });

            const videoPosts = filterVideoPosts((response.items || []) as unknown as RawPost[]);
            const newPosts = videoPosts.filter(p => !shownIdsRef.current.has(p.id));

            if (newPosts.length > 0) {
                newPosts.forEach(p => shownIdsRef.current.add(p.id));
                setPosts(prev => {
                    const existingIds = new Set(prev.map(p => p.id));
                    const toAdd = newPosts.filter(p => !existingIds.has(p.id));
                    return toAdd.length === 0 ? prev : [...prev, ...toAdd];
                });
            }

            setHasMore(response.hasMore || false);
            setNextCursor(response.nextCursor);

            return newPosts.length;
        } catch {
            // A failing feed must never clear the target post; degrade gracefully.
            setHasMore(false);
            return 0;
        }
    }, [filterVideoPosts]);

    // Mirror the latest pagination state into a ref so the auto-continue loop
    // reads fresh values without re-creating the callback each render.
    const feedCursorRef = useRef<{ hasMore: boolean; nextCursor?: string }>({ hasMore: true, nextCursor: undefined });
    feedCursorRef.current = { hasMore, nextCursor };

    // Walk forward through `videos` pages until at least one NEW post is added or
    // the feed is exhausted, so a page of pure duplicates doesn't dead-end the reel.
    const fetchVideosUntilProgress = useCallback(async (startCursor?: string): Promise<void> => {
        let cursor = startCursor;
        let attempts = 0;
        // The first call always runs; up to MAX_AUTO_CONTINUE_PAGES extra follow-ups.
        while (attempts <= MAX_AUTO_CONTINUE_PAGES) {
            const added = await fetchVideos(cursor);
            if (added > 0) return;
            const state = feedCursorRef.current;
            if (!state.hasMore || !state.nextCursor) return;
            cursor = state.nextCursor;
            attempts += 1;
        }
    }, [fetchVideos]);

    // Initial load. Target first (own try/catch), then the ranked chain.
    useEffect(() => {
        let isMounted = true;

        const load = async () => {
            setIsLoading(true);

            if (targetPostId) {
                const targetPost = await fetchPostById(targetPostId);
                if (!isMounted) return;
                if (targetPost) {
                    shownIdsRef.current.add(targetPost.id);
                    setPosts(prev => (prev.some(p => p.id === targetPost.id) ? prev : [targetPost, ...prev]));
                    setCurrentVisibleIndex(0);
                }
            }

            await fetchVideosUntilProgress(undefined);

            if (!isMounted) return;
            setIsLoading(false);
        };

        load();

        return () => {
            isMounted = false;
        };
    }, [targetPostId, fetchPostById, fetchVideosUntilProgress]);

    const handleLoadMore = useCallback(async () => {
        if (loadingMore || !hasMore || !nextCursor) return;
        setLoadingMore(true);
        try {
            await fetchVideosUntilProgress(nextCursor);
        } finally {
            setLoadingMore(false);
        }
    }, [fetchVideosUntilProgress, hasMore, nextCursor, loadingMore]);

    const handleViewableItemsChangedRef = useRef(({ viewableItems }: { viewableItems: ViewableItem[] }) => {
        if (viewableItems?.length > 0) {
            const mostVisibleItem = viewableItems.find((vi) => vi.isViewable) || viewableItems[0];
            const index = mostVisibleItem?.index;
            if (index != null) {
                setCurrentVisibleIndex(index);
            }
        } else {
            setCurrentVisibleIndex(-1);
        }
    });

    const handleViewableItemsChanged = useCallback((info: { viewableItems: ViewableItem[] }) => {
        handleViewableItemsChangedRef.current(info);
    }, []);

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
            toast(t('common.error'), { type: 'error' });
        }
    }, [likePost, unlikePost, t]);

    const handleComment = useCallback((postId: string) => {
        router.push(`/compose?replyToPostId=${postId}`);
    }, [router]);

    const handleBoost = useCallback(async (postId: string, isBoosted: boolean) => {
        try {
            if (isBoosted) {
                await unboostPost({ postId });
            } else {
                await boostPost({ postId });
            }
            setPosts(prev => prev.map(p =>
                p.id === postId
                    ? { ...p, isBoosted: !isBoosted, stats: { ...p.stats, boostsCount: isBoosted ? p.stats.boostsCount - 1 : p.stats.boostsCount + 1 } }
                    : p
            ));
        } catch {
            toast(t('common.error'), { type: 'error' });
        }
    }, [boostPost, unboostPost, t]);

    const handleShare = useCallback(async (post: VideoPost) => {
        try {
            const postUrl = `https://mention.earth/p/${post.id}`;
            const contentText = post?.content?.text || '';
            const user = post?.user || ({} as VideoPost['user']);
            const name = user.name || user.handle || t('common.someone');
            const handle = user.handle || '';
            const shareMessage = contentText
                ? `${name}${handle ? ` (@${handle})` : ''}: ${contentText}`
                : `${name}${handle ? ` (@${handle})` : ''} ${t('videos.shared_a_post')}`;

            const shareTitle = `${name} ${t('videos.on_mention')}`;

            if (Platform.OS === 'web') {
                if (navigator.share) {
                    await navigator.share({ title: shareTitle, text: shareMessage, url: postUrl });
                } else if (navigator.clipboard) {
                    await navigator.clipboard.writeText(`${shareMessage}\n\n${postUrl}`);
                    toast(t('videos.link_copied'), { type: 'success' });
                } else {
                    toast(t('videos.sharing_not_available'), { type: 'error' });
                }
            } else {
                await Share.share({ message: `${shareMessage}\n\n${postUrl}`, url: postUrl, title: shareTitle });
            }
        } catch (error) {
            const err = error as { message?: string; code?: string };
            if (err?.message !== 'User did not share' && err?.code !== 'ERR_SHARE_CANCELLED') {
                toast(t('videos.share_failed'), { type: 'error' });
            }
        }
    }, [t]);

    const handleMuteChange = useCallback((muted: boolean) => {
        useVideoMuteStore.getState().setMuted(muted);
    }, []);

    const handleBack = useSafeBack();

    useEffect(() => {
        loadMutedState();
    }, [loadMutedState]);

    const renderVideoItem = useCallback(({ item, index }: { item: VideoPost; index: number }) => (
        <VideoItem
            item={item}
            isActive={index === currentVisibleIndex}
            isNear={Math.abs(index - currentVisibleIndex) <= ACTIVE_WINDOW_RADIUS}
            theme={theme}
            onLike={handleLike}
            onComment={handleComment}
            onBoost={handleBoost}
            onShare={handleShare}
            formatCompactNumber={formatCompactNumber}
            globalMuted={globalMuted}
            onMuteChange={handleMuteChange}
            bottomBarHeight={bottomBarHeight}
            t={t}
            windowHeight={WINDOW_HEIGHT}
        />
    ), [currentVisibleIndex, theme, handleLike, handleComment, handleBoost, handleShare, globalMuted, handleMuteChange, bottomBarHeight, t, WINDOW_HEIGHT]);

    const keyExtractor = useCallback((item: VideoPost) => item.id, []);

    const getItemLayout = useCallback((_: ArrayLike<VideoPost> | null | undefined, index: number) => ({
        length: WINDOW_HEIGHT,
        offset: WINDOW_HEIGHT * index,
        index,
    }), [WINDOW_HEIGHT]);

    return (
        <>
            <SEO
                title={t('seo.videos.title')}
                description={t('seo.videos.description')}
            />
            <ThemedView style={styles.container}>
                <Pressable
                    onPress={handleBack}
                    hitSlop={HIT_SLOP}
                    style={[styles.backButton, { top: insets.top + 8 }]}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.back')}
                >
                    <View style={styles.backButtonInner}>
                        <Ionicons name="arrow-back" size={24} color="white" />
                    </View>
                </Pressable>

                {isLoading && posts.length === 0 && (
                    <View style={styles.initialLoadingContainer}>
                        <SpinnerIcon size={44} className="text-primary-foreground" />
                    </View>
                )}

                {posts.length > 0 && (
                    <FlatList
                        ref={flatListRef}
                        data={posts}
                        renderItem={renderVideoItem}
                        keyExtractor={keyExtractor}
                        pagingEnabled
                        snapToInterval={WINDOW_HEIGHT}
                        snapToAlignment="start"
                        decelerationRate="fast"
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
                    />
                )}

                {!isLoading && posts.length === 0 && (
                    <EmptyState
                        title={t('videos.no_video_posts_yet')}
                        subtitle={t('videos.no_posts_found')}
                        customIcon={<Video size={48} className="text-muted-foreground" />}
                        containerStyle={styles.emptyState}
                    />
                )}

                {loadingMore && (
                    <View style={styles.loadingMore}>
                        <View style={styles.loadingIndicator}>
                            <Text className="text-sm font-semibold text-muted-foreground">
                                {t('videos.loading')}
                            </Text>
                        </View>
                    </View>
                )}
            </ThemedView>
        </>
    );
}

const TEXT_SHADOW_STRONG: Pick<TextStyle, 'textShadowColor' | 'textShadowOffset' | 'textShadowRadius'> = {
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
};

const TEXT_SHADOW_MEDIUM: Pick<TextStyle, 'textShadowColor' | 'textShadowOffset' | 'textShadowRadius'> = {
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
};

const TEXT_SHADOW_HANDLE: Pick<TextStyle, 'textShadowColor' | 'textShadowOffset' | 'textShadowRadius'> = {
    textShadowColor: 'rgba(0, 0, 0, 0.9)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
};

interface VideosStyles {
    container: ViewStyle;
    initialLoadingContainer: ViewStyle;
    list: ViewStyle;
    listContent: ViewStyle;
    videoContainer: ViewStyle;
    video: ViewStyle;
    videoPlaceholder: ViewStyle;
    posterLayer: ViewStyle;
    poster: ImageStyle;
    errorBadge: ViewStyle;
    backButton: ViewStyle;
    backButtonInner: ViewStyle;
    muteButton: ViewStyle;
    muteButtonInner: ViewStyle;
    overlay: ViewStyle;
    gradientOverlay: ViewStyle;
    rightActions: ViewStyle;
    actionButton: ViewStyle;
    actionIcon: TextStyle;
    actionCount: TextStyle;
    bottomInfo: ViewStyle;
    userInfo: ViewStyle;
    userHeader: ViewStyle;
    userAvatar: ViewStyle;
    userNameContainer: ViewStyle;
    userNameRow: ViewStyle;
    userFullName: TextStyle;
    userHandle: TextStyle;
    verifiedIcon: TextStyle;
    postText: TextStyle;
    emptyState: ViewStyle;
    loadingMore: ViewStyle;
    loadingIndicator: ViewStyle;
}

const styles = StyleSheet.create<VideosStyles>({
    container: {
        flex: 1,
        width: '100%',
        height: '100%',
        backgroundColor: '#000000',
    },
    initialLoadingContainer: {
        ...StyleSheet.absoluteFill,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1,
    },
    list: {
        flex: 1,
    },
    listContent: {
        flexGrow: 1,
    },
    videoContainer: {
        width: '100%',
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
    posterLayer: {
        ...StyleSheet.absoluteFill,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1,
    },
    poster: {
        width: '100%',
        height: '100%',
    },
    errorBadge: {
        position: 'absolute',
        top: 60,
        alignSelf: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 16,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        zIndex: 11,
    },
    backButton: {
        position: 'absolute',
        left: 12,
        zIndex: 20,
    },
    backButtonInner: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        justifyContent: 'center',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.15)',
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
        elevation: 4,
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
        ...TEXT_SHADOW_STRONG,
    },
    actionCount: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '600',
        ...TEXT_SHADOW_MEDIUM,
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
        ...TEXT_SHADOW_STRONG,
    },
    userHandle: {
        color: 'rgba(255, 255, 255, 0.9)',
        fontSize: 14,
        fontWeight: '600',
        ...TEXT_SHADOW_HANDLE,
    },
    verifiedIcon: {
        marginLeft: 2,
    },
    postText: {
        color: '#FFFFFF',
        fontSize: 14,
        lineHeight: 18,
        fontWeight: '400',
        ...TEXT_SHADOW_STRONG,
        marginTop: 4,
    },
    emptyState: {
        flex: 1,
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
});
