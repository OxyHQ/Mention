import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, Text, Platform, type StyleProp, type ViewStyle, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer, type VideoPlayer as ExpoVideoPlayer } from 'expo-video';
import { useEvent, useEventListener } from 'expo';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import { useVideoPlayback } from '@/context/VideoPlaybackContext';
import { useHlsPlayback } from '@/lib/hlsPlayback';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import { formatDuration } from '@/utils/formatDuration';

interface VideoPlayerProps {
  src: string;
  style?: StyleProp<ViewStyle>;
  contentFit?: 'contain' | 'cover' | 'fill';
  autoPlay?: boolean;
  loop?: boolean;
  /**
   * Poster (thumbnail) image shown over the video surface until the first frame
   * plays. Lets federated/remote videos render a frame instead of a black box
   * before playback starts. May 404/fail to load → silently hidden (no broken
   * image). Resolve via `videoPosterUrl` from the RAW media reference.
   */
  poster?: string;
  /**
   * When provided, the player renders in feed-preview mode (Instagram Reels style):
   * the whole surface taps through to `onPress` (e.g. open the immersive viewer),
   * the inline controls overlay is suppressed, and only a mute/unmute toggle remains.
   */
  onPress?: () => void;
  /**
   * GIF mode (looping muted autoplay, like X/Meta). When set: the player is ALWAYS
   * muted (ignores the global mute store), loops, autoplays, and renders NO controls,
   * NO mute toggle, NO overlays, and is NOT tappable (no reels/lightbox). Use for
   * GIFs stored as mp4. Leaves all other behavior untouched when unset.
   */
  gif?: boolean;
  /**
   * Key the nearest viewability source knows this player's row by — on native
   * feeds, the post key the list publishes from `onViewableItemsChanged`. Without
   * it a player inside a list falls back to "visible while its screen is
   * focused", which is the right answer for screens that own no list (post
   * detail, single-video screens) and too permissive inside one.
   */
  viewabilityKey?: string;
  /**
   * Reports the video's intrinsic aspect ratio (width / height) once the source's
   * metadata loads. A feed card uses this to give itself a DEFINITE, aspect-correct
   * height: the native `VideoView` has no auto-height, so a height-less container
   * lets the native view overflow downward past `overflow:hidden`. Emitted at most
   * once per distinct ratio per source. Not available on web — expo-video does not
   * expose video-track metadata there, and the HTML `<video>` auto-sizes instead.
   */
  onAspectRatio?: (ratio: number) => void;
  /**
   * A player somebody else owns, used INSTEAD of building one here.
   *
   * `useVideoPlayer` ties a player's life to this component, which is right for
   * a surface that owns its video and wrong for one whose video has to survive
   * the route change — the shared registry owns those. When this is set the
   * internal player is built with a `null` source so it opens no decoder, and
   * every presentation setting below is applied to the player passed in
   * instead: the registry deliberately configures nothing, because two surfaces
   * showing one video may legitimately disagree about `loop` or `muted`.
   */
  player?: ExpoVideoPlayer;
}

const CONTROLS_HIDE_DELAY = 3000;
const TIME_UPDATE_INTERVAL = 0.25;

const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  style,
  contentFit = 'contain',
  autoPlay = true,
  loop = false,
  poster,
  onPress,
  gif = false,
  viewabilityKey,
  onAspectRatio,
  player: externalPlayer,
}) => {
  const isPreviewMode = onPress !== undefined && !gif;
  const { isMuted, toggleMuted } = useVideoMuteStore();

  // The app-wide playback authority decides whether this player may play at all
  // (visible + screen focused + app foregrounded) and whether it owns the single
  // audible slot. GIF mode is `silent`: still visibility-gated, but it never
  // competes for that slot, so several visible GIFs may loop at once.
  const playerInstanceId = useId();
  const { shouldPlay, claimActive, reportVisibility } = useVideoPlayback({
    id: playerInstanceId,
    viewabilityKey,
    silent: gif,
  });

  const [showControls, setShowControls] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);
  // First-frame latch: once the video has rendered a frame we drop the poster
  // and never bring it back (a mid-playback re-buffer must not re-flash it).
  const [hasRenderedFrame, setHasRenderedFrame] = useState(false);
  // Poster 404/load failure → hide it (no broken image), revealing the surface.
  const [posterFailed, setPosterFailed] = useState(false);
  // Dedupes the aspect-ratio callback: emit at most once per distinct ratio per
  // source, so repeated metadata events don't churn the parent's state.
  const [reportedRatio, setReportedRatio] = useState<number | null>(null);

  // Reset the per-source state when the source changes. Adjusted during render
  // via a previous-value tracker rather than in an effect, so a new source never
  // paints a frame carrying the previous video's poster/duration state. See
  // React "You Might Not Need an Effect".
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setHasRenderedFrame(false);
    setPosterFailed(false);
    setReportedRatio(null);
    setDuration(0);
    setCurrentTime(0);
  }

  const handlePosterError = useCallback(() => setPosterFailed(true), []);

  // Emits the intrinsic aspect ratio to the parent once the source metadata loads.
  const reportAspectRatio = useCallback(
    (width?: number, height?: number) => {
      if (!onAspectRatio || !width || !height || width <= 0 || height <= 0) return;
      const ratio = width / height;
      if (!Number.isFinite(ratio) || ratio <= 0 || reportedRatio === ratio) return;
      setReportedRatio(ratio);
      onAspectRatio(ratio);
    },
    [onAspectRatio, reportedRatio],
  );

  const videoViewRef = useRef<InstanceType<typeof VideoView>>(null);
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressBarRef = useRef<View>(null);
  // Root container — observed by an IntersectionObserver on web to report this
  // player's viewport center-Y AND whether it still intersects the viewport.
  const containerRef = useRef<View>(null);

  // Federated video is an HLS playlist, which Chrome and Firefox cannot decode.
  // On web such a source is handed to hls.js, which attaches a MediaSource to
  // this same element — so the source must be WITHHELD from expo-video (`null`),
  // or the element would first attempt, and fail, a native load of the playlist.
  // Inert on native: ExoPlayer/AVPlayer decode HLS themselves.
  const hls = useHlsPlayback(src, videoViewRef);

  // Built unconditionally so the hook order never depends on a prop, but with a
  // `null` source when a player was handed in — a null-sourced player opens no
  // decoder, so the unused one costs nothing.
  const ownPlayer = useVideoPlayer(externalPlayer || hls.active ? null : src, (p) => {
    p.loop = gif ? true : loop;
    p.muted = gif ? true : isMuted;
    p.timeUpdateEventInterval = TIME_UPDATE_INTERVAL;
  });
  const player = externalPlayer ?? ownPlayer;

  // The setup callback above only ever runs for the player built here, so a
  // borrowed one is configured from this effect instead. Idempotent property
  // writes, so running it for both is simpler than branching and cannot drift.
  useEffect(() => {
    player.loop = gif ? true : loop;
    player.timeUpdateEventInterval = TIME_UPDATE_INTERVAL;
  }, [player, gif, loop]);

  const scheduleHideControls = useCallback(() => {
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    hideControlsTimer.current = setTimeout(() => {
      setShowControls(false);
    }, CONTROLS_HIDE_DELAY);
  }, []);

  // Sync mute state from global store (GIFs stay force-muted regardless).
  useEffect(() => {
    player.muted = gif ? true : isMuted;
  }, [isMuted, player, gif]);

  // Player events. `useEvent` / `useEventListener` (from expo) own the
  // subscription AND its removal, so playback state is derived from the player's
  // own event stream instead of hand-rolled listener effects.
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: false });

  useEventListener(player, 'playingChange', ({ isPlaying: playing }) => {
    if (playing) {
      scheduleHideControls();
    }
  });

  useEventListener(player, 'timeUpdate', ({ currentTime: time }) => {
    if (!isSeeking) {
      setCurrentTime(time);
    }
  });

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status !== 'readyToPlay') return;
    setHasRenderedFrame(true);
    if (player.duration > 0) {
      setDuration(player.duration);
    }
    reportAspectRatio(player.videoTrack?.size?.width, player.videoTrack?.size?.height);
  });

  useEventListener(player, 'sourceLoad', ({ duration: loadedDuration, availableVideoTracks }) => {
    if (loadedDuration > 0) {
      setDuration(loadedDuration);
    }
    const track = availableVideoTracks?.find(
      (t) => t.size?.width > 0 && t.size?.height > 0,
    );
    if (track) {
      reportAspectRatio(track.size.width, track.size.height);
    }
  });

  // Web only: this player's own IntersectionObserver is its visibility source. It
  // reports BOTH the viewport center-Y (which contests the single audible slot)
  // and whether the player still intersects the viewport at all — the latter is
  // what makes a video that scrolled past go silent instead of playing forever.
  // GIFs report too: they never compete for audio, but an off-screen GIF must
  // stop decoding.
  useEffect(() => {
    if (Platform.OS !== 'web') return;

    // Resolve the underlying DOM node from the react-native-web View ref. RNW
    // exposes it via `_nativeNode`/`getNode()` (neither is on the typed ref),
    // with the ref itself as a last resort — narrow structurally, no `as any`.
    const ref = containerRef.current as
      | (View & { _nativeNode?: Element; getNode?: () => Element })
      | null;
    const node: Element | View | null = ref?._nativeNode ?? ref?.getNode?.() ?? ref;
    const element = node && (node as Partial<Element>).nodeType !== undefined
      ? (node as Element)
      : null;

    if (!element || typeof window === 'undefined' || !('IntersectionObserver' in window)) {
      // No observer to report with (no DOM node resolved, or a runtime without
      // IntersectionObserver): treat the player as visible so the screen still
      // works, rather than silently never playing.
      reportVisibility(0, true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        reportVisibility(
          entry.boundingClientRect.y + entry.boundingClientRect.height / 2,
          entry.isIntersecting,
        );
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [reportVisibility]);

  // The ONE playback signal: the authority already folded visibility, screen
  // focus, app foreground and the single-audible-slot rule into `shouldPlay`.
  // `autoPlay` only gates AUTOMATIC start, so a manually started video keeps
  // playing; anything the authority disallows always pauses.
  useEffect(() => {
    if (!shouldPlay) {
      player.pause();
      return;
    }
    if (autoPlay) {
      player.play();
    }
  }, [player, shouldPlay, autoPlay]);

  useEffect(() => {
    return () => {
      if (hideControlsTimer.current) {
        clearTimeout(hideControlsTimer.current);
      }
    };
  }, []);

  const handleTap = useCallback(() => {
    setShowControls((prev) => {
      const next = !prev;
      if (next && isPlaying) {
        scheduleHideControls();
      }
      return next;
    });
  }, [isPlaying, scheduleHideControls]);

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      player.pause();
      // Keep controls visible when paused
      if (hideControlsTimer.current) {
        clearTimeout(hideControlsTimer.current);
      }
      return;
    }
    // Manual play wins: claim the audible slot so this becomes THE playing video
    // and every other on-screen video pauses.
    claimActive();
    player.play();
    scheduleHideControls();
  }, [player, isPlaying, scheduleHideControls, claimActive]);

  const handleMuteToggle = useCallback(() => {
    toggleMuted();
    scheduleHideControls();
  }, [toggleMuted, scheduleHideControls]);

  // Preview-mode mute toggle: flips mute without revealing the full controls overlay.
  const handlePreviewMuteToggle = useCallback(() => {
    toggleMuted();
  }, [toggleMuted]);

  const handleFullscreen = useCallback(() => {
    if (videoViewRef.current) {
      try {
        videoViewRef.current.enterFullscreen();
      } catch {
        // Fullscreen not supported
      }
    }
    scheduleHideControls();
  }, [scheduleHideControls]);

  const handleProgressBarPress = useCallback(
    (event: GestureResponderEvent) => {
      if (duration <= 0) return;

      progressBarRef.current?.measure((_x, _y, width, _height, _pageX, _pageY) => {
        if (!width || width <= 0) return;

        const locationX = event.nativeEvent.locationX;
        const ratio = Math.max(0, Math.min(1, locationX / width));
        const seekTime = ratio * duration;

        setIsSeeking(true);
        setCurrentTime(seekTime);
        player.currentTime = seekTime;

        // Small delay to let the seek settle
        setTimeout(() => {
          setIsSeeking(false);
        }, 300);
      });

      scheduleHideControls();
    },
    [player, duration, scheduleHideControls]
  );

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;

  return (
    <View ref={containerRef} style={[styles.container, style]}>
      <VideoView
        ref={videoViewRef}
        player={player}
        style={styles.video}
        contentFit={contentFit}
        nativeControls={false}
        fullscreenOptions={{ enable: !isPreviewMode && !gif }}
        allowsPictureInPicture={false}
      />

      {poster && !hasRenderedFrame && !posterFailed && (
        <Image
          source={{ uri: poster }}
          style={styles.posterLayer}
          contentFit={contentFit}
          cachePolicy="memory-disk"
          transition={150}
          pointerEvents="none"
          onError={handlePosterError}
        />
      )}

      {!gif && (isPreviewMode ? (
        <>
          {/* Whole-surface tap opens the immersive viewer (Instagram Reels style) */}
          <Pressable style={styles.tapArea} onPress={onPress} />

          {/* Mute/unmute stays available without leaving the feed; sits above the tap surface */}
          <Pressable
            onPress={handlePreviewMuteToggle}
            hitSlop={HIT_SLOP_MD}
            style={styles.previewMuteButton}
          >
            <View style={styles.previewMuteButtonInner}>
              <Ionicons
                name={isMuted ? 'volume-mute' : 'volume-high'}
                size={18}
                color="white"
              />
            </View>
          </Pressable>
        </>
      ) : (
      /* Tap area to toggle controls */
      <Pressable style={styles.tapArea} onPress={handleTap}>
        {showControls && (
          <View style={styles.controlsOverlay}>
            {/* Play/Pause center button */}
            <Pressable
              style={styles.playPauseButton}
              onPress={handlePlayPause}
              // Deliberately larger than HIT_SLOP_LG: this is the player's
              // primary control, centred and alone in the overlay, so a
              // generous region has nothing nearby to steal taps from.
              hitSlop={{ top: 20, bottom: 20, left: 20, right: 20 }}
            >
              <View style={styles.playPauseCircle}>
                <Ionicons
                  name={isPlaying ? 'pause' : 'play'}
                  size={32}
                  color="white"
                  style={!isPlaying ? styles.playIcon : undefined}
                />
              </View>
            </Pressable>

            {/* Bottom bar: progress + time + buttons */}
            <View style={styles.bottomBar}>
              {/* Time display */}
              <Text style={styles.timeText}>
                {formatDuration(currentTime)}
              </Text>

              {/* Progress bar */}
              <Pressable
                ref={progressBarRef}
                style={styles.progressBarContainer}
                onPress={handleProgressBarPress}
              >
                <View style={styles.progressBarTrack}>
                  <View
                    style={[
                      styles.progressBarFill,
                      { width: `${progress * 100}%` },
                    ]}
                  />
                  <View
                    style={[
                      styles.progressBarThumb,
                      { left: `${progress * 100}%` },
                    ]}
                  />
                </View>
              </Pressable>

              {/* Duration */}
              <Text style={styles.timeText}>
                {formatDuration(duration)}
              </Text>

              {/* Mute button */}
              <Pressable
                onPress={handleMuteToggle}
                hitSlop={HIT_SLOP_MD}
                style={styles.controlButton}
              >
                <Ionicons
                  name={isMuted ? 'volume-mute' : 'volume-high'}
                  size={20}
                  color="white"
                />
              </Pressable>

              {/* Fullscreen button */}
              <Pressable
                onPress={handleFullscreen}
                hitSlop={HIT_SLOP_MD}
                style={styles.controlButton}
              >
                <Ionicons name="expand" size={20} color="white" />
              </Pressable>
            </View>
          </View>
        )}
      </Pressable>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    overflow: 'hidden',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  posterLayer: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
  tapArea: {
    ...StyleSheet.absoluteFill,
    zIndex: 1,
  },
  previewMuteButton: {
    position: 'absolute',
    bottom: 10,
    right: 10,
    zIndex: 2,
  },
  previewMuteButtonInner: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  controlsOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  playPauseButton: {
    zIndex: 2,
  },
  playPauseCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  playIcon: {
    marginLeft: 3, // Visual centering for play triangle
  },
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    gap: 8,
  },
  timeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    minWidth: 36,
    textAlign: 'center',
  },
  progressBarContainer: {
    flex: 1,
    height: 24,
    justifyContent: 'center',
  },
  progressBarTrack: {
    height: 3,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 1.5,
    position: 'relative',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: 'white',
    borderRadius: 1.5,
  },
  progressBarThumb: {
    position: 'absolute',
    top: -5,
    marginLeft: -6,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: 'white',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 3px rgba(0, 0, 0, 0.4)' }
      : { elevation: 2 }),
  },
  controlButton: {
    padding: 4,
  },
});

// Owns an expensive expo-video player instance, mounted per video cell in feeds
// and the reels viewer. Memoized so a parent re-render with unchanged props does
// not tear down / recreate the player or re-run its effects.
export default React.memo(VideoPlayer);
