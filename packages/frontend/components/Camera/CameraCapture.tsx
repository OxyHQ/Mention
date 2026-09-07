import React, { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { CameraView, useCameraPermissions, type CameraType } from 'expo-camera';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/components/ThemedText';
import { Button } from '@/components/ui/Button';
import type { LocalCapture } from './useCaptureUpload';

/** Longest video a single hold records, in ms. */
const MAX_VIDEO_MS = 60_000;

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
 * IT IS ALSO THE WEB BUNDLE'S BOUNDARY, and that is why the `expo-camera` import
 * is HERE rather than in the route file. Expo-router puts every route file in
 * the graph — a `.web.tsx` route sibling does not keep its native twin out, and
 * `dist/` was shipping a 31KB `camera` chunk carrying `expo-camera`'s web build
 * to a platform that never renders it. A module fork does keep it out: Metro
 * resolves `./CameraCapture` to `CameraCapture.web.tsx` on web, so nothing on
 * that side ever names the package. Same mechanism as
 * `components/navigation/TabsPager.web.tsx` and `react-native-pager-view`, and
 * `src/__tests__/cameraWebBoundary.test.ts` is what keeps it true.
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
  const [facing, setFacing] = useState<CameraType>('back');
  const [recording, setRecording] = useState(false);
  const cameraRef = useRef<CameraView>(null);
  // A capture is async and the finger can arrive again before it resolves.
  const busy = useRef(false);

  const takePhoto = useCallback(async () => {
    if (busy.current || recording) return;
    busy.current = true;
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.9 });
      if (photo?.uri) onCaptured({ uri: photo.uri, kind: 'image', mimeType: 'image/jpeg' });
    } finally {
      busy.current = false;
    }
  }, [onCaptured, recording]);

  const startRecording = useCallback(async () => {
    if (busy.current || recording) return;
    busy.current = true;
    setRecording(true);
    try {
      const video = await cameraRef.current?.recordAsync({ maxDuration: MAX_VIDEO_MS / 1000 });
      if (video?.uri) onCaptured({ uri: video.uri, kind: 'video', mimeType: 'video/mp4' });
    } finally {
      setRecording(false);
      busy.current = false;
    }
  }, [onCaptured, recording]);

  // `recordAsync` resolves when this is called, which is why the capture is
  // reported from that promise rather than from here.
  const stopRecording = useCallback(() => {
    if (!recording) return;
    cameraRef.current?.stopRecording();
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
      <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} mode="video" />

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
          onLongPress={startRecording}
          onPressOut={stopRecording}
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
