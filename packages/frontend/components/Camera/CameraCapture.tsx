import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
  type CameraMode,
  type CameraType,
} from 'expo-camera';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/components/ThemedText';
import { Button } from '@/components/ui/Button';
import type { LocalCapture } from './useCaptureUpload';

/** Longest video a single hold records, in seconds. */
const MAX_VIDEO_SECONDS = 60;

interface CameraCaptureProps {
  /** Fires with whatever the reader just captured. */
  onCaptured: (capture: LocalCapture) => void;
  /** Leave the camera — the X, and the hardware back. */
  onClose: () => void;
}

/**
 * The live camera: preview, shutter, flip.
 *
 * TAP TAKES A PHOTO, HOLD RECORDS — the gesture every reader already knows from
 * Instagram, and the reason there is one control rather than a mode switch.
 *
 * THE MODE IS STILL A MODE, though, and it is switched underneath that gesture.
 * `CameraView` captures stills in `picture` mode and video in `video` mode, and
 * the prop only takes effect once React has committed it — so a hold cannot just
 * set it and call `recordAsync` on the next line. The hold ARMS a recording and
 * an effect starts it when the mode has actually landed; a press that ends
 * before then disarms it, which is what makes a fast tap stay a photo.
 *
 * VIDEO NEEDS THE MICROPHONE, and that is a SECOND runtime permission — the
 * camera grant does not carry it, and `app.config.js` only declares the native
 * one and its usage string. Without it a recording is silent or fails outright.
 * It is asked for at the moment a recording is armed rather than on mount, so a
 * reader who only ever takes photos is never asked; a refusal cancels the
 * recording and leaves photos working.
 *
 * IT IS ALSO THE WEB BUNDLE'S BOUNDARY, and that is why the `expo-camera` import
 * is HERE rather than in the route file. Expo-router puts every route file in
 * the graph — a `.web.tsx` route sibling does not keep its native twin out, and
 * `dist/` was shipping a 31KB `camera` chunk carrying `expo-camera`'s web build
 * to a platform that never renders it. A module fork does keep it out: Metro
 * resolves `./CameraCapture` to `CameraCapture.web.tsx` on web, so nothing on
 * that side ever names the package. Same mechanism as
 * `components/navigation/TabsPager.web.tsx` and `react-native-pager-view`, and
 * `components/Camera/__tests__/cameraWebBoundary.test.ts` is what keeps it true.
 *
 * THE PREVIEW IS ONLY MOUNTED WHILE THE PAGE IS FOCUSED, and its owner enforces
 * that by not rendering this component otherwise (`(tabs)/camera.tsx`). A
 * `CameraView` left mounted holds the sensor: the OS indicator stays lit, the
 * battery drains, and on Android a second surface cannot open one. That is also
 * why the page declares `preload: false` — a camera mounted merely for being
 * Home's neighbour would do all of that behind the feed.
 */
export function CameraCapture({ onCaptured, onClose }: CameraCaptureProps) {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [facing, setFacing] = useState<CameraType>('back');
  const [mode, setMode] = useState<CameraMode>('picture');
  const [recording, setRecording] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  // A capture is async and the finger can arrive again before it resolves.
  const busy = useRef(false);
  // Set while a hold is waiting for `video` mode to commit. Cleared by the
  // effect that starts the recording, and by a press that ends first.
  const armed = useRef(false);

  const takePhoto = useCallback(async () => {
    if (busy.current || recording || mode !== 'picture') return;
    busy.current = true;
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.9 });
      if (photo?.uri) onCaptured({ uri: photo.uri, kind: 'image', mimeType: 'image/jpeg' });
    } finally {
      busy.current = false;
    }
  }, [onCaptured, recording, mode]);

  /**
   * Arm a recording: ask for the microphone, then ask for `video` mode.
   *
   * Nothing records here. The effect below does, once the mode has committed —
   * see the note at the top of the file.
   */
  const armRecording = useCallback(async () => {
    if (busy.current || recording || armed.current) return;

    if (!micPermission?.granted) {
      // A refusal is not an error state: photos still work, and asking again on
      // the next hold is the behaviour a reader who changes their mind expects.
      // `canAskAgain` false means the prompt would never appear, so there is
      // nothing to await either.
      if (!micPermission?.canAskAgain) return;
      const granted = await requestMicPermission();
      if (!granted?.granted) return;
    }

    armed.current = true;
    setMode('video');
  }, [micPermission, requestMicPermission, recording]);

  useEffect(() => {
    if (mode !== 'video' || !armed.current || recording) return;
    let cancelled = false;
    setRecording(true);
    busy.current = true;
    void (async () => {
      try {
        // Resolves when `stopRecording` is called, which is why the capture is
        // reported from here rather than from the press-out handler.
        const video = await cameraRef.current?.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });
        if (!cancelled && video?.uri) {
          onCaptured({ uri: video.uri, kind: 'video', mimeType: 'video/mp4' });
        }
      } finally {
        armed.current = false;
        busy.current = false;
        setRecording(false);
        setMode('picture');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, recording, onCaptured]);

  const endPress = useCallback(() => {
    if (recording) {
      cameraRef.current?.stopRecording();
      return;
    }
    // The hold ended before `video` mode landed — a fast tap, or a refused
    // microphone. Disarm, or the effect would start a recording nobody is still
    // holding for.
    if (armed.current) {
      armed.current = false;
      setMode('picture');
    }
  }, [recording]);

  // `permission` is null only while the module is still answering. Deciding
  // "denied" then would show the explanation to someone who has not been asked.
  if (!permission) return <View style={styles.root} />;

  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.explain]}>
        <ThemedText className="text-white text-lg text-center mb-2">
          {t('camera.permissionTitle', { defaultValue: 'Let Mention use the camera' })}
        </ThemedText>
        <ThemedText className="text-white/70 text-center mb-6">
          {t('camera.permissionBody', {
            defaultValue: 'Photos and videos you take here are only posted when you choose to.',
          })}
        </ThemedText>
        {/* `canAskAgain` is false once the reader has refused twice on iOS; the
            prompt would never appear, so the honest button is the one that goes
            back rather than one that silently does nothing. */}
        {permission.canAskAgain ? (
          <Button onPress={requestPermission}>
            {t('camera.permissionAllow', { defaultValue: 'Allow camera' })}
          </Button>
        ) : (
          <Button onPress={onClose}>{t('common.close', { defaultValue: 'Close' })}</Button>
        )}
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} mode={mode} />

      <Pressable
        onPress={onClose}
        style={styles.close}
        accessibilityRole="button"
        accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
      >
        <ThemedText className="text-white text-2xl">×</ThemedText>
      </Pressable>

      <View style={styles.controls}>
        <View style={styles.sideSlot} />
        <Pressable
          onPress={takePhoto}
          onLongPress={armRecording}
          onPressOut={endPress}
          delayLongPress={250}
          accessibilityRole="button"
          // The control does two things, and a reader who cannot see it has no
          // other way to learn the second one.
          accessibilityLabel={t('camera.shutter', { defaultValue: 'Take a photo' })}
          accessibilityHint={t('camera.shutterHint', {
            defaultValue: 'Hold to record a video',
          })}
          style={[styles.shutter, recording && styles.shutterRecording]}
        />
        <Pressable
          onPress={() => setFacing((current) => (current === 'back' ? 'front' : 'back'))}
          style={styles.sideSlot}
          accessibilityRole="button"
          accessibilityLabel={t('camera.flip', { defaultValue: 'Switch camera' })}
        >
          <ThemedText className="text-white text-xl">⟲</ThemedText>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  explain: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  close: { position: 'absolute', top: 56, left: 20, padding: 12 },
  controls: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 40,
  },
  sideSlot: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 5,
    borderColor: '#fff',
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  shutterRecording: { backgroundColor: '#ef4444', borderColor: '#ef4444' },
});
