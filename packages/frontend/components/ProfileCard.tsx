import React from 'react';
import { View, StyleSheet, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { ThemedText } from './ThemedText';
import { Avatar } from '@oxyhq/bloom/avatar';
import { RemoteActorBadge } from '@/components/Fediverse/FediverseBadge';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { displayNameOrHandle } from '@/utils/displayName';
import { cn } from '@/lib/utils';

/**
 * ProfileCard Component
 *
 * A profile row/card for user lists.
 *
 * Two visual languages, picked with `variant`:
 * - `card` (default): a bordered, rounded surface — for grids and standalone slots.
 * - `row`: a flush, full-width feed row (bottom hairline, no radius) — for result
 *   lists that must share ONE visual language with the feed (search, people lists).
 */

export interface ProfileCardData {
  id: string;
  username: string;
  name: {
    displayName?: string;
  };
  avatar?: string | null;
  verified?: boolean;
  description?: string;
  followerCount?: number;
  followingCount?: number;
  isFederated?: boolean;
  instance?: string;
}

export type ProfileCardVariant = 'card' | 'row';

interface ProfileCardProps {
  profile: ProfileCardData;
  onPress?: () => void;
  showFollowButton?: boolean;
  variant?: ProfileCardVariant;
}

/**
 * Main ProfileCard component
 */
export function ProfileCard({
  profile,
  onPress,
  showFollowButton = false,
  variant = 'card',
}: ProfileCardProps) {
  const router = useRouter();
  const isRow = variant === 'row';
  const hasName = !!profile.name?.displayName?.trim();
  // A federated profile's canonical handle carries its instance (`user@domain`),
  // so the row never needs a separate "globe + instance" line.
  const handle = getNormalizedUserHandle(profile) || profile.username;

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else if (handle) {
      router.push(`/@${handle}`);
    }
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      activeOpacity={0.7}
      className={cn(
        'w-full',
        isRow
          ? 'px-3 py-3 gap-2 border-b border-border'
          : 'bg-card border-border p-4 rounded-xl gap-3',
      )}
      style={isRow ? undefined : { borderWidth: StyleSheet.hairlineWidth }}>
      <View className="flex-row items-center gap-3">
        <Avatar
          source={profile.avatar || undefined}
          size={40}
          verified={profile.verified}
        />
        <View className="flex-1 gap-1">
          {/* A real display name is the bold primary with the muted @handle below;
              with no display name the @handle becomes the bold primary, shown
              ONCE (the muted handle line is suppressed). */}
          <ThemedText
            className="text-base font-semibold leading-5"
            numberOfLines={1}>
            {displayNameOrHandle(profile.name.displayName, `@${handle}`)}
          </ThemedText>
          <View className="flex-row items-center gap-1">
            {hasName && (
              <ThemedText
                className="text-muted-foreground text-sm leading-[18px]"
                numberOfLines={1}>
                @{handle}
              </ThemedText>
            )}
            {profile.isFederated && <RemoteActorBadge size={13} />}
          </View>
        </View>
        {showFollowButton && (
          <View className="items-end min-w-[80px]">
            {/* Follow button can be added here if needed */}
          </View>
        )}
      </View>
      {profile.description && (
        <ThemedText
          className={cn('text-muted-foreground text-sm leading-5', !isRow && 'mt-1')}
          numberOfLines={isRow ? 2 : 3}>
          {profile.description}
        </ThemedText>
      )}
    </TouchableOpacity>
  );
}
