import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
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
  const theme = useTheme();
  const { t } = useTranslation();
  const displayUsername = profileUsername || username;

  return (
    <View style={styles.container}>
      <TouchableOpacity
        style={styles.statItem}
        onPress={() => router.push(`/@${displayUsername}/following` as any)}
      >
        <Text style={[styles.statNumber, { color: theme.colors.text }]}>
          {formatCompactNumber(followingCount ?? 0)}
        </Text>
        <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
          {t('profile.following')}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.statItem}
        onPress={() => router.push(`/@${displayUsername}/followers` as any)}
      >
        <Text style={[styles.statNumber, { color: theme.colors.text }]}>
          {formatCompactNumber(followerCount ?? 0)}
        </Text>
        <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
          {t('profile.followers')}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.statItem}
        onPress={onPostsPress}
      >
        <Text style={[styles.statNumber, { color: theme.colors.text }]}>
          {formatCompactNumber(postsCount ?? 0)}
        </Text>
        <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>
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


