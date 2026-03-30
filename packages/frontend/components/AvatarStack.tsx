import React, { useState } from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '@oxyhq/bloom/theme';
import { Avatar } from '@oxyhq/bloom/avatar';

import { ThemedText } from './ThemedText';

/**
 * Avatar Stack Component
 *
 * Displays multiple avatars in a stacked, overlapping layout.
 * Used for showing groups of users (e.g. starter pack members, feed members).
 *
 * Two variants:
 * - AvatarStack: Fixed-size inline variant for cards (pixel-based overlap)
 * - ResponsiveAvatarStack: Full-width responsive variant for hero sections
 *   (percentage-based sizing with "+N" count circle, matching Bluesky's pattern)
 */

export interface AvatarStackProfile {
  id: string;
  avatar?: string | null;
  username?: string;
}

interface AvatarStackProps {
  profiles: AvatarStackProfile[];
  size?: number;
  numPending?: number;
  backgroundColor?: string;
  style?: ViewStyle;
}

/**
 * Fixed-size inline avatar stack for use inside cards.
 * Avatars overlap by 1/3 of their size with z-index stacking.
 */
export function AvatarStack({
  profiles,
  size = 26,
  numPending,
  backgroundColor,
  style,
}: AvatarStackProps) {
  const theme = useTheme();
  const translation = size / 3;

  const isPending = numPending && profiles.length === 0;

  const items = isPending
    ? Array.from({ length: numPending ?? 0 }).map((_, i) => ({
        key: `pending-${i}`,
        profile: null,
      }))
    : profiles.map((item) => ({
        key: item.id || `profile-${item.username}`,
        profile: item,
      }));

  if (items.length === 0) {
    return null;
  }

  return (
    <View
      style={[
        styles.container,
        {
          width: size + (items.length - 1) * (size - translation),
        },
        style,
      ]}>
      {items.map((item, i) => (
        <View
          key={item.key}
          style={[
            styles.avatarContainer,
            {
              width: size,
              height: size,
              left: i * -translation,
              borderWidth: 1,
              borderColor: backgroundColor ?? theme.colors.background,
              zIndex: items.length - i,
            },
          ]}>
          {item.profile ? (
            <Avatar
              source={item.profile.avatar || undefined}
              size={size - 2}
              style={styles.avatar}
            />
          ) : (
            <View
              className="bg-input"
              style={[
                styles.skeleton,
                {
                  width: size - 2,
                  height: size - 2,
                },
              ]}
            />
          )}
        </View>
      ))}
    </View>
  );
}

/**
 * Full-width responsive avatar stack for hero sections (e.g. starter pack detail).
 *
 * Each avatar's size is determined dynamically by container width using percentage widths
 * and onLayout measurement. A trailing circle shows "+N" remaining count.
 *
 * Matches Bluesky's Search/StarterPackCard AvatarStack pattern:
 * - Percentage-based widths with 120% overlap
 * - paddingTop: '100%' for square aspect ratio
 * - "+N" count circle at the end
 */
interface ResponsiveAvatarStackProps {
  /** Avatar URIs to display */
  avatars: string[];
  /** Total number of members (for "+N" calculation) */
  total?: number;
  /** Number of placeholder circles while loading */
  numPending?: number;
  /** Max avatars to show before the "+N" circle */
  maxDisplay?: number;
}

export const ResponsiveAvatarStack = React.memo(function ResponsiveAvatarStack({
  avatars,
  total,
  numPending,
  maxDisplay = 8,
}: ResponsiveAvatarStackProps) {
  const theme = useTheme();
  const [size, setSize] = useState<number | null>(null);

  const displayed = avatars.slice(0, maxDisplay);
  const isPending = numPending !== undefined && numPending > 0 && displayed.length === 0;
  const circleCount = isPending ? numPending : displayed.length;
  const computedTotal = (total ?? circleCount) - circleCount;
  const showCountCircle = computedTotal > 0;
  const totalCircles = circleCount + (showCountCircle ? 1 : 0);

  if (totalCircles === 0) return null;

  const widthPerc = 100 / totalCircles;

  return (
    <View
      style={[
        styles.responsiveContainer,
        { width: `${100 - widthPerc * 0.2}%` as unknown as number },
      ]}>
      {(isPending
        ? Array.from({ length: numPending! }, (_, i) => ({ key: i, uri: null }))
        : displayed.map((uri, i) => ({ key: i, uri }))
      ).map((item, i) => (
        <View
          key={item.key}
          style={{
            width: `${widthPerc}%` as unknown as number,
            zIndex: 100 - i,
          }}>
          <View style={responsiveStyles.avatarOuter}>
            <View
              onLayout={
                i === 0
                  ? (e) => setSize(e.nativeEvent.layout.width)
                  : undefined
              }
              style={[
                responsiveStyles.avatarSquare,
                { backgroundColor: theme.colors.border },
              ]}>
              {size && item.uri ? (
                <View style={StyleSheet.absoluteFill}>
                  <Avatar source={item.uri} size={size} />
                </View>
              ) : (
                <View
                  className="bg-input"
                  style={[StyleSheet.absoluteFill, { borderRadius: 9999 }]}
                />
              )}
            </View>
          </View>
        </View>
      ))}
      {showCountCircle && (
        <View
          style={{
            width: `${widthPerc}%` as unknown as number,
            zIndex: 1,
          }}>
          <View style={responsiveStyles.avatarOuter}>
            <View style={responsiveStyles.avatarSquare}>
              <View
                style={[
                  StyleSheet.absoluteFill,
                  responsiveStyles.countCircle,
                  { backgroundColor: theme.colors.textSecondary },
                ]}>
                <ThemedText
                  style={[responsiveStyles.countText, { color: '#fff' }]}
                  numberOfLines={1}>
                  +{computedTotal}
                </ThemedText>
              </View>
            </View>
          </View>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  avatarContainer: {
    position: 'relative',
    borderRadius: 999,
    backgroundColor: 'transparent',
    overflow: 'hidden',
  },
  avatar: {
    borderRadius: 999,
  },
  skeleton: {
    borderRadius: 999,
  },
  responsiveContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
});

const responsiveStyles = StyleSheet.create({
  avatarOuter: {
    position: 'relative',
    width: '120%' as unknown as number,
  },
  avatarSquare: {
    borderRadius: 9999,
    paddingTop: '100%' as unknown as number,
    overflow: 'hidden',
  },
  countCircle: {
    borderRadius: 9999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 14,
  },
});
