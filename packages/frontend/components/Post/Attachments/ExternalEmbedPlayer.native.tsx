import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, useWindowDimensions } from 'react-native';
import Animated, {
  measure,
  runOnJS,
  useAnimatedRef,
  useFrameCallback,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { WebView } from 'react-native-webview';
import { getPlayerAspect, type EmbedPlayerParams } from '@/utils/embedPlayer';
import { ExternalEmbedPoster } from './ExternalEmbedPoster';

export interface ExternalEmbedPlayerProps {
  params: EmbedPlayerParams;
  /** Link-preview thumbnail shown before the player is mounted. */
  thumb?: string;
  /** Available render width — used for aspect-ratio resolution. */
  width: number;
  /** Whether the player surface should be mounted (set by the wrapper on play). */
  active: boolean;
  /** Fired when the play button is pressed (the wrapper gates consent). */
  onPressPlay: () => void;
  /** Asks the wrapper to tear the player down (scrolled out of view / blurred). */
  onDeactivate: () => void;
}

/**
 * Native external embed player. The WebView is mounted ONLY while `active`, so
 * nothing external loads before the user presses play (and consent is granted).
 * Playback pauses when the embed scrolls out of the viewport (reanimated frame
 * callback) or when the screen loses focus (navigation away).
 */
export function ExternalEmbedPlayer({
  params,
  thumb,
  width,
  active,
  onPressPlay,
  onDeactivate,
}: ExternalEmbedPlayerProps) {
  const insets = useSafeAreaInsets();
  const windowDims = useWindowDimensions();
  const [loading, setLoading] = useState(true);

  const aspect = useMemo(
    () => getPlayerAspect({ type: params.type, width, hasThumb: !!thumb }),
    [params.type, width, thumb],
  );

  const viewRef = useAnimatedRef<Animated.View>();
  const frameCallback = useFrameCallback(() => {
    const measurement = measure(viewRef);
    if (!measurement) return;

    const { height: winHeight, width: winWidth } = windowDims;
    // Use the larger dimension so the check is orientation-agnostic.
    const realWinHeight = winHeight > winWidth ? winHeight : winWidth;
    const top = measurement.pageY;
    const bot = measurement.pageY + measurement.height;
    const isVisible = top <= realWinHeight - insets.bottom && bot >= insets.top;

    if (!isVisible) {
      runOnJS(onDeactivate)();
    }
  }, false);

  // Drive the visibility frame callback (and reset the loading overlay) only
  // while the player is mounted.
  useEffect(() => {
    if (!active) return;
    setLoading(true);
    frameCallback.setActive(true);
    return () => frameCallback.setActive(false);
  }, [active, frameCallback]);

  // Pause when the screen loses focus so audio/video stops on navigation away.
  useFocusEffect(
    useCallback(() => {
      return () => onDeactivate();
    }, [onDeactivate]),
  );

  // Only load what we requested. YouTube embeds redirect within the
  // youtube-nocookie / youtube.com origins, so allow those for the youtube
  // sources; everything else must match the player URI exactly.
  const onShouldStartLoadWithRequest = useCallback(
    (event: { url: string }) =>
      event.url === params.playerUri ||
      (params.source.startsWith('youtube') &&
        (event.url.includes('youtube-nocookie.com') || event.url.includes('www.youtube.com'))),
    [params.playerUri, params.source],
  );

  return (
    <Animated.View ref={viewRef} collapsable={false} style={[{ width: '100%' }, aspect, styles.surface]}>
      {active ? (
        <WebView
          source={{ uri: params.playerUri }}
          javaScriptEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          setSupportMultipleWindows={false}
          bounces={false}
          nestedScrollEnabled
          onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
          onLoad={() => setLoading(false)}
          style={styles.webview}
        />
      ) : null}
      <ExternalEmbedPoster thumb={thumb} active={active} loading={loading} onPressPlay={onPressPlay} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  surface: { overflow: 'hidden' },
  webview: { backgroundColor: 'transparent' },
});
