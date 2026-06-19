import React, { memo, useCallback } from 'react';
import { View, TouchableOpacity, Pressable, Platform, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { FollowButton } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';

import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@oxyhq/bloom/theme';
import { useUserById } from '@/hooks/useCachedUser';
import UserName from '@/components/UserName';
import { getNormalizedUserHandle } from '@oxyhq/core';

interface SuggestedUserData {
  id: string;
  username?: string;
  displayName: string;
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

export const SuggestedUserCard = memo(function SuggestedUserCard({
  user,
  onDismiss,
  hideDismiss,
}: SuggestedUserCardProps) {
  const theme = useTheme();
  const router = useRouter();
  const cachedUser = useUserById(user.id);

  const handle = getNormalizedUserHandle(user);

  const handlePress = useCallback(() => {
    if (handle) {
      router.push(`/@${handle}`);
    }
  }, [router, handle]);

  const handleDismiss = useCallback(() => {
    onDismiss(user.id);
  }, [onDismiss, user.id]);

  return (
    <TouchableOpacity
      className="flex-row items-center py-3 px-4 border-b border-border"
      style={Platform.select({ web: styles.webCursor })}
      onPress={handlePress}
      disabled={!handle}
      activeOpacity={0.7}
    >
      <Avatar source={user.avatar || cachedUser?.avatar} size={40} />
      <View className="flex-1 ml-3 mr-3">
        <UserName
          name={user.displayName}
          isFederated={user.isFederated}
          isAgent={user.isAgent}
          isAutomated={user.isAutomated}
          variant="small"
          style={{ name: { fontSize: 15, lineHeight: 20 } }}
        />
        <ThemedText className="text-muted-foreground text-sm" style={{ lineHeight: 18, marginTop: 1 }} numberOfLines={1}>
          {handle ? `@${handle}` : '@unknown'}
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

const styles = StyleSheet.create({
  webCursor: {
    cursor: 'pointer',
  },
});
