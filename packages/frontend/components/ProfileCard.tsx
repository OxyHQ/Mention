import React from 'react';
import { View, StyleSheet, ViewStyle, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { ThemedText } from './ThemedText';
import { Avatar } from '@oxyhq/bloom/avatar';
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
      className="bg-card border-border w-full p-4 rounded-xl gap-3"
      style={[
        { borderWidth: StyleSheet.hairlineWidth },
        style,
      ]}>
      <View className="flex-row items-center gap-3">
        <Avatar
          source={profile.avatar || undefined}
          size={40}
          verified={profile.verified}
        />
        <View className="flex-1 gap-1">
          <ThemedText
            className="text-base font-semibold"
            style={{ lineHeight: 20 }}
            numberOfLines={1}>
            {displayName}
          </ThemedText>
          <View className="flex-row items-center gap-1">
            <ThemedText
              className="text-muted-foreground text-sm"
              style={{ lineHeight: 18 }}
              numberOfLines={1}>
              @{profile.username}
            </ThemedText>
            {profile.isFederated && (
              <FediverseIcon size={13} className="text-muted-foreground" />
            )}
          </View>
        </View>
        {showFollowButton && (
          <View className="items-end" style={{ minWidth: 80 }}>
            {/* Follow button can be added here if needed */}
          </View>
        )}
      </View>
      {profile.description && (
        <View className="mt-1">
          <ThemedText
            className="text-muted-foreground text-sm"
            style={{ lineHeight: 20 }}
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
  return <View className="w-full gap-2" style={style}>{children}</View>;
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
  return <View className="flex-row items-center gap-3" style={style}>{children}</View>;
}
