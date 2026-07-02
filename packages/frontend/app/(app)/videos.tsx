import React, { useCallback, useEffect, useRef, useState, useMemo, memo } from 'react';
import { StyleSheet, View, Text, Pressable, FlatList, Platform, Share, PanResponder, useWindowDimensions, type ViewStyle, type TextStyle, type ImageStyle, type LayoutChangeEvent } from 'react-native';
import { Image } from 'expo-image';
import { show as toast } from '@oxyhq/bloom/toast';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useSharedValue, useAnimatedStyle, withSequence, withTiming } from 'react-native-reanimated';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth, FollowButton } from '@oxyhq/services';
import { VideoView, useVideoPlayer, type VideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useRouter, useLocalSearchParams, useIsFocused } from 'expo-router';
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
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { PostActorSummary } from '@mention/shared-types';
import { cn } from '@/lib/utils';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { useIsRightBarVisible } from '@/hooks/useOptimizedMediaQuery';
import { useVideosRail, type VideosRailActivePost } from '@/context/VideosRailContext';

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

// Web: pixels-from-bottom at which the document-scroll infinite scroll triggers a
// `handleLoadMore`, so paging stays ahead of the viewer.
const WEB_END_REACHED_PX = 1200;

// Web: each slide is exactly one viewport tall so `scroll-snap-align: start`
// lands each video flush against the document scroller's top. The slides flow in
// the normal document (the BODY/documentElement is the scroller — see the
// `html, body { overflow: visible }` reset in `global.css`), so the snap height
// is the full `100dvh`: the desktop panel's `md:p-2` 8px gutter in
// `app/(app)/_layout.tsx` is column PADDING, not a scroll offset, so snap
// boundaries land at clean `innerHeight` multiples either way. Spelled out as a
// LITERAL class string so the NativeWind compiler can see it (it scans source
// text — interpolated arbitrary values are NOT picked up).
const WEB_SLIDE_HEIGHT_CLASS = 'web:h-[100dvh]';

// Web: the "For You" / "Following" pill tabs must stay pinned at the top while the
// document scrolls (TikTok / Reels), so on web they use `position: sticky` instead
// of the native `position: absolute`. Sticky keeps them in the document flow, which
// confines them horizontally to the central column's containing block (no
// viewport-wide `position: fixed` bleed over the sidebars / right rail) while
// sticking them to the viewport top once scrolled. They carry a negative bottom
// margin equal to their own height (`TABS_ROW_HEIGHT`) so they contribute ZERO net
// layout height — the first `100dvh` slide is not pushed down and scroll-snap
// boundaries stay on clean `innerHeight` multiples. Same overlay-pinning technique
// the desktop frame + profile chrome use in `app/(app)/_layout.tsx` /
// `components/ProfileScreen.tsx`. Spelled out as LITERAL class strings so the
// NativeWind compiler picks them up (it scans source text). Native keeps the
// StyleSheet `position: absolute` (the native container IS the fixed scene).
const TABS_ROW_HEIGHT = 34;
const WEB_TABS_STICKY_CLASS = 'web:sticky web:[margin-bottom:-34px]';

const HIT_SLOP = { top: 10, bottom: 10, left: 10, right: 10 };

const GRADIENT_COLORS = ['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.8)', '#000000'] as const;
const GRADIENT_LOCATIONS = [0, 0.4, 0.7, 1] as const;
const LIKE_ACTIVE_COLOR = '#FF3040';
const BOOST_ACTIVE_COLOR = '#10B981';
const VERIFIED_COLOR = '#1DA1F2';

// Max delay (ms) between two surface taps to register a double-tap-like instead
// of the single-tap pause toggle.
const DOUBLE_TAP_WINDOW_MS = 280;
// Caption is collapsed to two lines until this length, where a "more" toggle is
// offered (TikTok-style expandable caption).
const CAPTION_EXPAND_MIN_CHARS = 80;
// expo-video timeUpdate cadence (seconds) driving the scrubber.
const TIME_UPDATE_INTERVAL_S = 0.25;

// The /videos feed tabs. 'videos' is the ranked "For You" video feed; 'following'
// is the general following feed filtered down to video posts.
type VideoFeedTab = 'videos' | 'following';

// ── Types ────────────────────────────────────────────────────────
// Runtime media reference. The shared `MediaItem` declares `id` + `type` plus the
// server-resolved final URLs (`url`, `thumbUrl`, `posterUrl`). We type the superset
// we actually read here, keeping `id` for the legacy fallback path.
interface MediaRef {
    id?: string;
    url?: string;
    thumbUrl?: string;
    posterUrl?: string;
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
    // The already-hydrated author DTO. Fields (`avatarUrl`, `isVerified`, …) are
    // read straight off the backend contract — never a re-invented parallel shape.
    user?: PostActorSummary;
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
    // True only while the /videos route is the focused screen. When another
    // route is pushed on top, freezeOnBlur pauses JS but the native decoder may
    // keep playing audio/video; gating playback on this prevents that bleed.
    screenFocused: boolean;
    theme: ReturnType<typeof useTheme>;
    onLike: (postId: string, isLiked: boolean) => void;
    onComment: (postId: string) => void;
    onBoost: (postId: string, isBoosted: boolean) => void;
    onShare: (post: VideoPost) => void;
    formatCompactNumber: (count: number) => string;
    muted: boolean;
    onMutedChange: (muted: boolean) => void;
    bottomBarHeight: number;
    t: (key: string) => string;
    windowHeight: number;
    // Desktop (>=990) moves the action column + on-video follow into the rail; the
    // overlay keeps only the Shorts-style author/caption/sound block.
    isDesktop: boolean;
    // The signed-in viewer's id — hides the on-video follow button on the
    // author's own video.
    viewerId?: string;
}

// ── Active player surface ────────────────────────────────────────
// Mounted ONLY when the row is inside the live-player window. Holds the single
// `useVideoPlayer` instance (auto-released on unmount), so leaving the window
// tears the decoder down. A poster sits behind the surface until `readyToPlay`.
interface ActiveVideoSurfaceProps {
    videoUrl: string;
    posterUrl?: string;
    isActive: boolean;
    // See VideoItemProps.screenFocused — only play when active AND focused.
    screenFocused: boolean;
    muted: boolean;
    onMutedChange: (muted: boolean) => void;
    onError: () => void;
    t: (key: string) => string;
    theme: ReturnType<typeof useTheme>;
    // Double-tap-to-like state + a like-ONLY handler (never unlikes).
    isLiked: boolean;
    onLikePost: () => void;
}

const ActiveVideoSurface = memo<ActiveVideoSurfaceProps>(({
    videoUrl,
    posterUrl,
    isActive,
    screenFocused,
    muted,
    onMutedChange,
    onError,
    t,
    theme,
    isLiked,
    onLikePost,
}) => {
    // `hasRendered` latches true on the FIRST `readyToPlay` and never flips back,
    // so a mid-playback re-buffer (status → loading) does NOT re-show the poster.
    const [hasRendered, setHasRendered] = useState(false);
    const [hasError, setHasError] = useState(false);
    // Live re-buffer flag: distinct from `hasRendered` so a mid-playback stall
    // shows only a small spinner over the already-rendered frame, never the poster.
    const [isBuffering, setIsBuffering] = useState(false);
    // Poster frame can 404 (no extractable frame) or fail to load → fall back to
    // the neutral icon instead of a blank/broken image. Reset when the source changes.
    const [posterFailed, setPosterFailed] = useState(false);
    // Reels tap-to-pause: a viewer-driven pause override on the ACTIVE surface. It
    // is cleared whenever the surface stops being active (see the playback effect)
    // so a newly-activated video always autoplays instead of inheriting a stale
    // paused state.
    const [userPaused, setUserPaused] = useState(false);
    // Scrubber state — current playhead + total duration, driven by player events.
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isScrubbing, setIsScrubbing] = useState(false);

    useEffect(() => {
        setPosterFailed(false);
    }, [posterUrl]);

    const handlePosterError = useCallback(() => setPosterFailed(true), []);

    const player = useVideoPlayer(videoUrl, (p: VideoPlayer) => {
        p.loop = true;
        // Drive the scrubber at a smooth-but-cheap cadence.
        p.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_S;
        // Single source of truth for the initial mute: the global store value
        // captured at mount. Subsequent changes flow through the sync effect below.
        p.muted = muted;
    });

    // Surface readiness + errors + live buffering. `hasRendered` latches on first
    // `readyToPlay`; AFTER that, a transition to `loading` is a mid-playback
    // re-buffer (small spinner), and `readyToPlay` clears it.
    useEffect(() => {
        const sub = player.addListener('statusChange', ({ status: next }) => {
            if (next === 'readyToPlay') {
                setHasRendered(true);
                setIsBuffering(false);
                if (player.duration > 0) {
                    setDuration(player.duration);
                }
            } else if (next === 'loading') {
                // Only a re-buffer (small spinner) once the first frame has
                // rendered; the initial load is covered by the poster instead.
                setHasRendered((rendered) => {
                    setIsBuffering(rendered);
                    return rendered;
                });
            } else if (next === 'error') {
                setHasError(true);
                onError();
            }
        });
        return () => sub.remove();
    }, [player, onError]);

    // Track the playhead for the scrubber. Skipped while the viewer is dragging so
    // the thumb follows the gesture, not the (lagging) player position.
    useEffect(() => {
        const sub = player.addListener('timeUpdate', ({ currentTime: nextTime }) => {
            setCurrentTime((prev) => (isScrubbing ? prev : nextTime));
            if (duration <= 0 && player.duration > 0) {
                setDuration(player.duration);
            }
        });
        return () => sub.remove();
    }, [player, isScrubbing, duration]);

    // Single place that syncs the live player's mute with the store.
    useEffect(() => {
        if (player.muted !== muted) {
            player.muted = muted;
        }
    }, [player, muted]);

    // When this surface stops being the active index, drop any viewer pause
    // override so re-activating it (scrolling back) autoplays from the top rather
    // than staying paused. A neighbour preloads but never plays, so the override
    // is meaningless off-screen.
    useEffect(() => {
        if (!isActive) {
            setUserPaused(false);
        }
    }, [isActive]);

    // Drive playback from the active/focused gate AND the viewer's tap override.
    // The active surface plays from the top when it first activates; a tap-resume
    // continues from the current position (no `currentTime = 0` reset) so toggling
    // play/pause does not jump the video back to the start. Off-screen, blurred,
    // or viewer-paused → paused.
    const shouldPlay = isActive && screenFocused && !userPaused;
    useEffect(() => {
        if (shouldPlay) {
            player.play();
        } else {
            player.pause();
        }
    }, [player, shouldPlay]);

    // Restart from the top whenever the surface (re)becomes active+focused, so each
    // activation begins at the start. Kept separate from the play/pause gate so a
    // mid-playback tap-resume does not rewind.
    useEffect(() => {
        if (isActive && screenFocused) {
            player.currentTime = 0;
        }
    }, [player, isActive, screenFocused]);

    // ── Double-tap-to-like ──────────────────────────────────────────
    // A single tap toggles pause but is DEFERRED by DOUBLE_TAP_WINDOW_MS; a second
    // tap inside the window cancels that pending pause and fires a like-only.
    const lastTapRef = useRef(0);
    const pausePendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const heartScale = useSharedValue(0);
    const heartOpacity = useSharedValue(0);

    useEffect(() => () => {
        if (pausePendingRef.current) {
            clearTimeout(pausePendingRef.current);
            pausePendingRef.current = null;
        }
    }, []);

    const popHeart = useCallback(() => {
        heartOpacity.value = withSequence(
            withTiming(1, { duration: 120 }),
            withTiming(0, { duration: 480 }),
        );
        heartScale.value = withSequence(
            withTiming(1, { duration: 180 }),
            withTiming(1.25, { duration: 420 }),
        );
    }, [heartOpacity, heartScale]);

    const handleSurfacePress = useCallback(() => {
        if (!isActive || !screenFocused) return;
        const now = Date.now();
        if (now - lastTapRef.current < DOUBLE_TAP_WINDOW_MS) {
            // Double tap: cancel the pending pause toggle and like (like-only).
            lastTapRef.current = 0;
            if (pausePendingRef.current) {
                clearTimeout(pausePendingRef.current);
                pausePendingRef.current = null;
            }
            if (!isLiked) {
                onLikePost();
            }
            popHeart();
            return;
        }
        lastTapRef.current = now;
        if (pausePendingRef.current) {
            clearTimeout(pausePendingRef.current);
        }
        pausePendingRef.current = setTimeout(() => {
            pausePendingRef.current = null;
            setUserPaused((prev) => !prev);
        }, DOUBLE_TAP_WINDOW_MS);
    }, [isActive, screenFocused, isLiked, onLikePost, popHeart]);

    const heartStyle = useAnimatedStyle(() => ({
        opacity: heartOpacity.value,
        transform: [{ scale: heartScale.value }],
    }));

    const toggleMute = useCallback(() => {
        const next = !muted;
        onMutedChange(next);
        player.muted = next;
        if (!next && shouldPlay) {
            player.play();
        }
    }, [muted, shouldPlay, onMutedChange, player]);

    // ── Scrubber / seek ─────────────────────────────────────────────
    // Measured track width drives the gesture→time mapping. PanResponder works on
    // both web and native and is confined to the thin bar's own hit area, so it
    // never steals tap-to-pause or scroll from the surface.
    const trackWidthRef = useRef(0);
    const onTrackLayout = useCallback((e: LayoutChangeEvent) => {
        trackWidthRef.current = e.nativeEvent.layout.width;
    }, []);

    const seekToLocationX = useCallback((locationX: number) => {
        const width = trackWidthRef.current;
        const total = duration > 0 ? duration : player.duration;
        if (width <= 0 || total <= 0) return;
        const ratio = Math.min(1, Math.max(0, locationX / width));
        const nextTime = ratio * total;
        setCurrentTime(nextTime);
        player.currentTime = nextTime;
    }, [duration, player]);

    const panResponder = useMemo(() => PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => {
            setIsScrubbing(true);
            seekToLocationX(e.nativeEvent.locationX);
        },
        onPanResponderMove: (e) => {
            seekToLocationX(e.nativeEvent.locationX);
        },
        onPanResponderRelease: (e) => {
            seekToLocationX(e.nativeEvent.locationX);
            setIsScrubbing(false);
        },
        onPanResponderTerminate: () => {
            setIsScrubbing(false);
        },
    }), [seekToLocationX]);

    const progress = duration > 0 ? Math.min(1, Math.max(0, currentTime / duration)) : 0;

    const showPoster = !hasRendered;
    // The pause affordance shows only when the viewer has actively paused the
    // current video — not for the autoplay-gating pauses (off-screen / blurred).
    const showPauseAffordance = isActive && screenFocused && userPaused;
    const showScrubber = isActive && screenFocused;
    const showBufferSpinner = isBuffering && isActive && hasRendered;

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

            {/* Full-surface tap target → toggle play/pause (single tap, deferred)
                or like (double tap). It sits ABOVE the video/poster but BELOW the
                mute button (z 10), scrubber, and the bottom overlay actions, so
                those keep their own taps. */}
            <Pressable
                style={styles.tapLayer}
                onPress={handleSurfacePress}
                accessibilityRole="button"
                accessibilityLabel={t(userPaused ? 'videos.play' : 'videos.pause')}
            />

            {/* Double-tap heart pop — large, centered, non-interactive. */}
            <Animated.View style={[styles.heartPop, heartStyle]} pointerEvents="none">
                <Ionicons name="heart" size={96} color={LIKE_ACTIVE_COLOR} />
            </Animated.View>

            {showPauseAffordance && (
                <View style={styles.pauseAffordance} pointerEvents="none">
                    <View style={styles.pauseAffordanceInner}>
                        <Ionicons name="play" size={44} color="white" />
                    </View>
                </View>
            )}

            {showBufferSpinner && (
                <View style={styles.bufferSpinner} pointerEvents="none">
                    <View style={styles.bufferSpinnerInner}>
                        <SpinnerIcon size={32} className="text-white" />
                    </View>
                </View>
            )}

            <Pressable style={styles.muteButton} onPress={toggleMute} hitSlop={HIT_SLOP}>
                <View style={styles.muteButtonInner}>
                    <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={22} color="white" />
                </View>
            </Pressable>

            {showScrubber && (
                <View
                    style={styles.scrubberHitArea}
                    hitSlop={{ top: 8, bottom: 8 }}
                    onLayout={onTrackLayout}
                    {...panResponder.panHandlers}
                >
                    <View style={[styles.scrubberTrack, isScrubbing && styles.scrubberTrackActive]}>
                        <View style={[styles.scrubberFill, { width: `${progress * 100}%` }]} />
                    </View>
                </View>
            )}

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
    screenFocused,
    theme,
    onLike,
    onComment,
    onBoost,
    onShare,
    formatCompactNumber,
    muted,
    onMutedChange,
    bottomBarHeight,
    t,
    windowHeight,
    isDesktop,
    viewerId,
}) => {
    const router = useRouter();
    const [videoError, setVideoError] = useState(false);
    // Out-of-window poster can 404/fail → fall back to the neutral icon.
    const [posterFailed, setPosterFailed] = useState(false);
    // TikTok-style expandable caption: collapsed to two lines until toggled.
    const [captionExpanded, setCaptionExpanded] = useState(false);

    const handleError = useCallback(() => setVideoError(true), []);
    const handlePosterError = useCallback(() => setPosterFailed(true), []);
    const toggleCaption = useCallback(() => setCaptionExpanded((prev) => !prev), []);

    const userName = useMemo(() => item.user?.displayName ?? '', [item.user?.displayName]);
    const userHandle = useMemo(() => item.user?.handle || t('common.unknown'), [item.user?.handle, t]);
    const postText = useMemo(() => item.content?.text?.trim() || '', [item.content?.text]);

    const handleProfilePress = useCallback(() => {
        const handle = getNormalizedUserHandle({ handle: item.user?.handle });
        if (handle) {
            router.push(`/@${handle}/videos`);
        }
    }, [item.user?.handle, router]);

    // Like-only handler for the double-tap gesture — never unlikes.
    const handleDoubleTapLike = useCallback(() => {
        if (!item.isLiked) {
            onLike(item.id, false);
        }
    }, [item.id, item.isLiked, onLike]);

    const canRenderPlayer = isNear && !videoError && item.videoUrl.length > 0;
    // On desktop the engagement column + the on-video follow live in the rail;
    // the overlay keeps only the Shorts-style author/caption/sound block.
    const showOnVideoActions = !isDesktop;
    const showOnVideoFollow = !isDesktop && Boolean(item.user?.id) && item.user?.id !== viewerId;
    const showCaptionToggle = postText.length > CAPTION_EXPAND_MIN_CHARS;

    return (
        <View
            className={cn(WEB_SLIDE_HEIGHT_CLASS, 'web:[scroll-snap-align:start]')}
            style={[styles.videoContainer, Platform.OS === 'web' ? null : { height: windowHeight }]}
        >
            {canRenderPlayer ? (
                <ActiveVideoSurface
                    videoUrl={item.videoUrl}
                    posterUrl={item.posterUrl}
                    isActive={isActive}
                    screenFocused={screenFocused}
                    muted={muted}
                    onMutedChange={onMutedChange}
                    onError={handleError}
                    t={t}
                    theme={theme}
                    isLiked={item.isLiked || false}
                    onLikePost={handleDoubleTapLike}
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

            {/* `box-none`: the overlay container spans the bottom half of the
                surface, but only its interactive leaves (author press, follow,
                caption toggle, action buttons) should capture touches — empty
                regions must fall through to the tap layer below (single-tap pause
                / double-tap like). Without this the overlay (zIndex 5, above the
                zIndex-2 tap layer) would swallow taps on the lower half. */}
            <View style={[styles.overlay, { paddingBottom: bottomBarHeight + 20 }]} pointerEvents="box-none">
                <LinearGradient
                    colors={GRADIENT_COLORS}
                    locations={GRADIENT_LOCATIONS}
                    style={styles.gradientOverlay}
                />

                <View style={styles.bottomInfo} pointerEvents="box-none">
                    <View style={styles.userInfo} pointerEvents="box-none">
                        <View style={styles.userHeaderRow} pointerEvents="box-none">
                            <Pressable onPress={handleProfilePress} style={styles.userHeader}>
                                <Avatar
                                    source={item.user?.avatarUrl}
                                    size={40}
                                    verified={item.user?.isVerified || false}
                                    style={styles.userAvatar}
                                />
                                <View style={styles.userNameContainer}>
                                    <View style={styles.userNameRow}>
                                        <Text style={styles.userFullName} numberOfLines={1}>
                                            {userName}
                                        </Text>
                                        {item.user?.isVerified && (
                                            <Ionicons name="checkmark-circle" size={14} color={VERIFIED_COLOR} style={styles.verifiedIcon} />
                                        )}
                                    </View>
                                    <Text style={styles.userHandle} numberOfLines={1}>
                                        @{userHandle}
                                    </Text>
                                </View>
                            </Pressable>
                            {showOnVideoFollow && item.user?.id && (
                                <View style={styles.onVideoFollow}>
                                    <FollowButton userId={item.user.id} size="small" />
                                </View>
                            )}
                        </View>
                        {postText ? (
                            <View style={styles.caption}>
                                <LinkifiedText
                                    text={postText}
                                    style={styles.postText}
                                    linkStyle={styles.postLink}
                                    numberOfLines={captionExpanded ? undefined : 2}
                                />
                                {showCaptionToggle && (
                                    <Text
                                        style={styles.captionToggle}
                                        onPress={toggleCaption}
                                        accessibilityRole="button"
                                    >
                                        {t(captionExpanded ? 'videos.less' : 'videos.more')}
                                    </Text>
                                )}
                            </View>
                        ) : null}
                        <View style={styles.soundRow} pointerEvents="none">
                            <Ionicons name="musical-notes-outline" size={13} color="#FFFFFF" style={styles.soundIcon} />
                            <Text style={styles.soundText} numberOfLines={1}>
                                {t('videos.original_audio')} · @{userHandle}
                            </Text>
                        </View>
                    </View>
                </View>

                {showOnVideoActions && (
                    <View style={styles.rightActions} pointerEvents="box-none">
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
                        <View style={styles.viewCount} pointerEvents="none">
                            <Ionicons name="eye-outline" size={26} color="white" style={styles.actionIcon} />
                            <Text style={styles.actionCount}>
                                {formatCompactNumber(item.stats?.viewsCount || 0)}
                            </Text>
                        </View>
                    </View>
                )}
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

// ── Feed tab pill ────────────────────────────────────────────────
interface FeedTabProps {
    label: string;
    active: boolean;
    onPress: () => void;
}

const FeedTab = memo<FeedTabProps>(({ label, active, onPress }) => (
    <Pressable
        style={[styles.tabPill, active ? styles.tabPillActive : styles.tabPillInactive]}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        hitSlop={HIT_SLOP}
    >
        <Text style={[styles.tabLabel, active ? styles.tabLabelActive : styles.tabLabelInactive]}>
            {label}
        </Text>
    </Pressable>
));

FeedTab.displayName = 'FeedTab';

// ── Screen ───────────────────────────────────────────────────────
export default function VideosScreen() {
    const { t } = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { height: WINDOW_HEIGHT } = useWindowDimensions();
    const router = useRouter();
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ postId?: string; mediaIndex?: string }>();
    const { oxyServices, user, canUsePrivateApi, isAuthResolved, isAuthenticated } = useAuth();
    const viewerId = user?.id;
    const { likePost, unlikePost, boostPost, unboostPost, getPostById } = usePostsStore();
    // Desktop (>=990) gate — shared source of truth with the RightBar. On desktop
    // the engagement column + on-video follow move into the rail.
    const isDesktop = useIsRightBarVisible();
    const { setRailState } = useVideosRail();

    const [posts, setPosts] = useState<VideoPost[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [hasMore, setHasMore] = useState(true);
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    const [loadingMore, setLoadingMore] = useState(false);
    const [currentVisibleIndex, setCurrentVisibleIndex] = useState(0);
    // 'videos' = For You (ranked video feed); 'following' = following feed filtered
    // to videos. Read through a ref inside the stable load callbacks so switching
    // tabs doesn't thrash callback identity.
    const [activeFeed, setActiveFeed] = useState<VideoFeedTab>('videos');
    const activeFeedRef = useRef<VideoFeedTab>(activeFeed);
    activeFeedRef.current = activeFeed;
    const { isMuted: globalMuted, loadMutedState } = useVideoMuteStore();

    // If the viewer signs out while on Following, fall back to For You. Gated on
    // `isAuthResolved` so the undetermined cold-boot window (where the session is
    // about to restore) doesn't yank a Following viewer back to For You.
    useEffect(() => {
        if (isAuthResolved && !isAuthenticated && activeFeed === 'following') {
            setActiveFeed('videos');
        }
    }, [isAuthResolved, isAuthenticated, activeFeed]);
    // Frozen at cold load: the target post + media index are read once so later
    // param changes never re-trigger the initial load or re-order the reel.
    const targetParamsRef = useRef<{ postId?: string; mediaIndex?: number } | null>(null);
    if (!targetParamsRef.current) {
        const parsed = Number(params.mediaIndex);
        targetParamsRef.current = {
            postId: params.postId,
            mediaIndex: Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined,
        };
    }
    const targetPostId = targetParamsRef.current.postId;
    const targetMediaIndex = targetParamsRef.current.mediaIndex;

    const flatListRef = useRef<FlatList<VideoPost>>(null);

    const bottomBarHeight = useMemo(
        () => Platform.OS === 'web' ? 60 : 60 + insets.bottom,
        [insets.bottom]
    );

    // Resolve a playable absolute URL. The backend now returns a FINAL `url`
    // (our CDN/media-proxy or remote), so we use it directly. Fall back to the
    // legacy client resolution only when `url` is absent (old cached responses):
    // an http id passes through the proxy; an Oxy file id resolves via the SDK.
    const resolveVideoUrl = useCallback((ref: MediaRef): string => {
        if (ref?.url) return ref.url;
        const raw = ref?.id || '';
        if (!raw) return '';
        if (raw.startsWith('http')) return proxyExternalUrl(raw);
        return oxyServices?.getFileDownloadUrl ? oxyServices.getFileDownloadUrl(raw) : '';
    }, [oxyServices]);

    // Resolve a static poster. Prefer the server-resolved final `posterUrl`
    // (fallback `thumbUrl`); fall back to the legacy client resolver from the RAW
    // media id/url when absent. Returns undefined when nothing sensible → neutral
    // placeholder. The poster URL may 404 → the Image layer's own error handling
    // falls back to the placeholder, so this never yields a broken image.
    const resolvePosterUrl = useCallback((ref: MediaRef): string | undefined => {
        if (ref?.posterUrl) return ref.posterUrl;
        if (ref?.thumbUrl) return ref.thumbUrl;
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
            user: post.user,
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

    // Infinite-scroll source: the ranked `videos` MTN feed (For You) or the
    // general `following` feed filtered to videos. Reads the active tab through a
    // ref so the callback identity stays stable across tab switches. De-dupes
    // against everything already shown and returns how many NEW posts were appended.
    const fetchVideos = useCallback(async (cursor?: string): Promise<number> => {
        try {
            const response = await feedService.getFeed({
                type: activeFeedRef.current === 'following' ? 'following' : 'videos',
                cursor,
                limit: FEED_PAGE_LIMIT,
            });

            // The `following` descriptor returns all post types; both paths run
            // through filterVideoPosts so only video posts reach the reel.
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

    // Reset the reel scroll window to the top across both platforms — used on a
    // tab switch so the new feed starts from the first slide.
    const scrollReelToTop = useCallback(() => {
        if (Platform.OS === 'web') {
            if (typeof window !== 'undefined') {
                window.scrollTo({ top: 0 });
            }
        } else {
            flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
        }
    }, []);

    // Initial load + tab switch. Target first (own try/catch), then the ranked
    // chain. `viewerId` rebuilds the reel when the session resolves on cold boot
    // (the feed and per-post flags are viewer-dependent). `activeFeed` rebuilds it
    // on a tab switch — this effect already resets the accumulated state, so the
    // de-dup set never suppresses the new feed's results. The deep-link target
    // post is only pinned on the For You tab so a Following reload doesn't re-pin it.
    useEffect(() => {
        let isMounted = true;

        const load = async () => {
            setIsLoading(true);
            shownIdsRef.current = new Set();
            setPosts([]);
            setNextCursor(undefined);
            setHasMore(true);
            setCurrentVisibleIndex(0);
            scrollReelToTop();

            if (targetPostId && activeFeed === 'videos') {
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
    }, [targetPostId, viewerId, activeFeed, fetchPostById, fetchVideosUntilProgress, scrollReelToTop]);

    const handleLoadMore = useCallback(async () => {
        if (loadingMore || !hasMore || !nextCursor) return;
        setLoadingMore(true);
        try {
            await fetchVideosUntilProgress(nextCursor);
        } finally {
            setLoadingMore(false);
        }
    }, [fetchVideosUntilProgress, hasMore, nextCursor, loadingMore]);

    // Stable for the lifetime of the screen: its only output is the stable
    // `setCurrentVisibleIndex` setter, so the FlatList never sees a new identity.
    const handleViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewableItem[] }) => {
        if (viewableItems?.length > 0) {
            const mostVisibleItem = viewableItems.find((vi) => vi.isViewable) || viewableItems[0];
            const index = mostVisibleItem?.index;
            if (index != null) {
                setCurrentVisibleIndex(index);
            }
        } else {
            setCurrentVisibleIndex(-1);
        }
    }, []);

    // Web: videos scroll with the DOCUMENT (the BODY/documentElement is the
    // scroller, same as every other screen), so scroll-snap lives on the document
    // scroller — but ONLY while /videos is mounted. Set `scroll-snap-type: y
    // mandatory` on the documentElement on mount and RESTORE the exact prior
    // inline value on unmount, so it never leaks to home/explore (which do not
    // snap) and never clobbers an unrelated inline value. External-DOM
    // synchronization with a cleanup is the legitimate `useEffect` case.
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof document === 'undefined') return;
        const root = document.documentElement;
        const previousSnapType = root.style.scrollSnapType;
        root.style.scrollSnapType = 'y mandatory';
        return () => {
            root.style.scrollSnapType = previousSnapType;
        };
    }, []);

    // Web: derive the active index from the document scroll position and trigger
    // infinite scroll near the bottom. Each slide is exactly `innerHeight` tall
    // (`web:h-[100dvh]`) so the nearest snapped index is
    // `round(scrollY / innerHeight)`. The listener is passive and coalesced via
    // requestAnimationFrame so bursts of scroll events collapse to one read per
    // frame. Re-attaches when `handleLoadMore` changes (its pagination closure),
    // which is cheap for a passive listener.
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        let frame = 0;
        const read = () => {
            frame = 0;
            const viewportH = window.innerHeight;
            if (viewportH > 0) {
                const index = Math.round(window.scrollY / viewportH);
                setCurrentVisibleIndex(prev => (prev === index ? prev : index));
            }
            if (window.scrollY + viewportH >= document.documentElement.scrollHeight - WEB_END_REACHED_PX) {
                handleLoadMore();
            }
        };
        const onScroll = () => {
            if (frame === 0) {
                frame = window.requestAnimationFrame(read);
            }
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            window.removeEventListener('scroll', onScroll);
            if (frame !== 0) {
                window.cancelAnimationFrame(frame);
            }
        };
    }, [handleLoadMore]);

    // Scroll the reel to a clamped target index. Powers the rail arrows + the
    // web keyboard ↑/↓ shortcuts. Web scrolls the document; native scrolls the
    // FlatList by the slide height.
    const goToIndex = useCallback((targetIndex: number) => {
        const clamped = Math.min(Math.max(targetIndex, 0), posts.length - 1);
        if (clamped < 0) return;
        if (Platform.OS === 'web') {
            if (typeof window !== 'undefined') {
                window.scrollTo({ top: clamped * window.innerHeight, behavior: 'smooth' });
            }
        } else {
            flatListRef.current?.scrollToOffset({ offset: clamped * WINDOW_HEIGHT, animated: true });
        }
    }, [posts.length, WINDOW_HEIGHT]);

    const prev = useCallback(() => goToIndex(currentVisibleIndex - 1), [goToIndex, currentVisibleIndex]);
    const next = useCallback(() => goToIndex(currentVisibleIndex + 1), [goToIndex, currentVisibleIndex]);

    const handleSelectFeed = useCallback((tab: VideoFeedTab) => {
        setActiveFeed((prevTab) => (prevTab === tab ? prevTab : tab));
    }, []);

    // Web: ↑/↓ arrow keys page the reel. Ignored while typing into an input /
    // textarea / contenteditable so the composer and search are unaffected.
    // External-system (window) listener with a cleanup — the legitimate effect case.
    useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const onKeyDown = (e: KeyboardEvent) => {
            const target = document.activeElement;
            if (target) {
                const tag = target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA' || (target as HTMLElement).isContentEditable) {
                    return;
                }
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                prev();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                next();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [prev, next]);

    const handleLike = useCallback(async (postId: string, isLiked: boolean) => {
        try {
            if (isLiked) {
                await unlikePost({ postId, type: 'post' });
            } else {
                // Surface attribution (the active Reels tab) returns when the affinity hooks land.
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
                // Surface attribution (the active Reels tab) returns when the affinity hooks land.
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
            const user = post?.user;
            const name = user?.displayName ?? t('common.someone');
            const handle = user?.handle || '';
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

    useEffect(() => {
        loadMutedState();
    }, [loadMutedState]);

    // ── Desktop rail coordination ───────────────────────────────────
    // The rail (rendered in RightBar) is a read-only projection of this screen's
    // active post + a set of screen-bound callbacks. Writing this derived state to
    // an external store is the same legitimate-effect pattern as the ScreenColor
    // screens. `active` flips true on mount and false on unmount so the rail
    // mounts/unmounts in lockstep with /videos.
    useEffect(() => {
        setRailState({ active: true });
        return () => {
            setRailState({ active: false, activePost: null });
        };
    }, [setRailState]);

    const activeVideoPost = posts[currentVisibleIndex];

    const railActivePost = useMemo<VideosRailActivePost | null>(() => {
        if (!activeVideoPost) return null;
        const authorId = activeVideoPost.user?.id;
        return {
            id: activeVideoPost.id,
            authorId,
            authorIsViewer: Boolean(authorId) && authorId === viewerId,
            isLiked: activeVideoPost.isLiked || false,
            isBoosted: activeVideoPost.isBoosted || false,
            likesCount: activeVideoPost.stats?.likesCount || 0,
            commentsCount: activeVideoPost.stats?.commentsCount || 0,
            boostsCount: activeVideoPost.stats?.boostsCount || 0,
            viewsCount: activeVideoPost.stats?.viewsCount || 0,
        };
    }, [activeVideoPost, viewerId]);

    // Push the snapshot + freshly-bound callbacks. The like/boost callbacks are
    // FULL toggles (unlike the double-tap like-only path) and reuse the same
    // screen handlers, so a rail mutation flows back through setPosts → re-derives
    // railActivePost → the rail re-renders with the new count/state.
    useEffect(() => {
        setRailState({
            index: currentVisibleIndex,
            total: posts.length,
            activePost: railActivePost,
            prev,
            next,
            onLike: () => {
                if (railActivePost) handleLike(railActivePost.id, railActivePost.isLiked);
            },
            onComment: () => {
                if (railActivePost) handleComment(railActivePost.id);
            },
            onBoost: () => {
                if (railActivePost) handleBoost(railActivePost.id, railActivePost.isBoosted);
            },
            onShare: () => {
                if (activeVideoPost) handleShare(activeVideoPost);
            },
        });
    }, [setRailState, currentVisibleIndex, posts.length, railActivePost, activeVideoPost, prev, next, handleLike, handleComment, handleBoost, handleShare]);

    const renderVideoItem = useCallback(({ item, index }: { item: VideoPost; index: number }) => (
        <VideoItem
            item={item}
            isActive={index === currentVisibleIndex}
            isNear={Math.abs(index - currentVisibleIndex) <= ACTIVE_WINDOW_RADIUS}
            screenFocused={isFocused}
            theme={theme}
            onLike={handleLike}
            onComment={handleComment}
            onBoost={handleBoost}
            onShare={handleShare}
            formatCompactNumber={formatCompactNumber}
            muted={globalMuted}
            onMutedChange={handleMuteChange}
            bottomBarHeight={bottomBarHeight}
            t={t}
            windowHeight={WINDOW_HEIGHT}
            isDesktop={isDesktop}
            viewerId={viewerId}
        />
    ), [currentVisibleIndex, isFocused, theme, handleLike, handleComment, handleBoost, handleShare, globalMuted, handleMuteChange, bottomBarHeight, t, WINDOW_HEIGHT, isDesktop, viewerId]);

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
                {isLoading && posts.length === 0 && (
                    <View style={styles.initialLoadingContainer}>
                        <SpinnerIcon size={44} className="text-primary-foreground" />
                    </View>
                )}

                {/* Immersive pill tabs over the video — top-center, respecting the
                    safe-area inset. On web they pin to the viewport top via
                    `position: sticky` (WEB_TABS_STICKY_CLASS) so they stay visible
                    while the document scrolls, staying confined to the central
                    column (not full-bleed over the sidebars / right rail). Native
                    keeps the StyleSheet `position: absolute`. Following is gated on
                    the private API (auth). */}
                <View
                    className={WEB_TABS_STICKY_CLASS}
                    style={[styles.tabsRow, { top: insets.top + 12 }]}
                    pointerEvents="box-none"
                >
                    <FeedTab
                        label={t('For You')}
                        active={activeFeed === 'videos'}
                        onPress={() => handleSelectFeed('videos')}
                    />
                    {canUsePrivateApi && (
                        <FeedTab
                            label={t('Following')}
                            active={activeFeed === 'following'}
                            onPress={() => handleSelectFeed('following')}
                        />
                    )}
                </View>

                {posts.length > 0 && (
                    Platform.OS === 'web' ? (
                        // WEB: slides flow in the DOCUMENT — no internal scroller, no
                        // `overflow-y-scroll`, no height clamp. This plain full-column
                        // `<View>` grows to the sum of its `100dvh` slides, and the
                        // BODY/documentElement is the scroller (the `html, body {
                        // overflow: visible }` reset in `global.css`), exactly like every
                        // other screen — so wheeling anywhere (over the SideBar, right
                        // rail, or gutter) scrolls the videos. Scroll-snap is applied to
                        // the document scroller (scoped to /videos via the mount effect
                        // above); each slide carries `web:[scroll-snap-align:start]` so it
                        // rests flush at the viewport top. The active index + infinite
                        // scroll come from the window scroll listener above. The slides
                        // stay full COLUMN width (sidebars/rail visible) because this
                        // `<View>` lives inside the central column, not the viewport.
                        <View className="web:w-full">
                            {posts.map((item, index) => (
                                <VideoItem
                                    key={item.id}
                                    item={item}
                                    isActive={index === currentVisibleIndex}
                                    isNear={Math.abs(index - currentVisibleIndex) <= ACTIVE_WINDOW_RADIUS}
                                    screenFocused={isFocused}
                                    theme={theme}
                                    onLike={handleLike}
                                    onComment={handleComment}
                                    onBoost={handleBoost}
                                    onShare={handleShare}
                                    formatCompactNumber={formatCompactNumber}
                                    muted={globalMuted}
                                    onMutedChange={handleMuteChange}
                                    bottomBarHeight={bottomBarHeight}
                                    t={t}
                                    windowHeight={WINDOW_HEIGHT}
                                    isDesktop={isDesktop}
                                    viewerId={viewerId}
                                />
                            ))}
                        </View>
                    ) : (
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
                    )
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
    tapLayer: ViewStyle;
    heartPop: ViewStyle;
    pauseAffordance: ViewStyle;
    pauseAffordanceInner: ViewStyle;
    bufferSpinner: ViewStyle;
    bufferSpinnerInner: ViewStyle;
    scrubberHitArea: ViewStyle;
    scrubberTrack: ViewStyle;
    scrubberTrackActive: ViewStyle;
    scrubberFill: ViewStyle;
    errorBadge: ViewStyle;
    muteButton: ViewStyle;
    muteButtonInner: ViewStyle;
    overlay: ViewStyle;
    gradientOverlay: ViewStyle;
    rightActions: ViewStyle;
    actionButton: ViewStyle;
    actionIcon: TextStyle;
    actionCount: TextStyle;
    viewCount: ViewStyle;
    bottomInfo: ViewStyle;
    userInfo: ViewStyle;
    userHeaderRow: ViewStyle;
    userHeader: ViewStyle;
    onVideoFollow: ViewStyle;
    userAvatar: ViewStyle;
    userNameContainer: ViewStyle;
    userNameRow: ViewStyle;
    userFullName: TextStyle;
    userHandle: TextStyle;
    verifiedIcon: TextStyle;
    caption: ViewStyle;
    postText: TextStyle;
    postLink: TextStyle;
    captionToggle: TextStyle;
    soundRow: ViewStyle;
    soundIcon: TextStyle;
    soundText: TextStyle;
    tabsRow: ViewStyle;
    tabPill: ViewStyle;
    tabPillActive: ViewStyle;
    tabPillInactive: ViewStyle;
    tabLabel: TextStyle;
    tabLabelActive: TextStyle;
    tabLabelInactive: TextStyle;
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
    tapLayer: {
        ...StyleSheet.absoluteFill,
        zIndex: 2,
    },
    heartPop: {
        ...StyleSheet.absoluteFill,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 4,
    },
    pauseAffordance: {
        ...StyleSheet.absoluteFill,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 3,
    },
    pauseAffordanceInner: {
        width: 88,
        height: 88,
        borderRadius: 44,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    bufferSpinner: {
        ...StyleSheet.absoluteFill,
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 4,
    },
    bufferSpinnerInner: {
        width: 56,
        height: 56,
        borderRadius: 28,
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    scrubberHitArea: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 16,
        justifyContent: 'flex-end',
        zIndex: 7,
    },
    scrubberTrack: {
        height: 3,
        width: '100%',
        backgroundColor: 'rgba(255, 255, 255, 0.25)',
    },
    scrubberTrackActive: {
        height: 5,
    },
    scrubberFill: {
        height: '100%',
        backgroundColor: '#FFFFFF',
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
    viewCount: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        minWidth: 40,
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
    userHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    userHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        flexShrink: 1,
    },
    onVideoFollow: {
        flexShrink: 0,
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
    caption: {
        marginTop: 4,
    },
    postText: {
        color: '#FFFFFF',
        fontSize: 14,
        lineHeight: 18,
        fontWeight: '400',
        ...TEXT_SHADOW_STRONG,
    },
    postLink: {
        color: '#9FD0FF',
        fontWeight: '600',
    },
    captionToggle: {
        color: 'rgba(255, 255, 255, 0.85)',
        fontSize: 13,
        fontWeight: '700',
        marginTop: 2,
        ...TEXT_SHADOW_MEDIUM,
    },
    soundRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        marginTop: 2,
    },
    soundIcon: {
        ...TEXT_SHADOW_STRONG,
    },
    soundText: {
        color: '#FFFFFF',
        fontSize: 12,
        fontWeight: '500',
        flexShrink: 1,
        ...TEXT_SHADOW_STRONG,
    },
    tabsRow: {
        position: 'absolute',
        left: 0,
        right: 0,
        flexDirection: 'row',
        justifyContent: 'center',
        gap: 8,
        zIndex: 12,
        // Web only: a fixed row height so the `position: sticky` overlay's
        // negative bottom margin (WEB_TABS_STICKY_CLASS, -TABS_ROW_HEIGHT) nets to
        // exactly zero layout height. Native sizes to content and stays
        // `position: absolute` with no layout footprint.
        ...Platform.select({ web: { height: TABS_ROW_HEIGHT }, default: {} }),
    },
    tabPill: {
        paddingHorizontal: 16,
        paddingVertical: 7,
        borderRadius: 18,
    },
    tabPillActive: {
        backgroundColor: 'rgba(255, 255, 255, 0.2)',
    },
    tabPillInactive: {
        backgroundColor: 'rgba(0, 0, 0, 0.25)',
    },
    tabLabel: {
        fontSize: 15,
        // Explicit line height makes the pill height deterministic
        // (paddingVertical 7×2 + 20 = TABS_ROW_HEIGHT) so the web sticky overlay's
        // negative bottom margin nets to zero.
        lineHeight: 20,
        ...TEXT_SHADOW_STRONG,
    },
    tabLabelActive: {
        color: '#FFFFFF',
        fontWeight: '800',
    },
    tabLabelInactive: {
        color: 'rgba(255, 255, 255, 0.7)',
        fontWeight: '600',
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
