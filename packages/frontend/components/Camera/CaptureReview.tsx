import React, { useCallback } from 'react';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useVideoPlayer, VideoView } from 'expo-video';

import { ThemedText } from '@/components/ThemedText';
import { Button } from '@/components/ui/Button';
import { Loading } from '@oxy.so/bloom/loading';
import type { LocalCapture } from './useCaptureUpload';

interface CaptureReviewProps {
  capture: LocalCapture;
  /** Publish it as it is. */
  onPublish: () => void;
  /** Open the composer with it attached. */
  onAddText: () => void;
  /** Throw it away and go back to the viewfinder. */
  onRetake: () => void;
  /** True for the WHOLE of either exit — upload and what follows it. */
  busy: boolean;
  /** The capture never left the device. */
  uploadFailed: boolean;
  /** It uploaded, but no post was created. The capture is still here. */
  publishFailed: boolean;
}

/**
 * What you just captured, and the two ways out of it.
 *
 * BOTH EXITS, rather than one: publishing straight from here is the whole point
 * of a camera that is one swipe from the feed, and the composer is where
 * everything else lives — alt text, a body, a lane, an audience. Choosing for
 * the reader would mean either a camera that always costs a second screen, or a
 * post nobody could add a word to.
 *
 * The upload belongs to whoever owns this screen and happens on the way to
 * EITHER exit, cached by URI, so changing your mind costs nothing.
 */
export function CaptureReview({
  capture,
  onPublish,
  onAddText,
  onRetake,
  busy,
  uploadFailed,
  publishFailed,
}: CaptureReviewProps) {
  const { t } = useTranslation();
  // A muted loop, like every review screen: this is a still to look at, not
  // playback. `expo-video` is already a dependency and already the app's player.
  const player = useVideoPlayer(capture.kind === 'video' ? capture.uri : null, (instance) => {
    instance.loop = true;
    instance.muted = true;
    instance.play();
  });

  const retake = useCallback(() => {
    if (busy) return;
    onRetake();
  }, [busy, onRetake]);

  return (
    <View style={styles.root}>
      {capture.kind === 'video' ? (
        <VideoView player={player} style={StyleSheet.absoluteFill} nativeControls={false} />
      ) : (
        <Image source={{ uri: capture.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      )}

      <Pressable
        onPress={retake}
        style={styles.retake}
        accessibilityRole="button"
        accessibilityLabel={t('camera.retake', { defaultValue: 'Retake' })}
      >
        <ThemedText className="text-white text-2xl">×</ThemedText>
      </Pressable>

      <View style={styles.actions}>
        {/* Two different failures, and the difference matters to what the reader
            does next: one means the file never left the device, the other means
            it did and no post came of it. Neither loses the capture. */}
        {uploadFailed ? (
          <ThemedText className="text-white text-center mb-3">
            {t('camera.uploadFailed', {
              defaultValue: "That didn't upload. Check your connection and try again.",
            })}
          </ThemedText>
        ) : null}
        {publishFailed ? (
          <ThemedText className="text-white text-center mb-3">
            {t('camera.publishFailed', {
              defaultValue: "That didn't post. Your capture is still here — try again.",
            })}
          </ThemedText>
        ) : null}
        {busy ? (
          <View style={styles.busy}>
            <Loading className="text-white" size="small" />
          </View>
        ) : null}
        <Button onPress={onAddText} disabled={busy} variant="secondary">
          {t('camera.addText', { defaultValue: 'Add text' })}
        </Button>
        <Button onPress={onPublish} disabled={busy}>
          {t('camera.publish', { defaultValue: 'Post' })}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  retake: { position: 'absolute', top: 56, left: 20, padding: 12 },
  actions: {
    position: 'absolute',
    left: 20,
    right: 20,
    bottom: 48,
    gap: 12,
  },
  busy: { alignItems: 'center', paddingBottom: 4 },
});
