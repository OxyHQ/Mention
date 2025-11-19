import React from 'react';
import { View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface SubtleHoverProps {
  style?: ViewStyle;
  hover: boolean;
  web?: boolean;
  native?: boolean;
}

/**
 * SubtleHover Component
 * 
 * A subtle hover overlay effect for interactive elements.
 * Only renders on web (unless native is true) and when hover is true.
 * Reused from social-app and adapted for Mention's theme system.
 */
export function SubtleHover({
  style,
  hover,
  web = true,
  native = false,
}: SubtleHoverProps) {
  const theme = useTheme();

  // Determine opacity based on theme mode
  const opacity = theme.isDark ? 0.4 : 0.5;

  const isWeb = Platform.OS === 'web';
  const isNative = Platform.OS !== 'web';

  // Only render if conditions are met
  if (isWeb && web && !hover) {
    return null;
  }

  if (isNative && !native) {
    return null;
  }

  if (!hover) {
    return null;
  }

  return (
    <View
      style={[
        styles.overlay,
        {
          backgroundColor: theme.colors.borderLight,
          opacity: hover ? opacity : 0,
        },
        style,
      ]}
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
  },
});

