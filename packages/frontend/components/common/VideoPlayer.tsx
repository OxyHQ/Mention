import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, Text, Platform } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { useVideoMuteStore } from '@/stores/videoMuteStore';

interface VideoPlayerProps {
  src: string;
  style?: any;
  contentFit?: 'contain' | 'cover' | 'fill';
  autoPlay?: boolean;
  loop?: boolean;
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
}) => {
  const { isMuted, toggleMuted } = useVideoMuteStore();
  const [isPlaying, setIsPlaying] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isSeeking, setIsSeeking] = useState(false);

  const videoViewRef = useRef<InstanceType<typeof VideoView>>(null);
  const hideControlsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progressBarRef = useRef<View>(null);

  const player = useVideoPlayer(src, (p) => {
    if (p) {
      p.loop = loop;
      p.muted = isMuted;
      p.timeUpdateEventInterval = TIME_UPDATE_INTERVAL;
    }
  });

  // Sync mute state from global store
  useEffect(() => {
    if (player) {
      player.muted = isMuted;
    }
  }, [isMuted, player]);

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
      if (status === 'readyToPlay' && player.duration > 0) {
        setDuration(player.duration);
      }
    });

    const sourceLoadSub = player.addListener('sourceLoad', ({ duration: dur }) => {
      if (dur > 0) {
        setDuration(dur);
      }
    });

    return () => {
      playingSub.remove();
      timeUpdateSub.remove();
      statusSub.remove();
      sourceLoadSub.remove();
    };
  }, [player, isSeeking]);

  // Auto-play
  useEffect(() => {
    if (player && autoPlay) {
      const play = async () => {
        try {
          await player.play();
        } catch {
          // Autoplay may be blocked
        }
      };
      play();
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
  }, [player, autoPlay]);

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
        player.play();
        scheduleHideControls();
      }
    } catch {
      // Silently handle
    }
  }, [player, isPlaying, scheduleHideControls]);

  const handleMuteToggle = useCallback(() => {
    toggleMuted();
    scheduleHideControls();
  }, [toggleMuted, scheduleHideControls]);

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
    (event: any) => {
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
    <View style={[styles.container, style]}>
      <VideoView
        ref={videoViewRef as any}
        player={player}
        style={styles.video}
        contentFit={contentFit}
        nativeControls={false}
        allowsFullscreen={true}
        allowsPictureInPicture={false}
      />

      {/* Tap area to toggle controls */}
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
  tapArea: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 1,
  },
  controlsOverlay: {
    ...StyleSheet.absoluteFillObject,
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

export default VideoPlayer;
