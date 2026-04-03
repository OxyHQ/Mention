import React, { memo, useMemo, useCallback } from 'react';
import { View, TouchableOpacity, Pressable, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as OxyServicesNS from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';

import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@oxyhq/bloom/theme';
import { useUserById } from '@/stores/usersStore';
import UserName from '@/components/UserName';

interface SuggestedUserData {
  id: string;
  username?: string;
  name?: { first?: string; last?: string; full?: string };
  avatar?: string;
  bio?: string;
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  instance?: string;
}

interface SuggestedUserCardProps {
  user: SuggestedUserData;
  onDismiss: (id: string) => void;
  hideDismiss?: boolean;
}

const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{
  userId: string;
  size?: 'small' | 'medium' | 'large';
}>;

export const SuggestedUserCard = memo(function SuggestedUserCard({
  user,
  onDismiss,
  hideDismiss,
}: SuggestedUserCardProps) {
  const theme = useTheme();
  const router = useRouter();
  const cachedUser = useUserById(user.id);

  const rawHandle = user.username || user.id;

  // For federated users, the username may already contain the domain (e.g. "user@mastodon.social").
  // Build the full handle without duplicating the domain.
  const hasDomainInHandle = rawHandle.includes('@');
  const handle = hasDomainInHandle ? rawHandle : (user.instance ? `${rawHandle}@${user.instance}` : rawHandle);

  const displayName = useMemo(() => {
    if (user.name?.full) return user.name.full;
    if (user.name?.first) {
      return `${user.name.first} ${user.name.last || ''}`.trim();
    }
    return user.username || 'Unknown';
  }, [user.name?.full, user.name?.first, user.name?.last, user.username]);

  const handlePress = useCallback(() => {
    if (user.isFederated) {
      router.push(`/@${handle}`);
    } else {
      router.push(`/@${rawHandle}`);
    }
  }, [router, rawHandle, handle, user.isFederated]);

  const handleDismiss = useCallback(() => {
    onDismiss(user.id);
  }, [onDismiss, user.id]);

  return (
    <TouchableOpacity
      className="flex-row items-center py-3 px-4 border-b border-border"
      style={Platform.select({ web: { cursor: 'pointer' as any } })}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <Avatar source={user.avatar || cachedUser?.avatar} size={40} />
      <View className="flex-1 ml-3 mr-3">
        <UserName
          name={displayName}
          isFederated={user.isFederated}
          isAgent={user.isAgent}
          isAutomated={user.isAutomated}
          variant="small"
          style={{ name: { fontSize: 15, lineHeight: 20 } }}
        />
        <ThemedText className="text-muted-foreground text-sm" style={{ lineHeight: 18, marginTop: 1 }} numberOfLines={1}>
          @{handle}
        </ThemedText>
        {user.bio ? (
          <ThemedText
            className="text-muted-foreground text-sm mt-1"
            style={{ lineHeight: 18 }}
            numberOfLines={2}
          >
            {user.bio}
          </ThemedText>
        ) : null}
      </View>
      <FollowButton userId={user.id} size="small" />
      {!hideDismiss && (
        <Pressable
          className="p-1 ml-2"
          onPress={handleDismiss}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Ionicons name="close" size={14} color={theme.colors.textSecondary} />
        </Pressable>
      )}
    </TouchableOpacity>
  );
});

export type { SuggestedUserData };
