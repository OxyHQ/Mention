import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, Text, Platform, type StyleProp, type ViewStyle, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { useVideoMuteStore } from '@/stores/videoMuteStore';
import { useActiveVideo } from '@/context/ActiveVideoContext';

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
   * Reports the video's intrinsic aspect ratio (width / height) once the source's
   * metadata loads. A feed card uses this to give itself a DEFINITE, aspect-correct
   * height: the native `VideoView` has no auto-height, so a height-less container
   * lets the native view overflow downward past `overflow:hidden`. Emitted at most
   * once per distinct ratio per source. Not available on web — expo-video does not
   * expose video-track metadata there, and the HTML `<video>` auto-sizes instead.
   */
  onAspectRatio?: (ratio: number) => void;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
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
  onAspectRatio,
}) => {
  const isPreviewMode = onPress !== undefined && !gif;
  const { isMuted, toggleMuted } = useVideoMuteStore();

  // "Only the on-screen video plays" coordination (Bluesky web mechanism). GIFs
  // do NOT participate — they always loop/autoplay — so they ignore `active`
  // entirely. Outside a feed (no Provider) or on native, `useActiveVideo`
  // returns `active: true`, preserving today's autoplay.
  const { active, setActive, sendPosition } = useActiveVideo();
  const effectiveActive = gif ? true : active;
  const [isPlaying, setIsPlaying] = useState(false);
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
  const lastReportedRatio = useRef<number | null>(null);

  useEffect(() => {
    setHasRenderedFrame(false);
    setPosterFailed(false);
    lastReportedRatio.current = null;
  }, [src]);

  const handlePosterError = useCallback(() => setPosterFailed(true), []);

  // Emits the intrinsic aspect ratio to the parent once the source metadata loads.
  const reportAspectRatio = useCallback(
    (width?: number, height?: number) => {
      if (!onAspectRatio || !width || !height || width <= 0 || height <= 0) return;
      const ratio = width / height;
      if (!Number.isFinite(ratio) || ratio <= 0 || lastReportedRatio.current === ratio) return;
      lastReportedRatio.current = ratio;
      onAspectRatio(ratio);
    },
    [onAspectRatio],
  );

  const videoViewRef = useRef<InstanceType<typeof VideoView>>(null);
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressBarRef = useRef<View>(null);
  // Root container — observed by an IntersectionObserver on web to report this
  // player's viewport center-Y to the active-video coordinator.
  const containerRef = useRef<View>(null);

  const player = useVideoPlayer(src, (p) => {
    if (p) {
      p.loop = gif ? true : loop;
      p.muted = gif ? true : isMuted;
      p.timeUpdateEventInterval = TIME_UPDATE_INTERVAL;
    }
  });

  // Sync mute state from global store (GIFs stay force-muted regardless).
  useEffect(() => {
    if (player) {
      player.muted = gif ? true : isMuted;
    }
  }, [isMuted, player, gif]);

  // Listen to player events
  useEffect(() => {
    if (!player) return;

    const playingSub = player.addListener('playingChange', ({ isPlaying: playing }) => {
      setIsPlaying(playing);
      if (playing) {
        scheduleHideControls();
      }
    });

    const timeUpdateSub = player.addListener('timeUpdate', ({ currentTime: time }) => {
      if (!isSeeking) {
        setCurrentTime(time);
      }
    });

    const statusSub = player.addListener('statusChange', ({ status }) => {
      if (status === 'readyToPlay') {
        setHasRenderedFrame(true);
        if (player.duration > 0) {
          setDuration(player.duration);
        }
        reportAspectRatio(player.videoTrack?.size?.width, player.videoTrack?.size?.height);
      }
    });

    const sourceLoadSub = player.addListener('sourceLoad', ({ duration: dur, availableVideoTracks }) => {
      if (dur > 0) {
        setDuration(dur);
      }
      const track = availableVideoTracks?.find(
        (t) => t.size?.width > 0 && t.size?.height > 0,
      );
      if (track) {
        reportAspectRatio(track.size.width, track.size.height);
      }
    });

    return () => {
      playingSub.remove();
      timeUpdateSub.remove();
      statusSub.remove();
      sourceLoadSub.remove();
    };
  }, [player, isSeeking, reportAspectRatio]);

  // Web only: report this player's viewport position to the active-video
  // coordinator via an IntersectionObserver (threshold 0.5), exactly like
  // Bluesky. GIFs never compete (they always play), so they skip this entirely.
  useEffect(() => {
    if (gif) return;
    if (Platform.OS !== 'web') return;
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return;

    // Resolve the underlying DOM node from the react-native-web View ref. RNW
    // exposes it via `_nativeNode`/`getNode()` (neither is on the typed ref),
    // with the ref itself as a last resort — narrow structurally, no `as any`.
    const ref = containerRef.current as
      | (View & { _nativeNode?: Element; getNode?: () => Element })
      | null;
    const element: Element | View | null =
      ref?._nativeNode ?? ref?.getNode?.() ?? ref;
    if (!element || (element as Partial<Element>).nodeType === undefined) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        sendPosition(
          entry.boundingClientRect.y + entry.boundingClientRect.height / 2,
        );
      },
      { threshold: 0.5 },
    );
    observer.observe(element as Element);
    return () => observer.disconnect();
  }, [gif, sendPosition]);

  // Auto-play — gated on the active-video coordinator. Only the single active
  // (on-screen) video plays; a non-active video pauses. GIFs are forced active
  // so they always loop. Outside a feed / on native, `active` is always true,
  // preserving today's autoplay.
  useEffect(() => {
    if (!player) return;
    if (autoPlay && effectiveActive) {
      const play = async () => {
        try {
          await player.play();
        } catch {
          // Autoplay may be blocked
        }
      };
      play();
    } else {
      try {
        player.pause();
      } catch {
        // Silently handle
      }
    }
    return () => {
      if (player) {
        try {
          player.pause();
        } catch {
          // Silently handle
        }
      }
    };
  }, [player, autoPlay, effectiveActive]);

  // Controls auto-hide
  const scheduleHideControls = useCallback(() => {
    if (hideControlsTimer.current) {
      clearTimeout(hideControlsTimer.current);
    }
    hideControlsTimer.current = setTimeout(() => {
      setShowControls(false);
    }, CONTROLS_HIDE_DELAY);
  }, []);

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
    if (!player) return;
    try {
      if (isPlaying) {
        player.pause();
        // Keep controls visible when paused
        if (hideControlsTimer.current) {
          clearTimeout(hideControlsTimer.current);
        }
      } else {
        // Manual play wins: claim active status so this becomes THE playing
        // video (and any other on-screen video pauses), mirroring Bluesky.
        setActive();
        player.play();
        scheduleHideControls();
      }
    } catch {
      // Silently handle
    }
  }, [player, isPlaying, scheduleHideControls, setActive]);

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
      if (!player || duration <= 0) return;

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
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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
                {formatTime(currentTime)}
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
                {formatTime(duration)}
              </Text>

              {/* Mute button */}
              <Pressable
                onPress={handleMuteToggle}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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
