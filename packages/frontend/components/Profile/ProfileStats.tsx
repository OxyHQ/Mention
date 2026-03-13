import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/formatNumber';
import type { ProfileStatsProps } from './types';

/**
 * Profile statistics component
 * Displays following, followers, and posts counts with navigation
 */
export const ProfileStats = memo(function ProfileStats({
  followingCount,
  followerCount,
  postsCount,
  profileUsername,
  username,
  onPostsPress,
}: ProfileStatsProps) {
  const { t } = useTranslation();
  const displayUsername = profileUsername || username;

  const handleFollowingPress = useCallback(() => {
    router.push(`/@${displayUsername}/following` as any);
  }, [displayUsername]);

  const handleFollowersPress = useCallback(() => {
    router.push(`/@${displayUsername}/followers` as any);
  }, [displayUsername]);

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.statItem}
        onPress={handleFollowingPress}
      >
        <Text className="text-foreground" style={styles.statNumber}>
          {formatCompactNumber(followingCount ?? 0)}
        </Text>
        <Text className="text-muted-foreground" style={styles.statLabel}>
          {t('profile.following')}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.statItem}
        onPress={handleFollowersPress}
      >
        <Text className="text-foreground" style={styles.statNumber}>
          {formatCompactNumber(followerCount ?? 0)}
        </Text>
        <Text className="text-muted-foreground" style={styles.statLabel}>
          {t('profile.followers')}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.statItem}
        onPress={onPostsPress}
      >
        <Text className="text-foreground" style={styles.statNumber}>
          {formatCompactNumber(postsCount ?? 0)}
        </Text>
        <Text className="text-muted-foreground" style={styles.statLabel}>
          {t('profile.tabs.posts')}
        </Text>
      </TouchableOpacity>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginBottom: 12,
  },
  statItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 20,
  },
  statNumber: {
    fontSize: 15,
    fontWeight: '700',
    marginRight: 4,
  },
  statLabel: {
    fontSize: 15,
  },
});


