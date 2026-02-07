import { useState, useEffect, useRef, useCallback } from 'react';
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  createAudioPlayer,
} from 'expo-audio';
import type { AudioPlayer } from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import {
  spaceSocketService,
  type AudioDataPayload,
} from '@/services/spaceSocketService';

const CHUNK_DURATION_MS = 500;
const INTER_CHUNK_DELAY_MS = 50; // Brief pause between stop and next prepare

interface UseSpaceAudioOptions {
  spaceId: string;
  isSpeaker: boolean;
  isMuted: boolean;
  isConnected: boolean;
}

interface UseSpaceAudioReturn {
  isRecording: boolean;
  permissionGranted: boolean;
  requestPermission: () => Promise<boolean>;
}

export function useSpaceAudio({
  spaceId,
  isSpeaker,
  isMuted,
  isConnected,
}: UseSpaceAudioOptions): UseSpaceAudioReturn {
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const sequenceRef = useRef(0);
  const isActiveRef = useRef(false);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  // Use refs to avoid stale closures in the recording loop
  const spaceIdRef = useRef(spaceId);
  spaceIdRef.current = spaceId;

  // Store recorder in ref so the loop always uses the current instance
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  // Request microphone permission
  const requestPermission = useCallback(async (): Promise<boolean> => {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      setPermissionGranted(status.granted);
      return status.granted;
    } catch (err) {
      console.warn('[SpaceAudio] Failed to request audio permission:', err);
      return false;
    }
  }, []);

  // Check permission on mount
  useEffect(() => {
    AudioModule.getRecordingPermissionsAsync()
      .then((status) => {
        setPermissionGranted(status.granted);
      })
      .catch(() => {});
  }, []);

  // Configure audio mode for spaces
  useEffect(() => {
    if (isConnected) {
      setAudioModeAsync({
        playsInSilentMode: true,
        allowsRecording: true,
      }).catch((err) => {
        console.warn('[SpaceAudio] Failed to set audio mode:', err);
      });
    }
  }, [isConnected]);

  // Recording loop for speakers
  // NOTE: recorder is excluded from deps intentionally — we use recorderRef
  // to avoid restarting the loop on every render
  useEffect(() => {
    if (!isSpeaker || isMuted || !isConnected || !permissionGranted) {
      if (isActiveRef.current) {
        isActiveRef.current = false;
        setIsRecording(false);
        try {
          recorderRef.current.stop().catch(() => {});
        } catch {}
      }
      return;
    }

    let cancelled = false;
    isActiveRef.current = true;
    setIsRecording(true);
    console.log('[SpaceAudio] Starting recording loop for space:', spaceId);

    const recordLoop = async () => {
      // Small delay to ensure audio mode is configured
      await new Promise((resolve) => setTimeout(resolve, 100));

      while (isActiveRef.current && !cancelled) {
        const rec = recorderRef.current;
        try {
          // Prepare and start recording
          await rec.prepareToRecordAsync();
          rec.record();

          // Wait for chunk duration
          await new Promise((resolve) => setTimeout(resolve, CHUNK_DURATION_MS));

          // Check if still active before processing
          if (!isActiveRef.current || cancelled) {
            try { await rec.stop(); } catch {}
            break;
          }

          // Stop and get the URI
          await rec.stop();
          const uri = rec.uri;

          if (uri && isActiveRef.current && !cancelled) {
            try {
              // Read file as base64
              const base64 = await FileSystem.readAsStringAsync(uri, {
                encoding: FileSystem.EncodingType.Base64,
              });

              if (base64 && base64.length > 0) {
                // Send via socket
                sequenceRef.current += 1;
                spaceSocketService.sendAudioData(
                  spaceIdRef.current,
                  base64,
                  sequenceRef.current
                );
              }
            } catch (readErr) {
              console.warn('[SpaceAudio] Failed to read audio chunk:', readErr);
            }

            // Clean up temp file
            FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
          }

          // Brief pause between cycles to let the recorder reset
          await new Promise((resolve) => setTimeout(resolve, INTER_CHUNK_DELAY_MS));
        } catch (err) {
          console.warn('[SpaceAudio] Recording chunk error:', err);
          // Longer pause before retry on error
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      console.log('[SpaceAudio] Recording loop ended');
    };

    recordLoop();

    return () => {
      console.log('[SpaceAudio] Cleanup: stopping recording loop');
      cancelled = true;
      isActiveRef.current = false;
      setIsRecording(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSpeaker, isMuted, isConnected, permissionGranted, spaceId]);

  // Playback for incoming audio chunks
  useEffect(() => {
    if (!isConnected) return;

    // Keep a pool of active players to avoid creating too many simultaneously
    const activePlayers = new Set<AudioPlayer>();

    const handleAudioData = async (data: AudioDataPayload) => {
      let tempUri: string | null = null;
      let player: AudioPlayer | null = null;

      try {
        // Write base64 chunk to a temp file
        tempUri = `${FileSystem.cacheDirectory}space_audio_${data.userId}_${data.sequence}.m4a`;
        await FileSystem.writeAsStringAsync(tempUri, data.chunk, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // Create and play the audio chunk
        player = createAudioPlayer({ uri: tempUri });
        activePlayers.add(player);
        player.play();

        // Clean up after playback (chunk is ~500ms, 2s timeout for safety)
        const cleanupPlayer = player;
        const cleanupUri = tempUri;
        setTimeout(() => {
          activePlayers.delete(cleanupPlayer);
          try { cleanupPlayer.remove(); } catch {}
          if (cleanupUri) {
            FileSystem.deleteAsync(cleanupUri, { idempotent: true }).catch(() => {});
          }
        }, 2000);
      } catch (err) {
        console.warn('[SpaceAudio] Audio playback error:', err);
        // Clean up on error
        if (player) {
          activePlayers.delete(player);
          try { player.remove(); } catch {}
        }
        if (tempUri) {
          FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
        }
      }
    };

    const unsubscribe = spaceSocketService.onAudioData(handleAudioData);

    return () => {
      unsubscribe();
      // Clean up all active players
      for (const p of activePlayers) {
        try { p.remove(); } catch {}
      }
      activePlayers.clear();
    };
  }, [isConnected]);

  return {
    isRecording,
    permissionGranted,
    requestPermission,
  };
}
