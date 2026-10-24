import { VideoSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useRoute } from 'expo-router';
import { useCallback, useContext, useEffect, useRef, useState, useMemo, memo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  Pressable,
  FlatList,
  Platform,
  Share,
  type TextStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { toast } from '@oxy.so/bloom/toast';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useTheme } from '@oxy.so/bloom/theme';
import { IconButton } from '@oxy.so/bloom/button';
import { Screen, ScreenPager, type ScreenPagerHandle } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { useOptionalPanelRouter } from '@oxy.so/bloom/panel-routing';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { RiHeartFill } from '@oxy.so/bloom/icons/RiHeartFill';
import { RiPlayFill } from '@oxy.so/bloom/icons/RiPlayFill';
import { RiVideoLine } from '@oxy.so/bloom/icons/RiVideoLine';
import { RiSendPlaneLine } from '@oxy.so/bloom/icons/RiSendPlaneLine';
import { useTranslation } from 'react-i18next';
import { useAuth, FollowButton } from '@oxy.so/services/ui/client';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@/components/common/Ionicons';
import { VerifiedIcon } from '@/assets/icons/verified-icon';
import { useRouter, useLocalSearchParams, useIsFocused } from '@/lib/navigation/router';
import { useScreenReselect, useTabSelect } from '@/context/ScreenReselectContext';
import { usePostsStore } from '@/stores/postsStore';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import { feedService } from '@/services/feedService';
import { proxyExternalUrl, videoPosterUrl } from '@/utils/imageUrlCache';
import { SpinnerIcon } from '@oxy.so/bloom/loading';
import { Avatar } from '@oxy.so/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { SEO } from '@/components/SEO';
import { EmptyState } from '@/components/common/EmptyState';
import { HeartIcon, HeartIconActive } from '@/assets/icons/heart-icon';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { BoostIcon, BoostIconActive } from '@/assets/icons/boost-icon';
import { Bookmark, BookmarkActive } from '@/assets/icons/bookmark-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { formatCompactNumber } from '@/utils/formatNumber';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { profileHrefForUser } from '@/components/Profile/profileRoute';
import { videoSourceFor } from '@/utils/videoSource';
import type { HydratedPost } from '@mention/shared-types';
import { readMediaDurationSec, readMediaPixelSize, type MediaPixelSize } from '@/utils/mediaTypes';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { useIsRightBarVisible } from '@/hooks/useOptimizedMediaQuery';
import { useVideosRail, type VideosRailActivePost } from '@/context/VideosRailContext';
import { VideoViewabilityProvider } from '@/context/VideoPlaybackContext';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { LazyVideoReplies } from '@/components/videos/LazyVideoReplies';
import { useVideoPipSession } from '@/hooks/useVideoPipSession';
import { useReelImpressions } from '@/hooks/useReelImpressions';
import { useMediaSessionTransport, type MediaSessionTrack } from '@/hooks/useMediaSessionTransport';
import { usePipTransportActions } from '@/hooks/usePipTransportActions';
import {
  useReelChrome,
  REEL_TIME_UPDATE_INTERVAL_S,
  type PlayableSource,
  type ReelChromeParams,
  type RegisterTransportSeek,
} from '@/hooks/useReelChrome';
import {
  MediaFlightHost,
  hasFlight,
  releaseFlight,
  useMediaFlight,
  type MediaFlightHostProps,
} from '@oxy.so/bloom/media-flight';
import { needsJsHlsDecoder } from '@/lib/hlsPlayback';
import { PlaybackVideoView } from '@/components/common/PlaybackVideoView';
import {
  useVideoPlayerLease,
  releaseTransitionHold,
  pendingVideoTransition,
  videoPlayerKey,
  type VideoPlayerKey,
} from '@/stores/videoPlayerRegistry';
import { useVideoFeed, type VideoFeedTab } from '@/hooks/useVideoFeed';
import { resolveFeedDescriptor } from '@/utils/feedTelemetry';
import { postPermalink } from '@/utils/postPermalink';
import { usePostInteractions } from '@/components/Feed/postInteractions';

// ── Tuning constants ─────────────────────────────────────────────
// One-screen vertical pager: keep the live-player window tight so only the
// active video and its neighbours hold a decoder.
const FEED_PAGE_LIMIT = 20;
// Players are live only for the active index ± this radius.
// Widened from 1: at radius 2, the video two swipes away already has a live
// player mounted (buffering, muted, never playing — see the shouldPlay gate
// below) instead of only a static poster, so its stream has strictly more
// lead time to buffer before the viewer reaches it. Together with
// RETAINED_BEHIND_RADIUS that is at most six mounted players (-3..+2), and only
// while the reel is the focused screen — see `isSlideNear`.
const ACTIVE_WINDOW_RADIUS = 2;
/**
 * How far BEHIND the reader a slide keeps its player, as opposed to how far
 * ahead ({@link ACTIVE_WINDOW_RADIUS}).
 *
 * The window used to be symmetric, and the two directions are not symmetric at
 * all. Ahead is a GUESS — the reader may never reach that slide — and its only
 * job is buffering lead time. Behind is a MEMORY: the reader has already watched
 * it, and coming back is a deliberate act, so the video is expected to be there,
 * where it was, instantly.
 *
 * A symmetric window could not deliver that. Leaving the window destroys the
 * surface, and destroying the surface destroys the decoder AND the position, so
 * a reader who swiped forward past the radius and then came back was served a
 * rebuild: black, buffer, restart from zero. Measured on a Pixel 10 Pro — two
 * swipes forward and one back remounted two surfaces that had been torn down
 * seconds earlier. Reported as "vuelvo al video anterior y lo vuelve a cargar y
 * tarda".
 *
 * One extra slide behind covers the ordinary correction (a swipe that overshot,
 * a second look) for the cost of one decoder. It is deliberately NOT large: each
 * retained slide holds a hardware decoder, and Android runs out of them silently
 * — later videos simply refuse to load. The complete answer is to retain the
 * PLAYER without its surface, through `stores/videoPlayerRegistry`, which is
 * built for exactly this and already serves the feed-to-reel flight; that is a
 * bigger change than this one and this is not a substitute for it.
 */
const RETAINED_BEHIND_RADIUS = ACTIVE_WINDOW_RADIUS + 1;

/**
 * Whether a slide is close enough to the reader to hold a decoder.
 *
 * ONE function because there are two lists — the native `FlatList` and the web
 * document-scroll map — and they must not drift. They already had: the rule was
 * written out at both call sites, so a change to one silently left the other
 * symmetric.
 *
 * `isPipOwner` is not a distance at all. A slide whose Picture-in-Picture window
 * is open keeps its player however far the reader has scrolled, because dropping
 * out of the window would release the very player that window is showing — so it
 * is OR'd outside the distance test, not folded into it.
 */
function isSlideNear(
  index: number,
  activeIndex: number,
  aheadRadius: number,
  isPipOwner: boolean,
  screenFocused: boolean,
): boolean {
  if (isPipOwner) return true;
  // A reel the reader has left (another tab, a pushed profile) keeps the one
  // slide it will come back to and gives every other decoder back: the tabs
  // stay mounted side by side, and the home feed's own players would otherwise
  // compete with up to five paused neighbours for Android's hardware decoders.
  if (!screenFocused) return index === activeIndex;
  return index <= activeIndex
    ? activeIndex - index <= RETAINED_BEHIND_RADIUS
    : index - activeIndex <= aheadRadius;
}

/**
 * How much media the landed video must have ahead of the playhead before the
 * neighbouring players are allowed to exist.
 *
 * Five live decoders fetch at once, and on a cold connection they take the
 * bandwidth from the video the viewer is actually watching: measured over eight
 * cold pairs, the handover froze for a median of 457ms with the neighbours
 * mounted and 8ms without, and above 150ms in four runs of eight against one.
 * The picture stops while `paused` stays false — starved, not paused.
 *
 * The number comes from both populations rather than from the broken one. In the
 * runs that starved, the landed video had 3.0-3.9s ahead of it; in the runs that
 * did not, 8.5-45s. Six sits between them with room either side. Its limit,
 * because it is real: those readings were taken after landing rather than at the
 * instant the neighbours would start, so this is a threshold that separates the
 * two populations, not one derived from the moment of decision.
 */
const PRELOAD_BUFFER_SECONDS = 6;
// Poster images are tiny (the `thumb` variant, already cached memory-disk) —
// prefetch a wider window than the live-player radius so the very first frame
// the viewer sees on a fast multi-swipe is already in cache, even before that
// row's video decoder starts buffering.
const POSTER_PREFETCH_RADIUS = ACTIVE_WINDOW_RADIUS + 2;
// FlatList must keep the window rows mounted (poster) so they can promote to a
// live player without a remount; WINDOW_SIZE is in screens (one screen = one row).
//
// The floor is the LARGER of the two radii, on both sides: FlatList's window is
// symmetric, so covering only `ACTIVE_WINDOW_RADIUS` leaves the extra retained
// slide BEHIND the reader outside the list. That is what shipped — 5 screens
// (1 + 2 above + 2 below) against a behind-radius of 3 — and it made the third
// slide back a full remount: black, buffer, restart, while the same distance
// forward was already mounted. Reported from the device as scrolling up being
// slower than scrolling down. `isSlideNear` promising a player for a row the
// list never renders cannot produce one.
const FLATLIST_CONFIG = {
  INITIAL_NUM_TO_RENDER: 2,
  MAX_TO_RENDER_PER_BATCH: 2,
  // 1 visible + 3 above + 3 below = 7 rows, covering RETAINED_BEHIND_RADIUS=3
  // (the larger radius) on the side FlatList makes symmetric.
  WINDOW_SIZE: 7,
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

// Web pager dimensions and snap ownership come from Bloom's Screen region.
const WEB_RENDER_RADIUS = 6;

const GRADIENT_COLORS = [
  'transparent',
  'rgba(0, 0, 0, 0.3)',
  'rgba(0, 0, 0, 0.8)',
  '#000000',
] as const;
const GRADIENT_LOCATIONS = [0, 0.4, 0.7, 1] as const;
const LIKE_ACTIVE_COLOR = '#FF3040';
const BOOST_ACTIVE_COLOR = '#10B981';

// Caption is collapsed to two lines until this length, where a "more" toggle is
// offered (TikTok-style expandable caption).
const CAPTION_EXPAND_MIN_CHARS = 80;

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
  mediaIndex: number;
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
  item: VideoPost;
  index: number | null | undefined;
  isViewable: boolean;
}

interface VideoItemProps {
  item: VideoPost;
  isActive: boolean;
  isNear: boolean;
  /** Reported by the active slide; the screen decides when neighbours may mount. */
  onBufferAhead?: (seconds: number) => void;
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
  onSendInAllo: (postId: string) => void;
  formatCompactNumber: (count: number) => string;
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  bottomBarHeight: number;
  t: (key: string) => string;
  windowHeight: number;
  bottomSheetProgress?: SharedValue<number>;
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
/**
 * The frame a slide shows until its video paints, and the only place in the reel
 * that draws one.
 *
 * It is rendered from BOTH sides of the live-player window — by the slide when
 * the row holds no decoder, and by the surface until the first frame lands — and
 * that is exactly why it has to be one component with one set of props. It used
 * to be two copies, and they had drifted: the in-window copy carried
 * `transition={150}`, so crossing into the window unmounted a poster that was
 * already painted and faded its replacement in from nothing over 150ms against
 * the muted background. The image is the same URL out of the same memory cache,
 * so the fade had nothing to reveal — it was a flash on every row, every scroll.
 *
 * NO `transition` here, deliberately: a cache-warm poster must paint on the
 * frame it mounts, because the mount happens mid-scroll and the thing it is
 * replacing was showing the same pixels.
 */
const ReelPoster = memo<{
  posterUrl?: string;
  posterFailed: boolean;
  onPosterError: () => void;
  theme: ReturnType<typeof useTheme>;
}>(({ posterUrl, posterFailed, onPosterError, theme }) => (
  <View style={styles.posterLayer} className="bg-muted" pointerEvents="none">
    {posterUrl && !posterFailed ? (
      <Image
        source={{ uri: posterUrl }}
        style={styles.poster}
        contentFit="contain"
        cachePolicy="memory-disk"
        priority="high"
        onError={onPosterError}
      />
    ) : (
      <RiVideoLine size="3xl" fill={theme.colors.textSecondary} />
    )}
  </View>
));

ReelPoster.displayName = 'ReelPoster';

interface ActiveVideoSurfaceProps extends Omit<ReelChromeParams, 'player' | 'restartOnActivate'> {
  // How much of the surface's bottom edge the floating BottomBar covers. The
  // scrubber is the overlay's SIBLING, so it does not inherit the overlay's
  // own bottom padding and has to lift itself clear of the bar.
  bottomBarHeight: number;
  theme: ReturnType<typeof useTheme>;
  /**
   * The poster's failure flag and its reporter, OWNED BY THE ROW.
   *
   * A surface lives only while its row is inside the live-player window; the
   * row outlives it and draws the same poster on the other side. Holding
   * "this poster 404s" in the surface meant the answer was thrown away and
   * re-learned every time the reader scrolled the row back in — and it was
   * held twice, once here and once in the row, so the two copies could
   * disagree about the same image.
   */
  posterFailed: boolean;
  onPosterError: () => void;
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
/**
 * The slot's own props. `MediaVideoSlotProps` is not exported from
 * `@oxy.so/bloom/media-flight`, so it is derived from the prop that takes it —
 * which is exported, and which stays right if the slot's shape ever changes.
 */
type FlightVideoSlotProps = Parameters<NonNullable<MediaFlightHostProps['renderVideo']>>[0];

const reelHostId = (postId: string): string => `reel:${postId}`;

const ReelSurface: React.FC<
  ActiveVideoSurfaceProps & {
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
  }
> = ({
  player,
  flightId,
  restartOnActivate,
  onFirstFrameRender,
  postId,
  videoUrl,
  fallbackVideoUrl,
  posterUrl,
  posterFailed,
  onPosterError,
  initialDurationSec,
  intrinsicSize,
  isActive,
  onBufferAhead,
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
    videoViewRef,
    desiredSource,
    targetFallbackUrl,
    handleSourceError,
    isWatched,
    handlePictureInPictureStart,
    handlePictureInPictureStop,
    showPoster,
    handleSurfacePress,
    userPaused,
    heartStyle,
    showPauseAffordance,
    showBufferSpinner,
    showScrubber,
    onTrackLayout,
    panResponder,
    isScrubbing,
    progressStyle,
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
    onBufferAhead,
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

  // `style` is SPREAD: a `<video>` is a replaced element and paints at 300x150
  // without a size. `player` passes through untouched including `null`, which
  // is how expo-video empties a source silently.
  const renderReelVideo = useCallback(
    ({ player: slotPlayer, style: slotStyle, contentFit: slotFit }: FlightVideoSlotProps) => (
      <PlaybackVideoView
        ref={videoViewRef}
        registryKey={flightId}
        source={desiredSource}
        fallbackSource={targetFallbackUrl}
        onSourceError={handleSourceError}
        detached={slotPlayer === null}
        // `null` is forwarded verbatim — it is the instruction to unbind
        // this element, and expo-video answers it by emptying the source
        // without an event, which is what stops an outgoing surface
        // pausing the one that just landed. Anything else is OUR player:
        // Bloom never makes one, it hands back what it was given, and
        // that is the object this component already holds, fully typed.
        // Narrowed rather than cast, because `VideoPlayerLike` is
        // deliberately smaller than expo-video's `VideoPlayer`.
        player={player}
        style={slotStyle}
        contentFit={slotFit}
        nativeControls={false}
        /* ANDROID: a TextureView, not the default SurfaceView.
                   A SurfaceView is its own window punched through the view
                   hierarchy: it does not clip to its React parent and it does
                   not move with the list mid-scroll. With up to five slides
                   mounted at once (ACTIVE_WINDOW_RADIUS = 2) that is visible as
                   several videos painting simultaneously at stale positions —
                   captured on a Pixel 10 Pro during a fling, one frame showing
                   the outgoing video, the incoming one, and a third in a
                   rectangle over the tab bar. That is the "los vídeos parpadean
                   según hago scroll" report.
                   A TextureView composites like any other view, so it clips,
                   scrolls and z-orders correctly. It costs an extra GPU copy per
                   frame, which is the right trade against showing the wrong
                   video. Set here and never changed at runtime, as the prop
                   requires. */
        surfaceType="textureView"
        fullscreenOptions={{ enable: false }}
        allowsPictureInPicture={isWatched}
        startsPictureInPictureAutomatically={isWatched}
        onPictureInPictureStart={handlePictureInPictureStart}
        onPictureInPictureStop={handlePictureInPictureStop}
        onFirstFrameRender={onFirstFrameRender}
      />
    ),
    [
      player,
      flightId,
      videoViewRef,
      desiredSource,
      targetFallbackUrl,
      handleSourceError,
      isWatched,
      handlePictureInPictureStart,
      handlePictureInPictureStop,
      onFirstFrameRender,
    ],
  );

  // One object per player: the host compares `content` by reference.
  const flightContent = useMemo(() => ({ kind: 'video' as const, player }), [player]);

  return (
    <>
      {/* The same shared node the feed row was painting, claimed by id:
                one element that MOVES keeps the decoder, the position and the
                playback across the route change. The element itself is still
                this screen's, built in the slot below — Picture-in-Picture is
                asked of a `VideoView` through its ref, so a host that built its
                own would paint the button and answer nothing. */}
      <MediaFlightHost
        id={flightId ?? reelHostId(postId)}
        content={flightContent}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        renderVideo={renderReelVideo}
        pointerEvents="none"
      />

      {showPoster && (
        <ReelPoster
          posterUrl={posterUrl}
          posterFailed={posterFailed}
          onPosterError={onPosterError}
          theme={theme}
        />
      )}

      {/* Full-surface tap target → toggle play/pause (single tap, deferred)
                or like (double tap). It sits ABOVE the video/poster but BELOW the
                mute button (z 10), scrubber, and the bottom overlay actions, so
                those keep their own taps. */}
      <Pressable
        style={styles.tapLayer}
        onPress={handleSurfacePress}
        accessibilityRole="button"
        accessibilityLabel={t(
          muted ? 'settings.lanes.muted.unmute' : userPaused ? 'videos.play' : 'videos.pause',
        )}
      />

      {/* Double-tap heart pop — large, centered, non-interactive. */}
      <Animated.View style={[styles.heartPop, heartStyle]} pointerEvents="none">
        <RiHeartFill width={96} height={96} fill={LIKE_ACTIVE_COLOR} />
      </Animated.View>

      {showPauseAffordance && (
        <View style={styles.pauseAffordance} pointerEvents="none">
          <View style={styles.pauseAffordanceInner}>
            <RiPlayFill width={44} height={44} fill="white" />
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
            <Animated.View style={[styles.scrubberFill, progressStyle]} />
          </View>
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
  // Memoised on the URL: `useVideoPlayer` REBUILDS its player whenever the
  // source it is handed changes, and a fresh object literal every render is a
  // change every render — which would rebuild the decoder on each commit.
  // A playlist this browser cannot decode goes to hls.js instead, which needs
  // the element to itself: the player is built with no source at all.
  const [source] = useState(() =>
    needsJsHlsDecoder(props.videoUrl) ? null : videoSourceFor(props.videoUrl),
  );
  const player = useVideoPlayer(source, (p: VideoPlayer) => {
    p.loop = true;
    // Drive the scrubber at a smooth-but-cheap cadence.
    p.timeUpdateEventInterval = REEL_TIME_UPDATE_INTERVAL_S;
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
const AdoptedPlayerSurface: React.FC<ActiveVideoSurfaceProps & { flightId: VideoPlayerKey }> = ({
  flightId,
  ...props
}) => {
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

const ActiveVideoSurface = memo<ActiveVideoSurfaceProps & { flightId?: VideoPlayerKey }>(
  (props) => {
    const { flightId, ...rest } = props;
    // Decided ONCE, at mount: "was a flight live for this media when this slide
    // appeared". Read through a lazy initialiser rather than during every render
    // — the answer stops being true the moment the flight is released, and a
    // slide that swapped player identity mid-life would restart the video.
    const [adopted] = useState(() => flightId !== undefined && hasFlight(flightId));
    useEffect(() => {
      if (!adopted && flightId && !hasFlight(flightId)) releaseTransitionHold(flightId);
    }, [adopted, flightId]);
    return adopted && flightId ? (
      <AdoptedPlayerSurface {...rest} flightId={flightId} />
    ) : (
      <OwnPlayerSurface {...rest} />
    );
  },
);

ActiveVideoSurface.displayName = 'ActiveVideoSurface';

// ── Row ──────────────────────────────────────────────────────────
// Always mounted while inside the FlatList window. The decoder-bearing
// ActiveVideoSurface is mounted only when `isNear`; otherwise we render the
// static poster so the row keeps its slot without holding a player.
const VideoItem = memo<VideoItemProps>(
  ({
    item,
    isActive,
    isNear,
    onBufferAhead,
    screenFocused,
    theme,
    onLike,
    onComment,
    onBoost,
    onSave,
    onShare,
    onSendInAllo,
    formatCompactNumber,
    muted,
    onMutedChange,
    bottomBarHeight,
    t,
    windowHeight,
    bottomSheetProgress,
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
    // The poster can 404 (no extractable frame) or fail to load → fall back to
    // the neutral icon rather than a blank. Held HERE, by the row, because the
    // row outlives the surface: it draws the same poster on both sides of the
    // live-player window, and an answer learned on one side is still true on the
    // other. Reset when the row is recycled onto a different poster — the
    // "You Might Not Need an Effect" adjust-during-render form, same as the
    // source reset in `useReelChrome`.
    const [posterFailed, setPosterFailed] = useState(false);
    const [prevPosterUrl, setPrevPosterUrl] = useState(item.posterUrl);
    if (prevPosterUrl !== item.posterUrl) {
      setPrevPosterUrl(item.posterUrl);
      setPosterFailed(false);
    }
    // A load that failed once must not condemn the slide for the whole session.
    // `videoError` unmounts the surface and paints "Video unavailable", the row
    // stays mounted three slides behind the active one, and nothing cleared it —
    // so scrolling up and back down showed the same dead badge over a video that
    // may well play now. Arriving on the slide again is the retry: it remounts
    // the surface with a new player that loads from scratch.
    //
    // On the activation EDGE, not on every render while active: the error
    // handler would otherwise re-raise it and the two would fight. Adjusted
    // during render via a previous-value tracker, like the poster reset above.
    // The fuller story is in `__tests__/reelErrorIsNotPermanent.test.ts`.
    const [prevIsActive, setPrevIsActive] = useState(isActive);
    if (prevIsActive !== isActive) {
      setPrevIsActive(isActive);
      if (isActive && videoError) {
        setVideoError(false);
      }
    }
    // TikTok-style expandable caption: collapsed to two lines until toggled.
    const [captionExpanded, setCaptionExpanded] = useState(false);

    const handleError = useCallback(() => setVideoError(true), []);
    const handlePosterError = useCallback(() => setPosterFailed(true), []);
    const toggleCaption = useCallback(() => setCaptionExpanded((prev) => !prev), []);

    const userName = useMemo(
      () => item.user?.name?.displayName ?? '',
      [item.user?.name?.displayName],
    );
    const userHandle = useMemo(
      () => getNormalizedUserHandle(item.user) || t('common.unknown'),
      [item.user, t],
    );
    const postText = useMemo(() => item.content?.text?.trim() || '', [item.content?.text]);

    const handleProfilePress = useCallback(() => {
      // The author's VIDEOS tab: a reader who tapped a face in the reel came
      // for more of the same, not for a text timeline.
      const href = profileHrefForUser(item.user, 'videos');
      if (href) {
        router.push(href);
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
    const repliesTransformStyle = useAnimatedStyle(() => {
      const progress = bottomSheetProgress?.value ?? 0;
      return {
        transform: [
          { translateY: -(windowHeight * 0.31 * progress) },
          { scale: interpolate(progress, [0, 1], [1, 0.38]) },
        ],
      };
    }, [bottomSheetProgress, windowHeight]);

    return (
      <Animated.View
        className="web:h-full"
        style={[
          styles.videoContainer,
          Platform.OS === 'web' ? null : { height: windowHeight },
          repliesTransformStyle,
        ]}
      >
        {canRenderPlayer ? (
          <ActiveVideoSurface
            key={item.mediaId ?? item.videoUrl}
            flightId={item.mediaId ? videoPlayerKey(item.id, item.mediaId) : undefined}
            postId={item.id}
            videoUrl={item.videoUrl}
            fallbackVideoUrl={item.fallbackVideoUrl}
            posterUrl={item.posterUrl}
            posterFailed={posterFailed}
            onPosterError={handlePosterError}
            initialDurationSec={item.durationSec}
            intrinsicSize={item.intrinsicSize}
            isActive={isActive}
            onBufferAhead={onBufferAhead}
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
          // Outside the live window (or errored): no decoder, just the
          // poster — the SAME element the surface draws on the other side
          // of the window, so crossing it changes nothing on screen.
          <>
            <ReelPoster
              posterUrl={item.posterUrl}
              posterFailed={posterFailed}
              onPosterError={handlePosterError}
              theme={theme}
            />
            {videoError && (
              <View style={styles.posterLayer} pointerEvents="none">
                <Text className="mt-2 text-xs text-muted-foreground">
                  {t('videos.unavailable')}
                </Text>
              </View>
            )}
          </>
        )}

        {/* `box-none`: the overlay container spans the bottom half of the
                surface, but only its interactive leaves (author press, follow,
                caption toggle, action buttons) should capture touches — empty
                regions must fall through to the tap layer below (single-tap pause
                / double-tap like). Without this the overlay (zIndex 5, above the
                zIndex-2 tap layer) would swallow taps on the lower half. */}
        <View
          style={[styles.overlay, { paddingBottom: bottomBarHeight + 20 }]}
          pointerEvents="box-none"
        >
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
                        <VerifiedIcon size={14} style={styles.verifiedIcon} />
                      )}
                    </View>
                    <Text style={styles.userHandle} numberOfLines={1}>
                      @{userHandle}
                    </Text>
                  </View>
                </Pressable>
                {showOnVideoFollow && item.user?.id && (
                  <View style={styles.onVideoFollow}>
                    <FollowButton userId={item.user.id} size="sm" />
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
                <Ionicons
                  name="musical-notes-outline"
                  size={13}
                  color="#FFFFFF"
                  style={styles.soundIcon}
                />
                <Text style={styles.soundText} numberOfLines={1}>
                  {t('videos.original_audio')} · @{userHandle}
                </Text>
              </View>
            </View>
          </View>

          <View style={styles.rightActions} pointerEvents="box-none">
            <ActionButton
              icon={
                item.viewerState.isLiked ? (
                  <HeartIconActive size={30} color={LIKE_ACTIVE_COLOR} />
                ) : (
                  <HeartIcon size={30} color="white" />
                )
              }
              count={item.engagement.likes ?? 0}
              isActive={item.viewerState.isLiked}
              activeColor={LIKE_ACTIVE_COLOR}
              onPress={() => onLike(item.id, item.viewerState.isLiked)}
              formatCompactNumber={formatCompactNumber}
              accessibilityLabel={t(item.viewerState.isLiked ? 'videos.unlike' : 'videos.like')}
            />
            <ActionButton
              icon={<CommentIcon size={30} color="white" />}
              count={item.engagement.replies ?? 0}
              onPress={() => onComment(item.id)}
              formatCompactNumber={formatCompactNumber}
              accessibilityLabel={t('videos.comment')}
            />
            <ActionButton
              icon={
                item.viewerState.isBoosted ? (
                  <BoostIconActive size={30} color={BOOST_ACTIVE_COLOR} />
                ) : (
                  <BoostIcon size={30} color="white" />
                )
              }
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
              icon={
                item.viewerState.isSaved ? (
                  <BookmarkActive size={30} color="white" />
                ) : (
                  <Bookmark size={30} color="white" />
                )
              }
              count={item.engagement.saves ?? 0}
              onPress={() => onSave(item.id, item.viewerState.isSaved)}
              formatCompactNumber={formatCompactNumber}
              accessibilityLabel={t(item.viewerState.isSaved ? 'videos.unsave' : 'videos.save')}
            />
            <ActionButton
              icon={<RiSendPlaneLine width={30} height={30} fill="white" />}
              count={0}
              onPress={() => onSendInAllo(item.id)}
              formatCompactNumber={formatCompactNumber}
              hideCount={true}
              accessibilityLabel={t('videos.sendInAllo')}
            />
            <ActionButton
              icon={<ShareIcon size={30} color="white" />}
              count={0}
              onPress={() => onShare(item)}
              formatCompactNumber={formatCompactNumber}
              hideCount={true}
              accessibilityLabel={t('videos.share')}
            />
          </View>
        </View>
      </Animated.View>
    );
  },
);

VideoItem.displayName = 'VideoItem';

// ── Action button ────────────────────────────────────────────────
interface ActionButtonProps {
  icon: React.ReactNode;
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

const ActionButton = memo<ActionButtonProps>(
  ({
    icon,
    count,
    isActive,
    activeColor,
    onPress,
    formatCompactNumber,
    hideCount = false,
    accessibilityLabel,
  }) => (
    <View className="items-center gap-0.5">
      <IconButton
        appearance="plain"
        size="lg"
        onPress={onPress}
        accessibilityLabel={accessibilityLabel}
        pressed={isActive}
        renderLeadingIcon={() => icon}
      />
      {!hideCount && (
        <Text style={[styles.actionCount, isActive && activeColor ? { color: activeColor } : null]}>
          {formatCompactNumber(count)}
        </Text>
      )}
    </View>
  ),
);

ActionButton.displayName = 'ActionButton';

// ── Screen ───────────────────────────────────────────────────────
export default function VideosScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const haptic = useHaptics();
  const insets = useSafeAreaInsets();
  const [WINDOW_HEIGHT, setViewportHeight] = useState(0);
  const pagerRef = useRef<ScreenPagerHandle>(null);
  const panelRouter = useOptionalPanelRouter();
  const inDeck = Boolean(panelRouter);
  const route = useRoute();
  const isFocused = useIsFocused();
  const params = useLocalSearchParams<{ postId?: string; mediaIndex?: string }>();
  const { oxyServices, user, canUsePrivateApi, isAuthResolved, isAuthenticated } = useAuth();
  const viewerId = user?.id;
  // Per-action selectors: a bare usePostsStore() re-renders the whole reel
  // screen on every unrelated posts-store write.
  const likePost = usePostsStore((s) => s.likePost);
  const unlikePost = usePostsStore((s) => s.unlikePost);
  const boostPost = usePostsStore((s) => s.boostPost);
  const unboostPost = usePostsStore((s) => s.unboostPost);
  const savePost = usePostsStore((s) => s.savePost);
  const unsavePost = usePostsStore((s) => s.unsavePost);
  const getPostById = usePostsStore((s) => s.getPostById);
  const cachePosts = usePostsStore((s) => s.cachePosts);
  // Desktop (>=990) gate. Actions + follow now overlay the video on every
  // breakpoint (matching mobile); `isDesktop` only decides how the comment
  // button behaves — a no-op on desktop (replies are already open in the
  // RightBar) vs. opening the bottom sheet on mobile.
  const rightBarVisible = useIsRightBarVisible();
  const isDesktop = rightBarVisible && !inDeck;
  const { setRailState, requestComposerFocus } = useVideosRail();
  const { openBottomSheet, setBottomSheetContent, setBottomSheetProgress } =
    useContext(BottomSheetContext);
  const bottomSheetProgress = useSharedValue(0);

  useEffect(() => {
    setBottomSheetProgress?.(bottomSheetProgress);
    return () => setBottomSheetProgress?.(undefined);
  }, [bottomSheetProgress, setBottomSheetProgress]);

  const flatListRef = useRef<FlatList<VideoPost>>(null);
  const globalMuted = useVideoMuteStore((state) => state.isMuted);
  const loadMutedState = useVideoMuteStore((state) => state.loadMutedState);

  // The raw/original URL — always playable, used as `fallbackVideoUrl`.
  // Unchanged from before this HLS work; every existing resolution path
  // (server `url`, http passthrough via proxy, legacy client-side Oxy
  // resolution) is preserved exactly.
  const resolveFallbackVideoUrl = useCallback(
    (ref: MediaRef): string => {
      if (ref?.url) return ref.url;
      const raw = ref?.id || '';
      if (!raw) return '';
      if (raw.startsWith('http')) return proxyExternalUrl(raw);
      return oxyServices ? oxyServices.assets.publicUrl(raw) : '';
    },
    [oxyServices],
  );

  // Preferred playback URL: the adaptive HLS stream when the server resolved
  // one (federated media never has `hlsUrl`), else the same raw/original URL
  // `resolveFallbackVideoUrl` would return.
  //
  // On every platform. The ladder is Oxy's H.264 transcode, and the original
  // is whatever was uploaded — an Instagram reel arrives as VP9, which an
  // iPhone cannot decode, so the slide showed its poster and never played.
  // Web reaches the ladder the way it reaches a federated playlist:
  // `isHlsSource` recognises `?variant=hls_master`, so a browser without a
  // native HLS decoder hands it to hls.js (`useHlsPlayback`), and a failed
  // stream falls back to the original there as `useReelChrome` does on native.
  const resolveVideoUrl = useCallback(
    (ref: MediaRef): string => {
      if (ref?.hlsUrl) return ref.hlsUrl;
      return resolveFallbackVideoUrl(ref);
    },
    [resolveFallbackVideoUrl],
  );

  // Resolve a static poster. Prefer the server-resolved final `posterUrl`
  // (fallback `thumbUrl`); fall back to the legacy client resolver from the RAW
  // media id/url when absent. Returns undefined when nothing sensible → neutral
  // placeholder. The poster URL may 404 → the Image layer's own error handling
  // falls back to the placeholder, so this never yields a broken image.
  const resolvePosterUrl = useCallback(
    (ref: MediaRef): string | undefined => {
      if (ref?.posterUrl) return ref.posterUrl;
      if (ref?.thumbUrl) return ref.thumbUrl;
      const raw = ref?.id || ref?.url || '';
      return videoPosterUrl(raw, oxyServices);
    },
    [oxyServices],
  );

  // Build a VideoPost from a canonical hydrated post, selecting the requested
  // video. Posts that merely CONTAIN a video qualify (multi-video, or a video
  // among images).
  const toVideoPost = useCallback(
    (post: HydratedPost, preferredMediaIndex?: number): VideoPost | null => {
      const media: MediaRef[] = post.content.media ?? post.attachments.media ?? [];
      if (media.length === 0) return null;

      let selected: MediaRef | undefined;
      if (preferredMediaIndex !== undefined) {
        if (media[preferredMediaIndex]?.type !== 'video') return null;
        selected = media[preferredMediaIndex];
      } else {
        selected =
          media.find((m) => m?.type === 'video' && m?.orientation === 'portrait') ??
          media.find((m) => m?.type === 'video');
      }
      if (!selected) return null;

      const videoUrl = resolveVideoUrl(selected);
      if (!videoUrl) return null;
      const rawFallback = resolveFallbackVideoUrl(selected);
      const fallbackVideoUrl = rawFallback && rawFallback !== videoUrl ? rawFallback : undefined;

      return {
        ...post,
        mediaIndex: media.indexOf(selected),
        createdAt: post.metadata.createdAt,
        videoUrl,
        fallbackVideoUrl,
        posterUrl: resolvePosterUrl(selected),
        durationSec: readMediaDurationSec(selected),
        intrinsicSize: readMediaPixelSize(selected),
        mediaId: selected.id ? String(selected.id) : undefined,
      };
    },
    [resolveVideoUrl, resolveFallbackVideoUrl, resolvePosterUrl],
  );

  const filterVideoPosts = useCallback(
    (allPosts: HydratedPost[]): VideoPost[] => {
      const out: VideoPost[] = [];
      for (const post of allPosts) {
        const vp = toVideoPost(post);
        if (vp) out.push(vp);
      }
      return out;
    },
    [toVideoPost],
  );

  const scrollReelToTop = useCallback(() => {
    if (Platform.OS === 'web') pagerRef.current?.scrollToIndex(0, { animated: false });
    else flatListRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);
  const parsedMediaIndex = Number(params.mediaIndex);
  const routeTarget = params.postId
    ? {
        postId: params.postId,
        mediaIndex:
          Number.isInteger(parsedMediaIndex) && parsedMediaIndex >= 0
            ? parsedMediaIndex
            : undefined,
      }
    : null;
  const {
    posts,
    sessionId,
    setPosts,
    isLoading,
    hasLoadError,
    hasMore,
    loadingMore,
    currentVisibleIndex,
    selectIndex: setCurrentVisibleIndex,
    selectPost,
    activeFeed,
    selectFeed: setActiveFeed,
    target,
    refresh: handleRetry,
    loadMore: handleLoadMore,
  } = useVideoFeed<VideoPost>({
    target: routeTarget,
    focused: isFocused,
    navigationEntry: panelRouter?.key ?? route.params,
    viewerId,
    signedOut: isAuthResolved && !isAuthenticated,
    readTarget: async (requested) => {
      const post = await getPostById(requested.postId);
      if (!post) return null;
      const media = post.content.media ?? post.attachments.media ?? [];
      const mediaIndex = requested.mediaId
        ? media.findIndex((item) => item.id === requested.mediaId)
        : requested.mediaIndex;
      return toVideoPost(post, mediaIndex);
    },
    readPage: async (type, cursor) => {
      const response = await feedService.getFeed({ type, cursor, limit: FEED_PAGE_LIMIT });
      return { ...response, items: filterVideoPosts(response.items ?? []) };
    },
    cachePosts,
    resetScroll: scrollReelToTop,
  });
  const targetPostId = target?.postId;
  const targetMediaIndex = target?.mediaIndex;
  useScreenReselect({
    isAtTop: () => currentVisibleIndex === 0,
    scrollToTop: scrollReelToTop,
    refresh: handleRetry,
  });

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
  useEffect(() => {
    if (!isFocused || !targetPostId) return;
    const pending = pendingVideoTransition(targetPostId);
    if (!pending) return;
    const cancel = () => {
      if (Platform.OS !== 'web' && hasFlight(pending.key)) return;
      if (pending.release()) releaseFlight(pending.key);
    };
    if (hasLoadError) cancel();
    return cancel;
  }, [isFocused, targetPostId, targetMediaIndex, hasLoadError]);

  // The neighbours wait until the video the viewer is watching has runway.
  // Re-armed on every slide, because each landing starts a fresh fetch and is
  // exactly as starvable as the first.
  // Held against the INDEX rather than as a flag, so it re-arms by itself when
  // the viewer swipes — no effect, and no way to leave it armed for a slide
  // that has not buffered anything yet.
  const [armedIndex, setArmedIndex] = useState<number | null>(null);
  // Read through a ref so the callback keeps ONE identity for the screen's
  // life: it is a prop of every mounted slide, and a new function per swipe
  // broke `VideoItem`'s memo for all of them at once.
  const currentVisibleIndexRef = useRef(currentVisibleIndex);
  const armedIndexRef = useRef(armedIndex);
  useEffect(() => {
    currentVisibleIndexRef.current = currentVisibleIndex;
    armedIndexRef.current = armedIndex;
  }, [currentVisibleIndex, armedIndex]);
  const handleBufferAhead = useCallback((seconds: number) => {
    const index = currentVisibleIndexRef.current;
    if (armedIndexRef.current === index || seconds < PRELOAD_BUFFER_SECONDS) return;
    armedIndexRef.current = index;
    setArmedIndex(index);
  }, []);
  const activeRadius = armedIndex === currentVisibleIndex ? ACTIVE_WINDOW_RADIUS : 0;

  // The Screen's available region already excludes app navigation.
  const bottomBarHeight = 0;

  // Native reports the actual item, so an old index cannot select a new post.
  const handleViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewableItem[] }) => {
      // AN EMPTY SET MEANS "BETWEEN SLIDES", NOT "NOTHING TO SHOW", and the
      // difference is the whole of this handler.
      //
      // Slides are full-screen and `itemVisiblePercentThreshold` is 60, so a
      // fast swipe passes through a moment where NEITHER the outgoing slide
      // nor the incoming one covers 60% of the viewport. This used to answer
      // that moment with `-1`, and `-1` is not a position the reel can hold:
      // the live-player window is `|index - currentVisibleIndex| <= 2`, so
      // every surface fell out of it at once. Measured on a Pixel 10 Pro, one
      // swipe cost 13 surface lifecycle events — four decoders destroyed, two
      // built, those two destroyed 140ms later, then five built — and three of
      // them were the very surfaces torn down at the start of the same swipe.
      // Each rebuild re-shows a poster and re-decodes a first frame, which is
      // what the reel looked like from the outside: video flickering on every
      // scroll.
      //
      // So an empty set changes nothing. The reader is still between the two
      // slides the window already covers, and the next non-empty report says
      // where they landed.
      const next = viewableItems?.find((item) => item.isViewable)?.item;
      if (next) selectPost(next);
    },
    [selectPost],
  );

  // Scroll the reel to a clamped target index. Powers the rail arrows + the
  // web keyboard ↑/↓ shortcuts. Web scrolls the document; native scrolls the
  // FlatList by the slide height. `animated` is off for the jump back from a
  // PiP session, which can span dozens of slides the viewer never scrolled.
  const goToIndex = useCallback(
    (targetIndex: number, animated = true) => {
      const clamped = Math.min(Math.max(targetIndex, 0), posts.length - 1);
      if (clamped < 0) return;
      if (Platform.OS === 'web') {
        pagerRef.current?.scrollToIndex(clamped, { animated });
      } else {
        flatListRef.current?.scrollToOffset({ offset: clamped * WINDOW_HEIGHT, animated });
      }
    },
    [posts.length, WINDOW_HEIGHT],
  );

  const prev = useCallback(
    () => goToIndex(currentVisibleIndex - 1),
    [goToIndex, currentVisibleIndex],
  );
  const next = useCallback(
    () => goToIndex(currentVisibleIndex + 1),
    [goToIndex, currentVisibleIndex],
  );

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
  useEffect(() => {
    postsLengthRef.current = posts.length;
  }, [posts.length]);

  const handleSessionEnded = useCallback(
    (index: number) => {
      if (index >= postsLengthRef.current) return;
      setCurrentVisibleIndex(index);
      goToIndex(index, false);
    },
    [goToIndex, setCurrentVisibleIndex],
  );

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
    () =>
      pipPlaying
        ? { url: pipPlaying.videoUrl, fallbackUrl: pipPlaying.fallbackVideoUrl }
        : undefined,
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

  const handleSelectFeed = useTabSelect(activeFeed, setActiveFeed);

  // Web: ↑/↓ arrow keys page the reel. Ignored while typing into an input /
  // textarea / contenteditable so the composer and search are unaffected.
  // External-system (window) listener with a cleanup — the legitimate effect case.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined' || !isFocused || inDeck) return;
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
  }, [prev, next, isFocused, inDeck]);

  const handleLike = useCallback(
    async (postId: string, isLiked: boolean) => {
      haptic('light');
      try {
        if (isLiked) {
          await unlikePost({ postId, type: 'post' });
        } else {
          // Surface attribution (the active Reels tab) returns when the affinity hooks land.
          await likePost({ postId, type: 'post' });
        }
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? {
                  ...p,
                  viewerState: { ...p.viewerState, isLiked: !isLiked },
                  engagement: {
                    ...p.engagement,
                    likes: Math.max(0, (p.engagement.likes ?? 0) + (isLiked ? -1 : 1)),
                  },
                }
              : p,
          ),
        );
      } catch {
        toast(t('common.error'), { type: 'error' });
      }
    },
    [haptic, likePost, unlikePost, t, setPosts],
  );

  const handleCommentPosted = useCallback(
    (postId: string) => {
      setPosts((prev) =>
        prev.map((p) =>
          p.id === postId
            ? {
                ...p,
                engagement: {
                  ...p.engagement,
                  replies: (p.engagement.replies ?? 0) + 1,
                },
              }
            : p,
        ),
      );
    },
    [setPosts],
  );

  const handleComment = useCallback(
    (postId: string) => {
      if (isDesktop) {
        // The replies column (RightBar) is already showing this post, so
        // there is nothing to open — but a button that paints and then does
        // nothing observable is a dead button. Put the caret in that
        // column's composer instead, which is what the press was asking for.
        requestComposerFocus();
        return;
      }
      setBottomSheetContent(
        <LazyVideoReplies
          postId={postId}
          onClose={() => openBottomSheet(false)}
          onCommentPosted={() => handleCommentPosted(postId)}
        />,
        { scrollable: false, presentation: 'videoReplies' },
      );
      openBottomSheet(true);
    },
    [isDesktop, requestComposerFocus, setBottomSheetContent, openBottomSheet, handleCommentPosted],
  );

  const handleBoost = useCallback(
    async (postId: string, isBoosted: boolean) => {
      haptic('light');
      try {
        if (isBoosted) {
          await unboostPost({ postId });
        } else {
          // Surface attribution (the active Reels tab) returns when the affinity hooks land.
          await boostPost({ postId });
        }
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? {
                  ...p,
                  viewerState: { ...p.viewerState, isBoosted: !isBoosted },
                  engagement: {
                    ...p.engagement,
                    boosts: Math.max(0, (p.engagement.boosts ?? 0) + (isBoosted ? -1 : 1)),
                  },
                }
              : p,
          ),
        );
      } catch {
        toast(t('common.error'), { type: 'error' });
      }
    },
    [haptic, boostPost, unboostPost, t, setPosts],
  );

  // Same optimistic shape as like/boost: the store's own update lands on its
  // copy of the post, which this screen's local `posts` state never reads, so
  // the rail's icon only flips if the screen updates itself.
  const handleSave = useCallback(
    async (postId: string, isSaved: boolean) => {
      haptic('light');
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
        setPosts((prev) =>
          prev.map((p) =>
            p.id === postId
              ? {
                  ...p,
                  viewerState: { ...p.viewerState, isSaved: !isSaved },
                  engagement: {
                    ...p.engagement,
                    saves: Math.max(0, (p.engagement.saves ?? 0) + (isSaved ? -1 : 1)),
                  },
                }
              : p,
          ),
        );
      } catch {
        toast(t('common.error'), { type: 'error' });
      }
    },
    [haptic, savePost, unsavePost, t, setPosts],
  );

  // Mention has no chat; sending a reel to someone happens in Allo.
  const interactions = usePostInteractions();

  const handleShare = useCallback(
    async (post: VideoPost) => {
      try {
        const postUrl = postPermalink(post.id);
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
          await Share.share({
            message: `${shareMessage}\n\n${postUrl}`,
            url: postUrl,
            title: shareTitle,
          });
        }
      } catch (error) {
        const err = error as { message?: string; code?: string };
        if (err?.message !== 'User did not share' && err?.code !== 'ERR_SHARE_CANCELLED') {
          toast(t('videos.share_failed'), { type: 'error' });
        }
      }
    },
    [t],
  );

  const handleMuteChange = useCallback((muted: boolean) => {
    useVideoMuteStore.getState().setMuted(muted);
  }, []);

  useEffect(() => {
    loadMutedState();
  }, [loadMutedState]);

  // ── Desktop replies-panel coordination ──────────────────────────
  // The RightBar replies panel is a read-only projection of this screen's
  // active post. Writing this derived state to an external store is a
  // legitimate effect. `active` flips true on mount and false on unmount so the
  // panel mounts/unmounts in lockstep with /videos.
  useEffect(() => {
    if (inDeck || !isFocused) return;
    setRailState({ active: true });
    return () => {
      setRailState({ active: false, activePost: null });
    };
  }, [setRailState, inDeck, isFocused]);

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
    viewerId,
    canReportImpressions: canUsePrivateApi,
  });

  // Publish the active post + the comment-posted callback so the RightBar
  // replies panel tracks whichever video is currently active and can bump the
  // comment count after a reply posts. Engagement itself lives on the on-video
  // action buttons (both platforms), so nothing else needs to cross over.
  useEffect(() => {
    if (inDeck || !isFocused) return;
    setRailState({ activePost: railActivePost, onCommentPosted: handleCommentPosted });
  }, [setRailState, railActivePost, handleCommentPosted, inDeck, isFocused]);

  const renderVideoItem = useCallback(
    ({ item, index }: { item: VideoPost; index: number }) => (
      <VideoItem
        item={item}
        isActive={index === currentVisibleIndex}
        // The session's owner keeps its player for as long as the OS window
        // is open, however far the pager has been scrolled from it: dropping
        // out of the live window would release the very player the window is
        // showing.
        isNear={isSlideNear(
          index,
          currentVisibleIndex,
          activeRadius,
          item.id === pipOwnerId,
          isFocused,
        )}
        onBufferAhead={handleBufferAhead}
        screenFocused={isFocused}
        theme={theme}
        onLike={handleLike}
        onComment={handleComment}
        onBoost={handleBoost}
        onSave={handleSave}
        onShare={handleShare}
        onSendInAllo={interactions.sendInAllo}
        formatCompactNumber={formatCompactNumber}
        muted={globalMuted}
        onMutedChange={handleMuteChange}
        bottomBarHeight={bottomBarHeight}
        t={t}
        windowHeight={WINDOW_HEIGHT}
        bottomSheetProgress={bottomSheetProgress}
        viewerId={viewerId}
        ownsSession={item.id === pipOwnerId}
        sessionActive={pipOwnerId !== null}
        sessionSource={item.id === pipOwnerId ? sessionSource : undefined}
        onSessionStart={startPipSession}
        onSessionEnd={endPipSession}
        onRegisterTransportSeek={registerTransportSeek}
      />
    ),
    [
      currentVisibleIndex,
      activeRadius,
      handleBufferAhead,
      isFocused,
      theme,
      handleLike,
      handleComment,
      handleBoost,
      handleSave,
      handleShare,
      interactions.sendInAllo,
      globalMuted,
      handleMuteChange,
      bottomBarHeight,
      t,
      WINDOW_HEIGHT,
      bottomSheetProgress,
      viewerId,
      pipOwnerId,
      sessionSource,
      startPipSession,
      endPipSession,
      registerTransportSeek,
    ],
  );

  const keyExtractor = useCallback((item: VideoPost) => item.id, []);

  const getItemLayout = useCallback(
    (_: ArrayLike<VideoPost> | null | undefined, index: number) => ({
      length: WINDOW_HEIGHT,
      offset: WINDOW_HEIGHT * index,
      index,
    }),
    [WINDOW_HEIGHT],
  );

  return (
    <>
      <SEO title={t('seo.videos.title')} description={t('seo.videos.description')} />
      <Screen
        scroll="auto"
        active={isFocused}
        headerPlacement="overlay"
        contentClearance={0}
        testID="videos-screen"
        style={{ backgroundColor: posts.length === 0 ? theme.colors.background : '#000000' }}
        header={
          <PageHeader
            testID="videos-header"
            titleAlign="center"
            presentation="floating"
            title={
              <SegmentedControl<VideoFeedTab>
                label={t('seo.videos.title')}
                type="radio"
                size="lg"
                value={activeFeed}
                onValueChange={handleSelectFeed}
              >
                <SegmentedControlItem value="videos">
                  <SegmentedControlItemText>{t('For You')}</SegmentedControlItemText>
                </SegmentedControlItem>
                {canUsePrivateApi && (
                  <SegmentedControlItem value="following">
                    <SegmentedControlItemText>{t('Following')}</SegmentedControlItemText>
                  </SegmentedControlItem>
                )}
              </SegmentedControl>
            }
          />
        }
      >
        <View
          className="w-full native:flex-1"
          onLayout={
            Platform.OS === 'web'
              ? undefined
              : (event) => setViewportHeight(event.nativeEvent.layout.height)
          }
        >
          {/* The reel publishes its own viewability (the snapped slide) to the
                    playback authority. A context provider renders no view, so the
                    slides' layout is untouched. */}
          {posts.length > 0 && (
            <VideoViewabilityProvider viewableKeys={viewableVideoKeys}>
              {Platform.OS === 'web' ? (
                <ScreenPager
                  key={sessionId}
                  ref={pagerRef}
                  data={posts}
                  keyExtractor={keyExtractor}
                  renderRadius={WEB_RENDER_RADIUS}
                  onIndexChange={setCurrentVisibleIndex}
                  onEndReached={handleLoadMore}
                  onEndReachedThreshold={2}
                  renderItem={({ item, index, viewportHeight }) => (
                    <VideoItem
                      item={item}
                      isActive={index === currentVisibleIndex}
                      // See the native path: the session's owner keeps its player.
                      isNear={isSlideNear(
                        index,
                        currentVisibleIndex,
                        activeRadius,
                        item.id === pipOwnerId,
                        isFocused,
                      )}
                      onBufferAhead={handleBufferAhead}
                      screenFocused={isFocused}
                      theme={theme}
                      onLike={handleLike}
                      onComment={handleComment}
                      onBoost={handleBoost}
                      onSave={handleSave}
                      onShare={handleShare}
                      onSendInAllo={interactions.sendInAllo}
                      formatCompactNumber={formatCompactNumber}
                      muted={globalMuted}
                      onMutedChange={handleMuteChange}
                      bottomBarHeight={bottomBarHeight}
                      t={t}
                      windowHeight={viewportHeight}
                      bottomSheetProgress={bottomSheetProgress}
                      viewerId={viewerId}
                      ownsSession={item.id === pipOwnerId}
                      sessionActive={pipOwnerId !== null}
                      sessionSource={item.id === pipOwnerId ? sessionSource : undefined}
                      onSessionStart={startPipSession}
                      onSessionEnd={endPipSession}
                      onRegisterTransportSeek={registerTransportSeek}
                    />
                  )}
                />
              ) : WINDOW_HEIGHT > 0 ? (
                <FlatList
                  key={sessionId}
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
              ) : null}
            </VideoViewabilityProvider>
          )}

          {posts.length === 0 && (
            <View
              className="native:flex-1 web:min-h-[var(--bloom-screen-viewport-height)] items-center justify-center"
              style={
                isLoading
                  ? undefined
                  : {
                      paddingTop: insets.top + 72,
                      paddingBottom: bottomBarHeight + 24,
                      paddingHorizontal: 24,
                    }
              }
              testID="videos-status"
            >
              {isLoading ? (
                <VideoSkeleton />
              ) : (
                <EmptyState
                  title={t(hasLoadError ? 'videos.load_failed' : 'videos.no_video_posts_yet')}
                  subtitle={t(
                    hasLoadError ? 'videos.load_failed_description' : 'videos.empty_description',
                  )}
                  sticker={hasLoadError ? 'loadError' : 'videosTab'}
                  action={{ label: t('common.retry'), onPress: handleRetry }}
                />
              )}
            </View>
          )}

          {loadingMore && (
            <View
              className="absolute left-0 right-0 items-center"
              style={{ bottom: bottomBarHeight + 24 }}
              pointerEvents="none"
            >
              <SpinnerIcon size={24} className="text-white" />
            </View>
          )}
        </View>
      </Screen>
    </>
  );
}

const TEXT_SHADOW_STRONG: Pick<
  TextStyle,
  'textShadowColor' | 'textShadowOffset' | 'textShadowRadius'
> = {
  textShadowColor: 'rgba(0, 0, 0, 0.8)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
};

const TEXT_SHADOW_MEDIUM: Pick<
  TextStyle,
  'textShadowColor' | 'textShadowOffset' | 'textShadowRadius'
> = {
  textShadowColor: 'rgba(0, 0, 0, 0.8)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 2,
};

const TEXT_SHADOW_HANDLE: Pick<
  TextStyle,
  'textShadowColor' | 'textShadowOffset' | 'textShadowRadius'
> = {
  textShadowColor: 'rgba(0, 0, 0, 0.9)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 4,
};

const styles = StyleSheet.create({
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
    height: '100%',
    pointerEvents: 'none',
  },
  rightActions: {
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: 16,
    zIndex: 6,
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
    marginRight: 16,
    minWidth: 0,
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
    flex: 1,
    minWidth: 0,
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
    flexShrink: 1,
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
});
