import React, { type ReactNode } from 'react';
import { View, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

/**
 * Skeleton Component
 * 
 * Loading placeholders for content that is being loaded.
 * Reused from social-app and adapted for Mention's theme system.
 */

interface SkeletonProps {
  blend?: boolean;
}

interface TextStyleProp {
  style?: TextStyle;
}

interface ViewStyleProp {
  style?: ViewStyle;
}

/**
 * Skeleton text placeholder
 */
export function SkeletonText({ blend, style }: TextStyleProp & SkeletonProps) {
  const theme = useTheme();

  // Default line height for text
  const lineHeight = (style as any)?.fontSize
    ? ((style as any).fontSize * 1.4) || 14
    : 14;

  return (
    <View
      style={[
        styles.textContainer,
        { maxWidth: (style as any)?.width },
        { paddingVertical: lineHeight * 0.15 },
      ]}>
      <View
        style={[
          styles.textSkeleton,
          {
            backgroundColor: theme.colors.borderLight,
            height: lineHeight * 0.7,
            opacity: blend ? 0.6 : 1,
          },
        ]}
      />
    </View>
  );
}

/**
 * Skeleton circle placeholder (for avatars)
 */
export function SkeletonCircle({
  children,
  size,
  blend,
  style,
}: ViewStyleProp & { children?: ReactNode; size: number } & SkeletonProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.circle,
        {
          width: size,
          height: size,
          backgroundColor: theme.colors.borderLight,
          opacity: blend ? 0.6 : 1,
        },
        style,
      ]}>
      {children}
    </View>
  );
}

/**
 * Skeleton pill placeholder (for buttons, tags)
 */
export function SkeletonPill({
  size,
  blend,
  style,
}: ViewStyleProp & { size: number } & SkeletonProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.pill,
        {
          width: size * 1.618, // Golden ratio for pill shape
          height: size,
          backgroundColor: theme.colors.borderLight,
          opacity: blend ? 0.6 : 1,
        },
        style,
      ]}
    />
  );
}

/**
 * Skeleton column layout
 */
export function SkeletonCol({
  children,
  style,
}: ViewStyleProp & { children?: React.ReactNode }) {
  return <View style={[styles.flex1, style]}>{children}</View>;
}

/**
 * Skeleton row layout
 */
export function SkeletonRow({
  children,
  style,
}: ViewStyleProp & { children?: React.ReactNode }) {
  return <View style={[styles.row, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  textContainer: {
    flex: 1,
  },
  textSkeleton: {
    borderRadius: 6,
  },
  circle: {
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
  },
  pill: {
    borderRadius: 999,
  },
  flex1: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
  },
});

