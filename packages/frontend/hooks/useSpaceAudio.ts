import { useState, useEffect, useRef, useCallback } from 'react';
import {
  useAudioRecorder,
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  createAudioPlayer,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import {
  spaceSocketService,
  type AudioDataPayload,
} from '@/services/spaceSocketService';

const CHUNK_DURATION_MS = 500;

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

  // Request microphone permission
  const requestPermission = useCallback(async (): Promise<boolean> => {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      setPermissionGranted(status.granted);
      return status.granted;
    } catch (err) {
      console.warn('Failed to request audio permission:', err);
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
      }).catch(() => {});
    }
  }, [isConnected]);

  // Recording loop for speakers
  useEffect(() => {
    if (!isSpeaker || isMuted || !isConnected || !permissionGranted) {
      if (isActiveRef.current) {
        isActiveRef.current = false;
        setIsRecording(false);
        // Stop any active recording
        recorder.stop().catch(() => {});
      }
      return;
    }

    let cancelled = false;
    isActiveRef.current = true;
    setIsRecording(true);

    const recordLoop = async () => {
      while (isActiveRef.current && !cancelled) {
        try {
          // Prepare and start recording
          await recorder.prepareToRecordAsync();
          recorder.record();

          // Wait for chunk duration
          await new Promise((resolve) => setTimeout(resolve, CHUNK_DURATION_MS));

          // Stop and get the URI
          await recorder.stop();
          const uri = recorder.uri;

          if (uri && isActiveRef.current && !cancelled) {
            // Read file as base64
            const base64 = await FileSystem.readAsStringAsync(uri, {
              encoding: FileSystem.EncodingType.Base64,
            });

            // Send via socket
            sequenceRef.current += 1;
            spaceSocketService.sendAudioData(
              spaceId,
              base64,
              sequenceRef.current
            );

            // Clean up temp file
            await FileSystem.deleteAsync(uri, { idempotent: true }).catch(
              () => {}
            );
          }
        } catch (err) {
          console.warn('Recording chunk error:', err);
          // Brief pause before retry
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
    };

    recordLoop();

    return () => {
      cancelled = true;
      isActiveRef.current = false;
      setIsRecording(false);
    };
  }, [isSpeaker, isMuted, isConnected, permissionGranted, spaceId, recorder]);

  // Playback for incoming audio chunks
  useEffect(() => {
    if (!isConnected) return;

    const handleAudioData = async (data: AudioDataPayload) => {
      try {
        // Write base64 chunk to a temp file
        const tempUri = `${FileSystem.cacheDirectory}space_audio_${data.userId}_${data.sequence}.m4a`;
        await FileSystem.writeAsStringAsync(tempUri, data.chunk, {
          encoding: FileSystem.EncodingType.Base64,
        });

        // Play the audio chunk
        const player = createAudioPlayer({ uri: tempUri });
        player.play();

        // Clean up after playback (chunks are ~500ms, generous timeout for safety)
        setTimeout(() => {
          try { player.remove(); } catch {}
          FileSystem.deleteAsync(tempUri, { idempotent: true }).catch(() => {});
        }, 1500);
      } catch (err) {
        console.warn('Audio playback error:', err);
      }
    };

    const unsubscribe = spaceSocketService.onAudioData(handleAudioData);

    return () => {
      unsubscribe();
    };
  }, [isConnected]);

  return {
    isRecording,
    permissionGranted,
    requestPermission,
  };
}
