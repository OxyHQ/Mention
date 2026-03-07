import React from 'react';
import { View, StyleSheet, ViewStyle, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from './ThemedText';
import Avatar from './Avatar';
import { FediverseIcon } from '@/assets/icons/fediverse-icon';

/**
 * ProfileCard Component
 * 
 * A card component for displaying user profiles in lists.
 * Reused from social-app and simplified for Mention's needs.
 */

export interface ProfileCardData {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string | null;
  verified?: boolean;
  description?: string;
  followerCount?: number;
  followingCount?: number;
  isFederated?: boolean;
  instance?: string;
}

interface ProfileCardProps {
  profile: ProfileCardData;
  onPress?: () => void;
  showFollowButton?: boolean;
  style?: ViewStyle;
}

/**
 * Main ProfileCard component
 */
export function ProfileCard({
  profile,
  onPress,
  showFollowButton = false,
  style,
}: ProfileCardProps) {
  const router = useRouter();
  const theme = useTheme();

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else if (profile.isFederated && profile.instance) {
      router.push(`/@${profile.username}@${profile.instance}`);
    } else {
      router.push(`/@${profile.username}`);
    }
  };

  const displayName = profile.displayName || profile.username;

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.7}
      style={[
        styles.outer,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
        },
        style,
      ]}>
      <View style={styles.header}>
        <Avatar
          source={profile.avatar || undefined}
          size={40}
          verified={profile.verified}
        />
        <View style={styles.nameContainer}>
          <ThemedText
            style={styles.name}
            numberOfLines={1}>
            {displayName}
          </ThemedText>
          <View style={styles.handleRow}>
            <ThemedText
              style={[
                styles.handle,
                { color: theme.colors.textSecondary },
              ]}
              numberOfLines={1}>
              @{profile.username}
            </ThemedText>
            {profile.isFederated && (
              <FediverseIcon size={13} color={theme.colors.textSecondary} />
            )}
          </View>
        </View>
        {showFollowButton && (
          <View style={styles.followButtonContainer}>
            {/* Follow button can be added here if needed */}
          </View>
        )}
      </View>
      {profile.description && (
        <View style={styles.description}>
          <ThemedText
            style={[
              styles.descriptionText,
              { color: theme.colors.textSecondary },
            ]}
            numberOfLines={3}>
            {profile.description}
          </ThemedText>
        </View>
      )}
    </TouchableOpacity>
  );
}

/**
 * Outer container
 */
export function ProfileCardOuter({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.outerContainer, style]}>{children}</View>;
}

/**
 * Header section (avatar + name)
 */
export function ProfileCardHeader({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  return <View style={[styles.header, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  outerContainer: {
    width: '100%',
    gap: 8,
  },
  outer: {
    width: '100%',
    padding: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  nameContainer: {
    flex: 1,
    gap: 4,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 20,
  },
  handle: {
    fontSize: 14,
    lineHeight: 18,
  },
  handleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  description: {
    marginTop: 4,
  },
  descriptionText: {
    fontSize: 14,
    lineHeight: 20,
  },
  followButtonContainer: {
    minWidth: 80,
    alignItems: 'flex-end',
  },
});

