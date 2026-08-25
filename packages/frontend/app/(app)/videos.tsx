import React, { useCallback, useContext, useEffect, useRef, useState, useMemo, memo } from 'react';
import { StyleSheet, View, Text, Pressable, FlatList, Platform, Share, useWindowDimensions, type ViewStyle, type TextStyle, type ImageStyle } from 'react-native';
import { Image } from 'expo-image';
import { toast } from '@oxyhq/bloom/toast';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated from 'react-native-reanimated';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth, FollowButton } from '@oxyhq/services/ui/client';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, useLocalSearchParams, useIsFocused } from 'expo-router';
import { usePostsStore } from '@/stores/postsStore';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import { feedService } from '@/services/feedService';
import { proxyExternalUrl, videoPosterUrl } from '@/utils/imageUrlCache';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { SEO } from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { Video } from '@/assets/icons/video-icon';
import { formatCompactNumber } from '@/utils/formatNumber';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { cn } from '@/lib/utils';
import type { HydratedPost } from '@mention/shared-types';
import { readMediaDurationSec, readMediaPixelSize, type MediaPixelSize } from '@/utils/mediaTypes';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { useIsRightBarVisible } from '@/hooks/useOptimizedMediaQuery';
import { useVideosRail, type VideosRailActivePost } from '@/context/VideosRailContext';
import { VideoViewabilityProvider } from '@/context/VideoPlaybackContext';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { VideoReplies } from '@/components/videos/VideoReplies';
import { HIT_SLOP_LG } from '@/styles/hitSlop';
import { useVideoPipSession } from '@/hooks/useVideoPipSession';
import { useReelImpressions } from '@/hooks/useReelImpressions';
import { useMediaSessionTransport, type MediaSessionTrack } from '@/hooks/useMediaSessionTransport';
import { usePipTransportActions } from '@/hooks/usePipTransportActions';
import {
    useReelChrome,
    type PlayableSource,
    type ReelChromeParams,
    type RegisterTransportSeek,
} from '@/hooks/useReelChrome';
import { MediaFlightHost, hasFlight, useMediaFlight } from '@oxyhq/bloom/media-flight';
import { useVideoPlayerLease, videoPlayerKey, type VideoPlayerKey } from '@/stores/videoPlayerRegistry';
import { resolveFeedDescriptor } from '@/utils/feedTelemetry';

// ── Tuning constants ─────────────────────────────────────────────
// One-screen vertical pager: keep the live-player window tight so only the
// active video and its neighbours hold a decoder.
const FEED_PAGE_LIMIT = 20;
// Players are live only for the active index ± this radius.
// Widened from 1: at radius 2, the video two swipes away already has a live
// player mounted (buffering, muted, never playing — see the shouldPlay gate
// below) instead of only a static poster, so its stream has strictly more
// lead time to buffer before the viewer reaches it. Five concurrent mounted
// players (-2,-1,0,+1,+2) is still a bounded, small number of decoders.
const ACTIVE_WINDOW_RADIUS = 2;
// Poster images are tiny (the `thumb` variant, already cached memory-disk) —
// prefetch a wider window than the live-player radius so the very first frame
// the viewer sees on a fast multi-swipe is already in cache, even before that
// row's video decoder starts buffering.
const POSTER_PREFETCH_RADIUS = ACTIVE_WINDOW_RADIUS + 2;
// FlatList must keep the window rows mounted (poster) so they can promote to a
// live player without a remount; WINDOW_SIZE is in screens (one screen = one row).
// WINDOW_SIZE must stay >= 2*ACTIVE_WINDOW_RADIUS+1 (5 for radius 2) or the extra
// radius above is inert on native — a row FlatList never renders can't mount an
// ActiveVideoSurface no matter what ACTIVE_WINDOW_RADIUS says.
const FLATLIST_CONFIG = {
    INITIAL_NUM_TO_RENDER: 2,
    MAX_TO_RENDER_PER_BATCH: 2,
    // 1 visible + 2 above + 2 below = 5 retained rows, matching ACTIVE_WINDOW_RADIUS=2.
    WINDOW_SIZE: 5,
    // Raised from 0.4: trigger the next page fetch with more runway left in
    // the current page, so pagination network latency is absorbed before the
    // viewer actually runs out of loaded posts, instead of racing it.
    END_REACHED_THRESHOLD: 0.6,
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


const GRADIENT_COLORS = ['transparent', 'rgba(0, 0, 0, 0.3)', 'rgba(0, 0, 0, 0.8)', '#000000'] as const;
const GRADIENT_LOCATIONS = [0, 0.4, 0.7, 1] as const;
const LIKE_ACTIVE_COLOR = '#FF3040';
const BOOST_ACTIVE_COLOR = '#10B981';
const VERIFIED_COLOR = '#1DA1F2';

// Caption is collapsed to two lines until this length, where a "more" toggle is
// offered (TikTok-style expandable caption).
const CAPTION_EXPAND_MIN_CHARS = 80;
// expo-video timeUpdate cadence (seconds) driving the scrubber.
const TIME_UPDATE_INTERVAL_S = 0.25;

// Circular overlay buttons (mute, Picture-in-Picture) stack down the top-right
// corner of the surface, above the video and the tap layer.
const OVERLAY_BUTTON_SIZE = 44;
const OVERLAY_BUTTON_TOP = 50;
const OVERLAY_BUTTON_RIGHT = 16;
const OVERLAY_BUTTON_GAP = 12;
const OVERLAY_BUTTON_ICON_SIZE = 22;

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
    hlsUrl?: string;
    type?: 'image' | 'video' | 'gif';
    durationSec?: number;
    orientation?: 'portrait' | 'landscape' | 'square';
    aspectRatio?: number;
    // Intrinsic pixel size, persisted at ingest. Read for the PiP window's shape,
    // which needs a size before playback has reported one.
    width?: number;
    height?: number;
}

interface VideoPost extends HydratedPost {
    videoUrl: string;
    // The raw (non-HLS) original URL, always playable. `videoUrl` prefers the
    // adaptive HLS stream when present; `ActiveVideoSurface` retries with this
    // exactly once if the preferred source errors (e.g. HLS not transcoded yet).
    fallbackVideoUrl?: string;
    posterUrl?: string;
    /** Persisted duration from content.media[] (seconds); seeds scrubber before player metadata loads. */
    durationSec?: number;
    /**
     * Persisted intrinsic pixel size from content.media[]. Gives the OS
     * Picture-in-Picture window its shape before the player reports a track — see
     * `usePipAspectRatio`.
     */
    intrinsicSize?: MediaPixelSize;
    /**
     * The media item this slide plays. Half of the identity the feed and this
     * screen agree on for one video — the other half is the post id — so a slide
     * can tell whether it is the one a flight was aimed at.
     */
    mediaId?: string;
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
    onSave: (postId: string, isSaved: boolean) => void;
    onShare: (post: VideoPost) => void;
    formatCompactNumber: (count: number) => string;
    muted: boolean;
    onMutedChange: (muted: boolean) => void;
    bottomBarHeight: number;
    t: (key: string) => string;
    windowHeight: number;
    // The signed-in viewer's id — hides the on-video follow button on the
    // author's own video.
    viewerId?: string;
    // PiP session plumbing, forwarded to the surface (see ActiveVideoSurfaceProps).
    ownsSession: boolean;
    sessionActive: boolean;
    sessionSource?: PlayableSource;
    onSessionStart: (postId: string) => void;
    onSessionEnd: (postId: string) => void;
    onRegisterTransportSeek: RegisterTransportSeek;
}

// ── Active player surface ────────────────────────────────────────
// ── Active player surface ────────────────────────────────────────
// Mounted ONLY when the row is inside the live-player window. Holds the single
// `useVideoPlayer` instance (auto-released on unmount), so leaving the window
// tears the decoder down. A poster sits behind the surface until `readyToPlay`.
//
// Every field the chrome needs is declared once, on `ReelChromeParams`; the two
// below are this component's own, used only by what it renders.
interface ActiveVideoSurfaceProps extends Omit<ReelChromeParams, 'player' | 'restartOnActivate'> {
    // How much of the surface's bottom edge the floating BottomBar covers. The
    // scrubber is the overlay's SIBLING, so it does not inherit the overlay's
    // own bottom padding and has to lift itself clear of the bar.
    bottomBarHeight: number;
    theme: ReturnType<typeof useTheme>;
}

/**
 * The reel slide's body: chrome plus the view that paints it, for a player it is
 * HANDED. It does not build one, so the same body serves the ordinary slide and
 * the one that adopted a video mid-flight from the feed.
 */
/**
 * The id a slide claims its media node under when it has no flight identity —
 * no media id, so nothing the feed could have agreed on. It only has to be
 * unique per slide, never matched to anything.
 */
const reelHostId = (postId: string): string => `reel:${postId}`;

const ReelSurface: React.FC<ActiveVideoSurfaceProps & {
    player: VideoPlayer;
    /**
     * The id this slide shares with the feed row it came from. Present whenever
     * the media can be identified; a slide without one still paints through a
     * host, under an id nothing else claims.
     */
    flightId?: VideoPlayerKey;
    /**
     * Whether activating this slide rewinds it. True everywhere except the slide
     * that adopted a playing video: rewinding that one would undo the entire
     * point of carrying it across.
     */
    restartOnActivate: boolean;
    onFirstFrameRender?: () => void;
}> = ({
    player,
    flightId,
    restartOnActivate,
    onFirstFrameRender,
    postId,
    videoUrl,
    fallbackVideoUrl,
    posterUrl,
    initialDurationSec,
    intrinsicSize,
    isActive,
    screenFocused,
    bottomBarHeight,
    windowHeight,
    muted,
    onMutedChange,
    onError,
    t,
    theme,
    isLiked,
    onLikePost,
    ownsSession,
    sessionActive,
    sessionSource,
    onSessionStart,
    onSessionEnd,
    onRegisterTransportSeek,
}) => {
    // Everything layered on top of that player — poster, heart, mute, PiP,
    // scrubber, playback gate, wake lock, transport. It takes the player as an
    // argument and never asks who made it, which is what will let a surface be
    // handed one from a shared registry instead of building its own.
    const {
        // NOT destructured any more: `videoViewRef`, `isWatched` and the two
        // Picture-in-Picture callbacks. `MediaFlightHost` exposes no ref and no
        // PiP props, so the reel can no longer ASK for PiP — the chrome hook
        // still provides them and every other caller is untouched, but this
        // screen has nothing to attach them to. Flagged, not quietly deleted.
        showPoster,
        posterFailed,
        handlePosterError,
        handleSurfacePress,
        userPaused,
        heartStyle,
        showPauseAffordance,
        showBufferSpinner,
        toggleMute,
        showPipButton,
        handleStartPictureInPicture,
        showScrubber,
        onTrackLayout,
        panResponder,
        isScrubbing,
        progress,
        hasError,
    } = useReelChrome({
        player,
        restartOnActivate,
        postId,
        videoUrl,
        fallbackVideoUrl,
        posterUrl,
        initialDurationSec,
        intrinsicSize,
        isActive,
        screenFocused,
        windowHeight,
        muted,
        onMutedChange,
        onError,
        t,
        isLiked,
        onLikePost,
        ownsSession,
        sessionActive,
        sessionSource,
        onSessionStart,
        onSessionEnd,
        onRegisterTransportSeek,
    });

    return (
        <>
            {/* The same shared node the feed row was painting, claimed by id.
                It is not a `VideoView` of this screen's own: one element that
                MOVES is what keeps the decoder, the position and the playback
                across the route change. */}
            <MediaFlightHost
                id={flightId ?? reelHostId(postId)}
                content={{ kind: 'video', player }}
                style={StyleSheet.absoluteFill}
                contentFit="contain"
                pointerEvents="none"
            />

            {showPoster && (
                <View style={styles.posterLayer} className="bg-muted" pointerEvents="none">
                    {posterUrl && !posterFailed ? (
                        <Image
                            source={{ uri: posterUrl }}
                            style={styles.poster}
                            contentFit="contain"
                            cachePolicy="memory-disk"
                            transition={150}
                            priority="high"
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

            <Pressable style={styles.muteButton} onPress={toggleMute} hitSlop={HIT_SLOP_LG}>
                <View style={styles.overlayButtonInner}>
                    <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={OVERLAY_BUTTON_ICON_SIZE} color="white" />
                </View>
            </Pressable>

            {showPipButton && (
                <Pressable
                    style={styles.pipButton}
                    onPress={handleStartPictureInPicture}
                    hitSlop={HIT_SLOP_LG}
                    accessibilityRole="button"
                    accessibilityLabel={t('videos.picture_in_picture')}
                >
                    <View style={styles.overlayButtonInner}>
                        <Ionicons name="browsers-outline" size={OVERLAY_BUTTON_ICON_SIZE} color="white" />
                    </View>
                </Pressable>
            )}

            {showScrubber && (
                <View
                    // Lifted clear of the floating BottomBar: pinned to the
                    // surface's own bottom edge the whole 16px band sits UNDER
                    // the bar, which takes every touch meant for the track.
                    style={[styles.scrubberHitArea, { bottom: bottomBarHeight }]}
                    // Vertical only on purpose: the track's x maps to seek
                    // position, so widening it horizontally would make the
                    // touch-to-time mapping lie past both ends.
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
};

/** The ordinary slide: its own player, released with it, rewound on activation. */
const OwnPlayerSurface: React.FC<ActiveVideoSurfaceProps> = (props) => {
    // Built ONCE from this row's own source and never rebuilt: `useVideoPlayer`
    // releases and recreates its player whenever the source argument changes,
    // which would tear the OS window's subject out from under it mid-session.
    // Every later source change goes through `replaceAsync`.
    const player = useVideoPlayer(props.videoUrl, (p: VideoPlayer) => {
        p.loop = true;
        // Drive the scrubber at a smooth-but-cheap cadence.
        p.timeUpdateEventInterval = TIME_UPDATE_INTERVAL_S;
        // Single source of truth for the initial mute: the global store value
        // captured at mount. Subsequent changes flow through the sync effect.
        p.muted = props.muted;
    });
    return <ReelSurface {...props} player={player} restartOnActivate />;
};

/**
 * The slide the feed flew a video into: it takes the SAME player from the
 * registry rather than building one, so there is no second decoder and no seek
 * back to zero.
 *
 * This slide reports its own first painted frame with `handOff`, which is the
 * documented path for "a destination that renders something other than a Bloom
 * surface" — the reel paints expo-video's `VideoView` directly, so the
 * `flightId`-on-`MediaSurface` shortcut does not apply to it.
 *
 * `handOff` rather than `releaseFlight`: called mid-flight the layer REMEMBERS
 * it and lets the surface finish travelling, where releasing outright would
 * make it vanish somewhere between the two rects. `onFirstFrameRender` may fire
 * again later (expo-video re-emits it when the video track changes), which
 * costs nothing — handing off an id that is no longer in flight is a no-op.
 */
const AdoptedPlayerSurface: React.FC<ActiveVideoSurfaceProps & { flightId: VideoPlayerKey }> = ({ flightId, ...props }) => {
    const player = useVideoPlayerLease(flightId, props.videoUrl);
    const { handOff } = useMediaFlight();
    const handleFirstFrame = useCallback(() => handOff(flightId), [handOff, flightId]);
    return (
        <ReelSurface
            {...props}
            flightId={flightId}
            player={player}
            restartOnActivate={false}
            onFirstFrameRender={handleFirstFrame}
        />
    );
};

const ActiveVideoSurface = memo<ActiveVideoSurfaceProps & { flightId?: VideoPlayerKey }>((props) => {
    const { flightId, ...rest } = props;
    // Decided ONCE, at mount: "was a flight live for this media when this slide
    // appeared". Read through a lazy initialiser rather than during every render
    // — the answer stops being true the moment the flight is released, and a
    // slide that swapped player identity mid-life would restart the video.
    const [adopted] = useState(() => flightId !== undefined && hasFlight(flightId));
    return adopted && flightId
        ? <AdoptedPlayerSurface {...rest} flightId={flightId} />
        : <OwnPlayerSurface {...rest} />;
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
    onSave,
    onShare,
    formatCompactNumber,
    muted,
    onMutedChange,
    bottomBarHeight,
    t,
    windowHeight,
    viewerId,
    ownsSession,
    sessionActive,
    sessionSource,
    onSessionStart,
    onSessionEnd,
    onRegisterTransportSeek,
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

    const userName = useMemo(() => item.user?.name?.displayName ?? '', [item.user?.name?.displayName]);
    const userHandle = useMemo(
        () => getNormalizedUserHandle(item.user) || t('common.unknown'),
        [item.user, t],
    );
    const postText = useMemo(() => item.content?.text?.trim() || '', [item.content?.text]);

    const handleProfilePress = useCallback(() => {
        const handle = getNormalizedUserHandle(item.user);
        if (handle) {
            router.push(`/@${handle}/videos`);
        }
    }, [item.user, router]);

    // Like-only handler for the double-tap gesture — never unlikes.
    const handleDoubleTapLike = useCallback(() => {
        if (!item.viewerState.isLiked) {
            onLike(item.id, false);
        }
    }, [item.id, item.viewerState.isLiked, onLike]);

    const canRenderPlayer = isNear && !videoError && item.videoUrl.length > 0;
    const showOnVideoFollow = Boolean(item.user?.id) && item.user?.id !== viewerId;
    const showCaptionToggle = postText.length > CAPTION_EXPAND_MIN_CHARS;

    return (
        <View
            className={cn(WEB_SLIDE_HEIGHT_CLASS, 'web:[scroll-snap-align:start]')}
            style={[styles.videoContainer, Platform.OS === 'web' ? null : { height: windowHeight }]}
        >
            {canRenderPlayer ? (
                <ActiveVideoSurface
                    flightId={item.mediaId ? videoPlayerKey(item.id, item.mediaId) : undefined}
                    postId={item.id}
                    videoUrl={item.videoUrl}
                    fallbackVideoUrl={item.fallbackVideoUrl}
                    posterUrl={item.posterUrl}
                    initialDurationSec={item.durationSec}
                    intrinsicSize={item.intrinsicSize}
                    isActive={isActive}
                    screenFocused={screenFocused}
                    bottomBarHeight={bottomBarHeight}
                    windowHeight={windowHeight}
                    muted={muted}
                    onMutedChange={onMutedChange}
                    onError={handleError}
                    t={t}
                    theme={theme}
                    isLiked={item.viewerState.isLiked}
                    onLikePost={handleDoubleTapLike}
                    ownsSession={ownsSession}
                    sessionActive={sessionActive}
                    sessionSource={sessionSource}
                    onSessionStart={onSessionStart}
                    onSessionEnd={onSessionEnd}
                    onRegisterTransportSeek={onRegisterTransportSeek}
                />
            ) : (
                // Outside the live window (or errored): no decoder, just a poster.
                <View style={[styles.video, styles.videoPlaceholder]} className="bg-muted">
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
                                    source={item.user?.avatar ?? undefined}
                                    size={40}
                                    variant={MEDIA_VARIANT_AVATAR}
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

                <View style={styles.rightActions} pointerEvents="box-none">
                    <ActionButton
                        icon={item.viewerState.isLiked ? 'heart' : 'heart-outline'}
                        count={item.engagement.likes ?? 0}
                        isActive={item.viewerState.isLiked}
                        activeColor={LIKE_ACTIVE_COLOR}
                        onPress={() => onLike(item.id, item.viewerState.isLiked)}
                        formatCompactNumber={formatCompactNumber}
                        accessibilityLabel={t(item.viewerState.isLiked ? 'videos.unlike' : 'videos.like')}
                    />
                    <ActionButton
                        icon="chatbubble-outline"
                        count={item.engagement.replies ?? 0}
                        onPress={() => onComment(item.id)}
                        formatCompactNumber={formatCompactNumber}
                        accessibilityLabel={t('videos.comment')}
                    />
                    <ActionButton
                        icon={item.viewerState.isBoosted ? 'repeat' : 'repeat-outline'}
                        count={item.engagement.boosts ?? 0}
                        isActive={item.viewerState.isBoosted}
                        activeColor={BOOST_ACTIVE_COLOR}
                        onPress={() => onBoost(item.id, item.viewerState.isBoosted)}
                        formatCompactNumber={formatCompactNumber}
                        accessibilityLabel={t(item.viewerState.isBoosted ? 'videos.unboost' : 'videos.boost')}
                    />
                    {/* Saved state is carried by the filled icon alone — a reel's
                        rail has no brand colour for it, and inventing one would
                        put a fourth accent over the video. */}
                    <ActionButton
                        icon={item.viewerState.isSaved ? 'bookmark' : 'bookmark-outline'}
                        count={item.engagement.saves ?? 0}
                        onPress={() => onSave(item.id, item.viewerState.isSaved)}
                        formatCompactNumber={formatCompactNumber}
                        accessibilityLabel={t(item.viewerState.isSaved ? 'videos.unsave' : 'videos.save')}
                    />
                    <ActionButton
                        icon="share-outline"
                        count={0}
                        onPress={() => onShare(item)}
                        formatCompactNumber={formatCompactNumber}
                        hideCount={true}
                        accessibilityLabel={t('videos.share')}
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
    // Required: the icon carries the whole meaning of these buttons, and the
    // count beside it reads as the label to a screen reader otherwise ("4.2K").
    accessibilityLabel: string;
}

const ActionButton = memo<ActionButtonProps>(({ icon, count, isActive, activeColor, onPress, formatCompactNumber, hideCount = false, accessibilityLabel }) => (
    <Pressable
        style={styles.actionButton}
        onPress={onPress}
        hitSlop={HIT_SLOP_LG}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
    >
        <Ionicons
            name={icon}
            size={30}
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
        hitSlop={HIT_SLOP_LG}
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
    const isFocused = useIsFocused();
    const params = useLocalSearchParams<{ postId?: string; mediaIndex?: string }>();
    const { oxyServices, user, canUsePrivateApi, isAuthResolved, isAuthenticated } = useAuth();
    const viewerId = user?.id;
    const { likePost, unlikePost, boostPost, unboostPost, savePost, unsavePost, getPostById, cachePosts } = usePostsStore();
    // Desktop (>=990) gate. Actions + follow now overlay the video on every
    // breakpoint (matching mobile); `isDesktop` only decides how the comment
    // button behaves — a no-op on desktop (replies are already open in the
    // RightBar) vs. opening the bottom sheet on mobile.
    const isDesktop = useIsRightBarVisible();
    const { setRailState, requestComposerFocus } = useVideosRail();
    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    const [posts, setPosts] = useState<VideoPost[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [hasMore, setHasMore] = useState(true);
    const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
    const [loadingMore, setLoadingMore] = useState(false);
    const [currentVisibleIndex, setCurrentVisibleIndex] = useState(0);

    // Close the mobile bottom sheet when the active video changes — otherwise
    // swiping to a new video while it's open would leave the PREVIOUS video's
    // replies showing over the new one. Desktop has no such toggle anymore —
    // the always-open replies column (RightBar) reflects whatever video is
    // currently active via VideosRailContext's `activePost`, no reset needed.
    const isFirstVisibleIndexRender = useRef(true);
    useEffect(() => {
        if (isFirstVisibleIndexRender.current) {
            isFirstVisibleIndexRender.current = false;
            return;
        }
        openBottomSheet(false);
    }, [currentVisibleIndex, openBottomSheet]);

    // Prefetch posters in a wider radius than the live-player window — see
    // `POSTER_PREFETCH_RADIUS` above.
    useEffect(() => {
        const start = Math.max(0, currentVisibleIndex - POSTER_PREFETCH_RADIUS);
        const end = Math.min(posts.length - 1, currentVisibleIndex + POSTER_PREFETCH_RADIUS);
        for (let i = start; i <= end; i++) {
            const posterUrl = posts[i]?.posterUrl;
            if (posterUrl) {
                Image.prefetch(posterUrl).catch(() => {
                    // Prefetch is a pure optimization — a failure here is
                    // identical to a cache miss, never surfaced to the viewer.
                });
            }
        }
    }, [currentVisibleIndex, posts]);
    // 'videos' = For You (ranked video feed); 'following' = following feed filtered
    // to videos. Read through a ref inside the stable load callbacks so switching
    // tabs doesn't thrash callback identity.
    const [activeFeed, setActiveFeed] = useState<VideoFeedTab>('videos');
    const activeFeedRef = useRef<VideoFeedTab>(activeFeed);
    activeFeedRef.current = activeFeed;
    const { isMuted: globalMuted, loadMutedState } = useVideoMuteStore();

    // If the viewer signs out while on Following, fall back to For You. Gated on
    // `isAuthResolved` so the undetermined cold-boot window (where the session is
    // about to restore) doesn't yank a Following viewer back to For You. Adjusted
    // during render rather than in an effect — this converges in one pass (the
    // condition is false once `activeFeed` flips) and avoids a throwaway Following
    // fetch from the load effect below. See React "You Might Not Need an Effect".
    if (isAuthResolved && !isAuthenticated && activeFeed === 'following') {
        setActiveFeed('videos');
    }
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

    // The raw/original URL — always playable, used as `fallbackVideoUrl`.
    // Unchanged from before this HLS work; every existing resolution path
    // (server `url`, http passthrough via proxy, legacy client-side Oxy
    // resolution) is preserved exactly.
    const resolveFallbackVideoUrl = useCallback((ref: MediaRef): string => {
        if (ref?.url) return ref.url;
        const raw = ref?.id || '';
        if (!raw) return '';
        if (raw.startsWith('http')) return proxyExternalUrl(raw);
        return oxyServices?.getFileDownloadUrl ? oxyServices.getFileDownloadUrl(raw) : '';
    }, [oxyServices]);

    // Preferred playback URL: the adaptive HLS stream when the server resolved
    // one (native video only — federated media never has `hlsUrl`), else the
    // same raw/original URL `resolveFallbackVideoUrl` would return.
    const resolveVideoUrl = useCallback((ref: MediaRef): string => {
        if (ref?.hlsUrl) return ref.hlsUrl;
        return resolveFallbackVideoUrl(ref);
    }, [resolveFallbackVideoUrl]);

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

    // Build a VideoPost from a canonical hydrated post, selecting the requested
    // video. Posts that merely CONTAIN a video qualify (multi-video, or a video
    // among images).
    const toVideoPost = useCallback((post: HydratedPost, preferredMediaIndex?: number): VideoPost | null => {
        const media: MediaRef[] = post.content.media ?? post.attachments.media ?? [];
        if (media.length === 0) return null;

        let selected: MediaRef | undefined;
        if (
            preferredMediaIndex !== undefined &&
            media[preferredMediaIndex]?.type === 'video'
        ) {
            selected = media[preferredMediaIndex];
        } else {
            selected = media.find((m) => m?.type === 'video' && m?.orientation === 'portrait')
                ?? media.find((m) => m?.type === 'video');
        }
        if (!selected) return null;

        const videoUrl = resolveVideoUrl(selected);
        if (!videoUrl) return null;
        const rawFallback = resolveFallbackVideoUrl(selected);
        const fallbackVideoUrl = rawFallback && rawFallback !== videoUrl ? rawFallback : undefined;

        return {
            ...post,
            createdAt: post.metadata.createdAt,
            videoUrl,
            fallbackVideoUrl,
            posterUrl: resolvePosterUrl(selected),
            durationSec: readMediaDurationSec(selected),
            intrinsicSize: readMediaPixelSize(selected),
            mediaId: selected.id ? String(selected.id) : undefined,
        };
    }, [resolveVideoUrl, resolveFallbackVideoUrl, resolvePosterUrl]);

    const filterVideoPosts = useCallback((allPosts: HydratedPost[]): VideoPost[] => {
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
            const videoPosts = filterVideoPosts(response.items ?? []);
            const newPosts = videoPosts.filter(p => !shownIdsRef.current.has(p.id));

            if (newPosts.length > 0) {
                newPosts.forEach(p => shownIdsRef.current.add(p.id));
                // Seed the SHARED post cache, exactly as `useFeedState` does for
                // every other feed. Without it the reel is invisible to the store:
                // `updatePostEverywhere` is a read-modify-write that returns null
                // for a post it has never seen, so every store write about a reel
                // post — a like, a save, the server's view count — was a silent
                // no-op, and none of it reached `/p/[id]` or the profile grids.
                // Only the deep-link target escaped that, because `getPostById`
                // upserts on its way through.
                cachePosts(newPosts);
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
    }, [filterVideoPosts, cachePosts]);

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
    // FlatList by the slide height. `animated` is off for the jump back from a
    // PiP session, which can span dozens of slides the viewer never scrolled.
    const goToIndex = useCallback((targetIndex: number, animated = true) => {
        const clamped = Math.min(Math.max(targetIndex, 0), posts.length - 1);
        if (clamped < 0) return;
        if (Platform.OS === 'web') {
            if (typeof window !== 'undefined') {
                window.scrollTo({ top: clamped * window.innerHeight, behavior: animated ? 'smooth' : 'auto' });
            }
        } else {
            flatListRef.current?.scrollToOffset({ offset: clamped * WINDOW_HEIGHT, animated });
        }
    }, [posts.length, WINDOW_HEIGHT]);

    const prev = useCallback(() => goToIndex(currentVisibleIndex - 1), [goToIndex, currentVisibleIndex]);
    const next = useCallback(() => goToIndex(currentVisibleIndex + 1), [goToIndex, currentVisibleIndex]);

    // ── Picture-in-Picture session ──────────────────────────────────
    // While the OS window is open the pager stays exactly where it was: the
    // window is bound to that surface's player, and moving the pager would both
    // unmount the player out from under the OS and hand the audible slot to a
    // surface nobody can see. The session walks its own cursor instead, the
    // owner's player takes each new source, and the pager is re-synced to the
    // cursor on the way out so the app comes back on the right video.
    //
    // A session can also end because its owner was torn down rather than because
    // the viewer closed the window — a tab switch rebuilds the whole list — and
    // then the reload owns the index, so a cursor that no longer points into the
    // list is dropped instead of applied. The length is mirrored into a ref (as
    // the pagination state above is) because the surface that reports the end is
    // unmounting, and its callback closes over the render BEFORE the rebuild.
    const postsLengthRef = useRef(posts.length);
    postsLengthRef.current = posts.length;

    const handleSessionEnded = useCallback((index: number) => {
        if (index >= postsLengthRef.current) return;
        setCurrentVisibleIndex(index);
        goToIndex(index, false);
    }, [goToIndex]);

    const {
        ownerId: pipOwnerId,
        playing: pipPlaying,
        start: startPipSession,
        end: endPipSession,
        goToNext: pipGoToNext,
        goToPrevious: pipGoToPrevious,
    } = useVideoPipSession({
        items: posts,
        onEnded: handleSessionEnded,
        loadMore: handleLoadMore,
        hasMore,
    });

    const sessionSource = useMemo<PlayableSource | undefined>(
        () => (pipPlaying
            ? { url: pipPlaying.videoUrl, fallbackUrl: pipPlaying.fallbackVideoUrl }
            : undefined),
        [pipPlaying],
    );

    // The transport controls act on ONE player, published up by whichever surface
    // is currently being watched (see `onRegisterTransportSeek` there).
    const transportSeekRef = useRef<((seconds: number) => void) | null>(null);
    const registerTransportSeek = useCallback<RegisterTransportSeek>((seek) => {
        transportSeekRef.current = seek;
        return () => {
            if (transportSeekRef.current === seek) {
                transportSeekRef.current = null;
            }
        };
    }, []);

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
                    ? {
                        ...p,
                        viewerState: { ...p.viewerState, isLiked: !isLiked },
                        engagement: {
                            ...p.engagement,
                            likes: Math.max(
                                0,
                                (p.engagement.likes ?? 0) + (isLiked ? -1 : 1),
                            ),
                        },
                    }
                    : p
            ));
        } catch {
            toast(t('common.error'), { type: 'error' });
        }
    }, [likePost, unlikePost, t]);

    const handleCommentPosted = useCallback((postId: string) => {
        setPosts(prev => prev.map(p =>
            p.id === postId
                ? {
                    ...p,
                    engagement: {
                        ...p.engagement,
                        replies: (p.engagement.replies ?? 0) + 1,
                    },
                }
                : p
        ));
    }, []);

    const handleComment = useCallback((postId: string) => {
        if (isDesktop) {
            // The replies column (RightBar) is already showing this post, so
            // there is nothing to open — but a button that paints and then does
            // nothing observable is a dead button. Put the caret in that
            // column's composer instead, which is what the press was asking for.
            requestComposerFocus();
            return;
        }
        setBottomSheetContent(
            <VideoReplies
                postId={postId}
                onClose={() => openBottomSheet(false)}
                onCommentPosted={() => handleCommentPosted(postId)}
            />,
            { scrollable: false },
        );
        openBottomSheet(true);
    }, [isDesktop, requestComposerFocus, setBottomSheetContent, openBottomSheet, handleCommentPosted]);

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
                    ? {
                        ...p,
                        viewerState: { ...p.viewerState, isBoosted: !isBoosted },
                        engagement: {
                            ...p.engagement,
                            boosts: Math.max(
                                0,
                                (p.engagement.boosts ?? 0) + (isBoosted ? -1 : 1),
                            ),
                        },
                    }
                    : p
            ));
        } catch {
            toast(t('common.error'), { type: 'error' });
        }
    }, [boostPost, unboostPost, t]);

    // Same optimistic shape as like/boost: the store's own update lands on its
    // copy of the post, which this screen's local `posts` state never reads, so
    // the rail's icon only flips if the screen updates itself.
    const handleSave = useCallback(async (postId: string, isSaved: boolean) => {
        try {
            if (isSaved) {
                await unsavePost({ postId });
            } else {
                // Attributed to the reel surface, not to the active tab's feed
                // descriptor: a save made here means "more videos like this"
                // whichever feed served it, and `following` is not classified as
                // a video-first surface (see `isVideoSurface`).
                await savePost({ postId }, 'videos');
            }
            setPosts(prev => prev.map(p =>
                p.id === postId
                    ? {
                        ...p,
                        viewerState: { ...p.viewerState, isSaved: !isSaved },
                        engagement: {
                            ...p.engagement,
                            saves: Math.max(
                                0,
                                (p.engagement.saves ?? 0) + (isSaved ? -1 : 1),
                            ),
                        },
                    }
                    : p
            ));
        } catch {
            toast(t('common.error'), { type: 'error' });
        }
    }, [savePost, unsavePost, t]);

    const handleShare = useCallback(async (post: VideoPost) => {
        try {
            const postUrl = `https://mention.earth/p/${post.id}`;
            const contentText = post?.content?.text || '';
            const user = post?.user;
            const name = user?.name?.displayName ?? t('common.someone');
            const handle = getNormalizedUserHandle(user) || '';
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

    // ── Desktop replies-panel coordination ──────────────────────────
    // The RightBar replies panel is a read-only projection of this screen's
    // active post. Writing this derived state to an external store is the same
    // legitimate-effect pattern as the ScreenColor screens. `active` flips true
    // on mount and false on unmount so the panel mounts/unmounts in lockstep
    // with /videos.
    useEffect(() => {
        setRailState({ active: true });
        return () => {
            setRailState({ active: false, activePost: null });
        };
    }, [setRailState]);

    const activeVideoPost = posts[currentVisibleIndex];

    const railActivePost = useMemo<VideosRailActivePost | null>(() => {
        if (!activeVideoPost) return null;
        return { id: activeVideoPost.id };
    }, [activeVideoPost]);

    // ── OS transport controls ───────────────────────────────────────
    // Media keys, the lock screen, and — the reason this is wired at all — the
    // next / previous buttons Chromium renders INSIDE the Picture-in-Picture
    // window. They act on whatever is playing: the session's cursor while the OS
    // window is open, else the slide the pager is on.
    const nowPlaying = pipPlaying ?? activeVideoPost;
    const transportTrack = useMemo<MediaSessionTrack | null>(() => {
        if (!nowPlaying) return null;
        const displayName = nowPlaying.user?.name?.displayName ?? '';
        const handle = getNormalizedUserHandle(nowPlaying.user);
        const caption = nowPlaying.content?.text?.trim() ?? '';
        return {
            // A caption-less reel is labelled by its author rather than by a
            // placeholder, and an unresolved author by the same string the sound
            // row already shows for one.
            title: caption || displayName || t('videos.original_audio'),
            artist: handle ? `@${handle}` : displayName,
            artwork: nowPlaying.posterUrl,
        };
    }, [nowPlaying, t]);

    const handleTransportNext = useCallback(() => {
        // Inside a session the pager is frozen, so "next" moves the cursor and
        // swaps the source under the OS window; outside one it pages normally.
        if (pipOwnerId !== null) {
            pipGoToNext();
            return;
        }
        next();
    }, [pipOwnerId, pipGoToNext, next]);

    const handleTransportPrevious = useCallback(() => {
        if (pipOwnerId !== null) {
            pipGoToPrevious();
            return;
        }
        prev();
    }, [pipOwnerId, pipGoToPrevious, prev]);

    const handleTransportSeek = useCallback((seconds: number) => {
        transportSeekRef.current?.(seconds);
    }, []);

    useMediaSessionTransport({
        track: transportTrack,
        onNext: handleTransportNext,
        onPrevious: handleTransportPrevious,
        onSeek: handleTransportSeek,
    });

    // Android draws the same two controls INSIDE the OS window, from a
    // `RemoteAction` list only native code can set — the platform's counterpart
    // to what `navigator.mediaSession` does for Chromium above, sharing its
    // handlers and therefore its session, so a press swaps the source under the
    // window instead of moving a pager nobody can see. A no-op on iOS (AVKit
    // offers no such API) and on web, and in any build that predates the module.
    usePipTransportActions({
        active: pipOwnerId !== null,
        nextLabel: t('videos.next'),
        previousLabel: t('videos.previous'),
        onNext: handleTransportNext,
        onPrevious: handleTransportPrevious,
    });

    // The reel is the viewability source for its own surfaces (native), exactly as
    // a feed list is for the players inside it: the snapped slide is the only one on
    // screen, and only while this screen is focused. The focus gate is what releases
    // the audible slot when another route is pushed on top — the reel stays mounted
    // underneath, so without it a blurred reel would keep the slot from the newly
    // focused screen's videos.
    const viewableVideoKeys = useMemo<ReadonlySet<string>>(
        () => (isFocused && activeVideoPost ? new Set([activeVideoPost.id]) : new Set()),
        [isFocused, activeVideoPost],
    );

    // Report what is being watched. The screen owns this — not the surfaces and
    // not the PiP session — because the two things a reel can be watching (the
    // pager's slide, the OS window's cursor) have to share ONE tracker to dedupe
    // against each other. See `useReelImpressions`.
    useReelImpressions({
        pipOwnerId,
        pipPlayingId: pipPlaying?.id,
        screenFocused: isFocused,
        activePostId: activeVideoPost?.id,
        // The reel fetches with exactly these feed types, so its impressions are
        // attributed to the same descriptor the feed was served under.
        feedDescriptor: resolveFeedDescriptor(activeFeed),
        impressionResetKey: viewerId,
        canReportImpressions: canUsePrivateApi,
    });

    // Publish the active post + the comment-posted callback so the RightBar
    // replies panel tracks whichever video is currently active and can bump the
    // comment count after a reply posts. Engagement itself lives on the on-video
    // action buttons (both platforms), so nothing else needs to cross over.
    useEffect(() => {
        setRailState({ activePost: railActivePost, onCommentPosted: handleCommentPosted });
    }, [setRailState, railActivePost, handleCommentPosted]);

    const renderVideoItem = useCallback(({ item, index }: { item: VideoPost; index: number }) => (
        <VideoItem
            item={item}
            isActive={index === currentVisibleIndex}
            // The session's owner keeps its player for as long as the OS window
            // is open, however far the pager has been scrolled from it: dropping
            // out of the live window would release the very player the window is
            // showing.
            isNear={Math.abs(index - currentVisibleIndex) <= ACTIVE_WINDOW_RADIUS || item.id === pipOwnerId}
            screenFocused={isFocused}
            theme={theme}
            onLike={handleLike}
            onComment={handleComment}
            onBoost={handleBoost}
            onSave={handleSave}
            onShare={handleShare}
            formatCompactNumber={formatCompactNumber}
            muted={globalMuted}
            onMutedChange={handleMuteChange}
            bottomBarHeight={bottomBarHeight}
            t={t}
            windowHeight={WINDOW_HEIGHT}
            viewerId={viewerId}
            ownsSession={item.id === pipOwnerId}
            sessionActive={pipOwnerId !== null}
            sessionSource={item.id === pipOwnerId ? sessionSource : undefined}
            onSessionStart={startPipSession}
            onSessionEnd={endPipSession}
            onRegisterTransportSeek={registerTransportSeek}
        />
    ), [currentVisibleIndex, isFocused, theme, handleLike, handleComment, handleBoost, handleSave, handleShare, globalMuted, handleMuteChange, bottomBarHeight, t, WINDOW_HEIGHT, viewerId, pipOwnerId, sessionSource, startPipSession, endPipSession, registerTransportSeek]);

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

                {/* The reel publishes its own viewability (the snapped slide) to the
                    playback authority. A context provider renders no view, so the
                    slides' layout is untouched. */}
                {posts.length > 0 && (
                    <VideoViewabilityProvider viewableKeys={viewableVideoKeys}>
                        {Platform.OS === 'web' ? (
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
                                        // See the native path: the session's owner keeps its player.
                                        isNear={Math.abs(index - currentVisibleIndex) <= ACTIVE_WINDOW_RADIUS || item.id === pipOwnerId}
                                        screenFocused={isFocused}
                                        theme={theme}
                                        onLike={handleLike}
                                        onComment={handleComment}
                                        onBoost={handleBoost}
                                        onSave={handleSave}
                                        onShare={handleShare}
                                        formatCompactNumber={formatCompactNumber}
                                        muted={globalMuted}
                                        onMutedChange={handleMuteChange}
                                        bottomBarHeight={bottomBarHeight}
                                        t={t}
                                        windowHeight={WINDOW_HEIGHT}
                                        viewerId={viewerId}
                                        ownsSession={item.id === pipOwnerId}
                                        sessionActive={pipOwnerId !== null}
                                        sessionSource={item.id === pipOwnerId ? sessionSource : undefined}
                                        onSessionStart={startPipSession}
                                        onSessionEnd={endPipSession}
                                        onRegisterTransportSeek={registerTransportSeek}
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
                        )}
                    </VideoViewabilityProvider>
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
    pipButton: ViewStyle;
    overlayButtonInner: ViewStyle;
    overlay: ViewStyle;
    gradientOverlay: ViewStyle;
    rightActions: ViewStyle;
    actionButton: ViewStyle;
    actionIcon: TextStyle;
    actionCount: TextStyle;
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
        // `bottom` is supplied at the use site — it tracks the BottomBar's height.
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
        top: OVERLAY_BUTTON_TOP,
        right: OVERLAY_BUTTON_RIGHT,
        zIndex: 10,
    },
    pipButton: {
        position: 'absolute',
        // Stacked directly under the mute button, same column.
        top: OVERLAY_BUTTON_TOP + OVERLAY_BUTTON_SIZE + OVERLAY_BUTTON_GAP,
        right: OVERLAY_BUTTON_RIGHT,
        zIndex: 10,
    },
    overlayButtonInner: {
        width: OVERLAY_BUTTON_SIZE,
        height: OVERLAY_BUTTON_SIZE,
        borderRadius: OVERLAY_BUTTON_SIZE / 2,
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
        gap: 16,
        zIndex: 6,
        paddingRight: 8,
    },
    actionButton: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        minWidth: 36,
    },
    actionIcon: {
        ...TEXT_SHADOW_STRONG,
    },
    actionCount: {
        color: '#FFFFFF',
        fontSize: 11,
        fontWeight: '600',
        ...TEXT_SHADOW_MEDIUM,
        marginTop: 0,
        textAlign: 'center',
    },
    bottomInfo: {
        flex: 1,
        justifyContent: 'flex-end',
        // Gutter between the caption and the rail. Unaffected by the rail's
        // compaction: a 36px button plus 8px of padding is the same 44px box the
        // old 40 + 4 made, so the clearance is exactly what it was.
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
