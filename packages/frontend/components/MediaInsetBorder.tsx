import React from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { Fill } from '@oxyhq/bloom/fill';

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

  const fillStyle: ViewStyle[] = [
    styles.border,
    {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: opaque
        ? theme.colors.border
        : isLight
          ? theme.colors.border
          : theme.colors.borderLight,
      opacity: opaque ? 1 : 0.6,
    },
  ];
  if (style) {
    fillStyle.push(style);
  }

  return <Fill style={fillStyle}>{children}</Fill>;
}

const styles = StyleSheet.create({
  border: {
    borderRadius: 8,
    pointerEvents: 'none',
  },
});

