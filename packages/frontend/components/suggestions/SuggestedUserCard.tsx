import React, { memo, useMemo, useCallback } from 'react';
import { View, TouchableOpacity, Pressable, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as OxyServicesNS from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';

interface SuggestedUserData {
  id: string;
  username?: string;
  name?: { first?: string; last?: string; full?: string };
  avatar?: string;
  bio?: string;
}

interface SuggestedUserCardProps {
  user: SuggestedUserData;
  onDismiss: (id: string) => void;
}

const FollowButton = (OxyServicesNS as any).FollowButton as React.ComponentType<{
  userId: string;
  size?: 'small' | 'medium' | 'large';
}>;

export const SuggestedUserCard = memo(function SuggestedUserCard({
  user,
  onDismiss,
}: SuggestedUserCardProps) {
  const theme = useTheme();
  const router = useRouter();

  const handle = user.username || user.id;

  const displayName = useMemo(() => {
    if (user.name?.full) return user.name.full;
    if (user.name?.first) {
      return `${user.name.first} ${user.name.last || ''}`.trim();
    }
    return user.username || 'Unknown';
  }, [user.name?.full, user.name?.first, user.name?.last, user.username]);

  const handlePress = useCallback(() => {
    router.push(`/@${handle}`);
  }, [router, handle]);

  const handleDismiss = useCallback(() => {
    onDismiss(user.id);
  }, [onDismiss, user.id]);

  return (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: theme.colors.border }]}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <Avatar source={user.avatar} size={40} />
      <View style={styles.textColumn}>
        <ThemedText style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
          {displayName}
        </ThemedText>
        <ThemedText style={[styles.handle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
          @{handle}
        </ThemedText>
        {user.bio ? (
          <ThemedText
            style={[styles.bio, { color: theme.colors.textSecondary }]}
            numberOfLines={2}
          >
            {user.bio}
          </ThemedText>
        ) : null}
      </View>
      <FollowButton userId={user.id} size="small" />
      <Pressable
        style={styles.dismissButton}
        onPress={handleDismiss}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="close" size={14} color={theme.colors.textSecondary} />
      </Pressable>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  textColumn: {
    flex: 1,
    marginLeft: 12,
    marginRight: 12,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
    lineHeight: 20,
  },
  handle: {
    fontSize: 14,
    lineHeight: 18,
    marginTop: 1,
  },
  bio: {
    fontSize: 14,
    lineHeight: 18,
    marginTop: 4,
  },
  dismissButton: {
    padding: 4,
    marginLeft: 8,
  },
});

export type { SuggestedUserData };
