import { useCallback, useEffect } from 'react';
import type { AssetUploadStageProgress } from '@oxy.so/core';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useVideoPlayer } from 'expo-video';
import { VideoView } from '@oxy.so/bloom/video-view';

import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import type { LocalCapture } from './useCaptureUpload';
import { Button as LButton, Embed, Text as LText, VStack, toElement } from '@oxy.so/bloom-language';

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
  uploadProgress?: AssetUploadStageProgress | null;
  /** The capture never left the device. */
  uploadFailed: boolean;
  /** Publication could not be confirmed. The capture is still here. */
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
  uploadProgress,
}: CaptureReviewProps) {
  const { t } = useTranslation();
  const percentage =
    uploadProgress && uploadProgress.total > 0
      ? Math.max(0, Math.min(100, Math.floor((uploadProgress.loaded / uploadProgress.total) * 100)))
      : null;
  const progressLabel =
    uploadProgress?.phase === 'hash'
      ? t('camera.preparing')
      : uploadProgress?.phase === 'upload'
        ? t('state.uploading')
        : t('state.processing');
  // A muted loop, like every review screen: this is a still to look at, not
  // playback. `expo-video` is already a dependency and already the app's player.
  const player = useVideoPlayer(capture.kind === 'video' ? capture.uri : null, (instance) => {
    instance.loop = true;
    instance.muted = true;
  });

  // Preparing and transferring a large capture does not need a decoding loop.
  // Resume the review if the operation fails and leaves the capture here.
  useEffect(() => {
    if (busy) player.pause();
    else player.play();
  }, [busy, player]);

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
        {toElement(LText('×').foreground('white').font('24').leading('32px'))}
      </Pressable>
      <View style={styles.actions}>
        {/* Two different failures, and the difference matters to what the reader
            does next: one means the file never left the device, the other means
            it did and no post came of it. Neither loses the capture. */}
        {uploadFailed
          ? toElement(
              LText(
                t('camera.uploadFailed', {
                  defaultValue: "That didn't upload. Check your connection and try again.",
                }),
              )
                .foreground('white')
                .font('16')
                .leading('24px')
                .textAlign('center')
                .margin('bottom', 'md'),
            )
          : null}
        {publishFailed
          ? toElement(
              LText(
                t('camera.publishFailed', {
                  defaultValue:
                    'Could not confirm publication. Check your posts before trying again. Your capture is still here.',
                }),
              )
                .foreground('white')
                .font('16')
                .leading('24px')
                .textAlign('center')
                .margin('bottom', 'md'),
            )
          : null}
        {busy
          ? toElement(
              VStack(
                Embed(<Loading className="text-white" size="sm" />),
                Embed(
                  <Text
                    className="text-white text-base text-center"
                    accessibilityRole="progressbar"
                    accessibilityLabel={progressLabel}
                    accessibilityValue={
                      percentage === null || uploadProgress?.phase === 'verify'
                        ? { text: progressLabel }
                        : { min: 0, max: 100, now: percentage }
                    }
                  >
                    {progressLabel}
                    {percentage !== null && uploadProgress?.phase !== 'verify'
                      ? ` ${percentage}%`
                      : ''}
                  </Text>,
                ),
              )
                .padding('bottom', 'xs')
                .align('center'),
            )
          : null}
        {toElement(
          LButton(LText(t('camera.addText', { defaultValue: 'Add text' })))
            .onPress(onAddText)
            .disabled(busy)
            .style('subtle')
            .tint('neutral')
            .size('lg'),
        )}
        {toElement(
          LButton(LText(t('camera.publish', { defaultValue: 'Post' })))
            .onPress(onPublish)
            .disabled(busy)
            .size('lg'),
        )}
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
