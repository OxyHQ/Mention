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

const CARD_WIDTH = 180;

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
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.card,
          borderColor: theme.colors.border,
        },
      ]}
      onPress={handlePress}
      activeOpacity={0.7}
    >
      <Pressable
        style={styles.dismissButton}
        onPress={handleDismiss}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="close" size={16} color={theme.colors.textSecondary} />
      </Pressable>

      <Avatar source={user.avatar} size={64} />

      <ThemedText style={[styles.name, { color: theme.colors.text }]} numberOfLines={1}>
        {displayName}
      </ThemedText>

      {user.bio ? (
        <ThemedText
          style={[styles.bio, { color: theme.colors.textSecondary }]}
          numberOfLines={2}
        >
          {user.bio}
        </ThemedText>
      ) : (
        <ThemedText
          style={[styles.bio, { color: theme.colors.textSecondary }]}
          numberOfLines={1}
        >
          @{handle}
        </ThemedText>
      )}

      <View style={styles.followButtonContainer}>
        <FollowButton userId={user.id} size="small" />
      </View>
    </TouchableOpacity>
  );
});

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingTop: 28,
    paddingBottom: 14,
    paddingHorizontal: 12,
    alignItems: 'center',
    ...Platform.select({ web: { cursor: 'pointer' } }),
  },
  dismissButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 1,
    padding: 4,
  },
  name: {
    fontSize: 15,
    fontWeight: '700',
    marginTop: 10,
    textAlign: 'center',
  },
  bio: {
    fontSize: 13,
    lineHeight: 17,
    marginTop: 4,
    textAlign: 'center',
  },
  followButtonContainer: {
    marginTop: 10,
    width: '100%',
    alignItems: 'center',
  },
});

export type { SuggestedUserData };
