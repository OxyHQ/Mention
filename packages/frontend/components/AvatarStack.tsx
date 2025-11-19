import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import Avatar from './Avatar';

/**
 * Avatar Stack Component
 * 
 * Displays multiple avatars in a stacked, overlapping layout.
 * Useful for showing groups of users (e.g., "Liked by X, Y, Z").
 * Reused from social-app and adapted for Mention's theme system.
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

export function AvatarStack({
  profiles,
  size = 26,
  numPending,
  backgroundColor,
  style,
}: AvatarStackProps) {
  const theme = useTheme();
  const translation = size / 3; // overlap by 1/3

  // If numPending is provided and we have no profiles yet, show skeleton avatars
  const isPending = numPending && profiles.length === 0;

  const items = isPending
    ? Array.from({ length: numPending ?? 0 }).map((_, i) => ({
        key: `pending-${i}`,
        profile: null,
      }))
    : profiles.map((item) => ({
        key: item.id || `profile-${item.username || Math.random()}`,
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
              style={[
                styles.skeleton,
                {
                  width: size - 2,
                  height: size - 2,
                  backgroundColor: theme.colors.borderLight,
                },
              ]}
            />
          )}
        </View>
      ))}
    </View>
  );
}

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
});

