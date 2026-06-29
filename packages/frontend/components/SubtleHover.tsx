import React from 'react';
import { View, StyleSheet, Platform } from 'react-native';

/**
 * SubtleHover Component
 *
 * A subtle hover overlay for interactive elements.
 *
 * Two modes:
 * - CSS mode (default, `active` undefined): uses CSS `group-hover` via NativeWind
 *   — the parent must have className="group". Per-element hover, no React state.
 * - JS-controlled mode (`active` provided): drives the overlay opacity from the
 *   boolean instead of `group-hover`, so several elements can light up together
 *   (e.g. every post of one thread). Same `bg-input` + opacity + transition.
 *
 * Only renders on web (unless `native` is true). On native, hover doesn't apply.
 */
export function SubtleHover({
  web = true,
  native = false,
  active,
}: {
  web?: boolean;
  native?: boolean;
  active?: boolean;
}) {
  const isWeb = Platform.OS === 'web';
  const isNative = Platform.OS !== 'web';

  if (isWeb && !web) return null;
  if (isNative && !native) return null;

  // Full literal class strings (not concatenated fragments) so NativeWind's
  // compiler picks each variant up.
  const className =
    active === undefined
      ? 'bg-input opacity-0 group-hover:opacity-40 dark:group-hover:opacity-30 transition-opacity duration-150'
      : active
        ? 'bg-input opacity-40 dark:opacity-30 transition-opacity duration-150'
        : 'bg-input opacity-0 transition-opacity duration-150';

  return (
    <View
      className={className}
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
