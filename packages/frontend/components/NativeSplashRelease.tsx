import { useCallback, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { hideNativeSplash } from '@oxy.so/expo-splash';

/**
 * The ONE place the held native OS splash is released (native only).
 *
 * Rendered as the last child of the route tree, inside every provider gate
 * (Bloom's font gate, the app providers, the account boundary), so it mounts in
 * the same commit as the first real screen — or as the visible boot fallback
 * `AuthRouter` draws while the session resolves. Its first layout is the signal:
 * the splash is hidden from that `onLayout`, Expo's documented handoff
 * (`hideAsync` from the root view's `onLayout`). The layout has already happened
 * natively, so the screen is there to uncover. Waiting for a JS frame first
 * cost about 1 s of cold start (Pixel 8a, release): the frame callback queued
 * behind the startup renders still running on the JS thread, while the screen
 * with the first posts from disk was already mounted under the splash.
 *
 * Nothing else hides the splash. It used to be hidden as soon as the startup
 * tasks settled — by `AppInitializer` and again by the root layout's
 * `appIsReady` effect — before Bloom or the providers had mounted anything, so a
 * fast start (no permission read, warm storage) could uncover a frame with no
 * UI behind it. Tying the release to the route tree's own layout makes the
 * startup tasks' speed irrelevant to what the reader sees.
 *
 * A gate that never opens keeps the splash up rather than uncovering an empty
 * screen. Re-mounts after the first release are no-ops.
 */
export function NativeSplashRelease() {
  const released = useRef(false);
  const onLayout = useCallback(() => {
    if (released.current) return;
    released.current = true;
    hideNativeSplash();
  }, []);
  return <View pointerEvents="none" style={styles.marker} onLayout={onLayout} />;
}

const styles = StyleSheet.create({
  marker: { position: 'absolute', width: 0, height: 0 },
});
