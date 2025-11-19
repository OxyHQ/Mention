import React from 'react';
import { View, StyleSheet, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Fill } from './Fill';

/**
 * MediaInsetBorder Component
 * 
 * Applies a thin border within a bounding box. Used to contrast media from
 * the background of the container.
 * Reused from social-app and adapted for Mention's theme system.
 */

interface MediaInsetBorderProps {
  children?: React.ReactNode;
  style?: ViewStyle;
  /**
   * Used where this border needs to match adjacent borders, such as in
   * external link previews
   */
  opaque?: boolean;
}

export function MediaInsetBorder({
  children,
  style,
  opaque,
}: MediaInsetBorderProps) {
  const theme = useTheme();
  const isLight = theme.isLight;

  return (
    <Fill
      style={[
        styles.border,
        {
          borderWidth: Platform.select({
            native: StyleSheet.hairlineWidth,
            web: StyleSheet.hairlineWidth, // Could add high DPI detection if needed
          }),
          borderColor: opaque
            ? theme.colors.border
            : isLight
            ? theme.colors.border
            : theme.colors.borderLight,
          opacity: opaque ? 1 : 0.6,
        },
        style,
      ]}>
      {children}
    </Fill>
  );
}

const styles = StyleSheet.create({
  border: {
    borderRadius: 8,
    pointerEvents: 'none',
  },
});

