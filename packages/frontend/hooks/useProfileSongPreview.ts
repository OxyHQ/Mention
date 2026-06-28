import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('useProfileSongPreview');

// `expo-audio`'s `AudioPlayer` extends `SharedObject`, which the package types as
// the constructor side of a global C++ class — so its instance members
// (`addListener`, `playing`, …) do not resolve through `ReturnType` in a
// standalone `tsc`, and the type names aren't importable (re-exported via
// `export type *`). Describe exactly the player surface this hook drives, and
// assert it once at the single `createAudioPlayer` call site below.
interface PreviewStatus {
  playing: boolean;
  isBuffering: boolean;
  didJustFinish: boolean;
}

interface PreviewPlayer {
  play(): void;
  pause(): void;
  seekTo(seconds: number): Promise<void>;
  remove(): void;
  addListener(
    event: 'playbackStatusUpdate',
    listener: (status: PreviewStatus) => void,
  ): { remove(): void };
}

// Only ONE profile-song preview may play at a time across the whole app. Each
// mounted previewer registers its `stop` here; starting playback stops every
// other registered previewer first (so tapping a second song pauses the first).
// A module-level Set keeps this coordination out of React state.
const activePreviewStops = new Set<() => void>();

function stopOtherPreviews(current: () => void): void {
  for (const stop of activePreviewStops) {
    if (stop !== current) {
      stop();
    }
  }
}

// Configure the audio session once so a preview is audible even with the iOS
// ringer on silent. Best-effort — a failure here must not break the button.
let audioModeConfigured = false;
function ensureAudioModeConfigured(): void {
  if (audioModeConfigured) {
    return;
  }
  audioModeConfigured = true;
  setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'mixWithOthers' }).catch(
    (error: unknown) => {
      logger.warn('Failed to configure audio mode for profile song preview', { error });
    },
  );
}

export interface ProfileSongPreviewController {
  /** Whether this preview is currently playing. */
  isPlaying: boolean;
  /** Whether the source is buffering after a play tap (before the first frames). */
  isLoading: boolean;
  /** Toggle playback: starts (stopping any other preview) or pauses this one. */
  toggle: () => void;
  /** Stop playback and reset to the clip start. */
  stop: () => void;
}

/**
 * `expo-audio`-backed controller for a single 30s profile-song preview. The
 * player loads lazily on the first play, auto-stops at the end of the clip,
 * releases on unmount or source change, and coordinates a single global preview
 * across the app so tapping one song stops any other that is playing.
 */
export function useProfileSongPreview(previewUrl: string | undefined): ProfileSongPreviewController {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const playerRef = useRef<PreviewPlayer | null>(null);
  const subscriptionRef = useRef<{ remove: () => void } | null>(null);

  const releasePlayer = useCallback(() => {
    subscriptionRef.current?.remove();
    subscriptionRef.current = null;
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      try {
        player.remove();
      } catch (error: unknown) {
        logger.warn('Failed to release profile song preview player', { error });
      }
    }
  }, []);

  const stop = useCallback(() => {
    const player = playerRef.current;
    if (player) {
      try {
        player.pause();
        // Reset to the clip start so the next tap replays from the beginning.
        player.seekTo(0).catch((error: unknown) => {
          logger.warn('Failed to reset profile song preview position', { error });
        });
      } catch (error: unknown) {
        logger.warn('Failed to pause profile song preview', { error });
      }
    }
    setIsPlaying(false);
    setIsLoading(false);
  }, []);

  const toggle = useCallback(() => {
    if (!previewUrl) {
      return;
    }

    // Pause when this preview is already playing.
    if (playerRef.current && isPlaying) {
      stop();
      return;
    }

    ensureAudioModeConfigured();
    // Enforce a single global preview before starting this one.
    stopOtherPreviews(stop);

    let player = playerRef.current;
    if (!player) {
      // See the PreviewPlayer note above: the real instance type is opaque to a
      // standalone tsc, so assert the surface we drive at this single call site.
      player = createAudioPlayer(previewUrl) as unknown as PreviewPlayer;
      playerRef.current = player;
      subscriptionRef.current = player.addListener('playbackStatusUpdate', (status: PreviewStatus) => {
        setIsPlaying(status.playing);
        setIsLoading(status.isBuffering && !status.playing);
        if (status.didJustFinish) {
          // The backend preview is a fixed 30s clip; reset it for replay.
          stop();
        }
      });
    }

    setIsLoading(true);
    try {
      player.play();
    } catch (error: unknown) {
      logger.warn('Failed to start profile song preview', { error });
      stop();
    }
  }, [previewUrl, isPlaying, stop]);

  // Register for single-global-preview coordination, and tear the player down
  // when the source changes or the component unmounts. `stop`/`releasePlayer`
  // are stable, so this only re-runs when `previewUrl` changes.
  useEffect(() => {
    activePreviewStops.add(stop);
    return () => {
      activePreviewStops.delete(stop);
      stop();
      releasePlayer();
    };
  }, [previewUrl, stop, releasePlayer]);

  return { isPlaying, isLoading, toggle, stop };
}
