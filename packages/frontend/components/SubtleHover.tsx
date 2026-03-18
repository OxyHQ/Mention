import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';

/**
 * SubtleHover Component
 *
 * A subtle hover overlay for interactive elements.
 * Uses CSS group-hover via NativeWind — the parent must have className="group".
 * Only renders on web (unless native prop is true). No React state needed.
 */
export function SubtleHover({
  web = true,
  native = false,
}: {
  web?: boolean;
  native?: boolean;
}) {
  const isWeb = Platform.OS === 'web';
  const isNative = Platform.OS !== 'web';

  if (isWeb && !web) return null;
  if (isNative && !native) return null;

  return (
    <View
      className="bg-input opacity-0 group-hover:opacity-40 dark:group-hover:opacity-30 transition-opacity duration-150"
      style={styles.overlay}
    />
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'none',
    zIndex: 0,
  },
});
