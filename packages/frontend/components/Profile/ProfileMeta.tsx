import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import type { ProfileMetaProps } from './types';

/**
 * Profile metadata component
 * Displays location, links, and join date
 */
export const ProfileMeta = memo(function ProfileMeta({
  location,
  links,
  createdAt,
  username,
}: ProfileMetaProps) {
  const theme = useTheme();
  const { t } = useTranslation();

  const hasLocation = Boolean(location);
  const hasLinks = links && links.length > 0;
  const hasJoinDate = Boolean(createdAt);

  const formatJoinDate = useCallback((date: string) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });
  }, []);

  if (!hasLocation && !hasLinks && !hasJoinDate) {
    return null;
  }

  return (
    <View style={styles.container}>
      {hasLocation && (
        <View style={styles.metaItem}>
          <Ionicons
            name="location-outline"
            size={16}
            color={theme.colors.textSecondary}
          />
          <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
            {location}
          </Text>
        </View>
      )}

      {hasLinks && (
        <View style={styles.metaItem}>
          <View style={styles.linkIconWrapper}>
            <Ionicons
              name="link-outline"
              size={16}
              color={theme.colors.textSecondary}
            />
          </View>
          <Text style={[styles.metaText, styles.linkText, { color: theme.colors.primary }]}>
            {links[0]}
          </Text>
        </View>
      )}

      {hasJoinDate && (
        <TouchableOpacity
          style={styles.metaItem}
          onPress={() => router.push(`/@${username}/about` as any)}
          activeOpacity={0.7}
        >
          <Ionicons
            name="calendar-outline"
            size={16}
            color={theme.colors.textSecondary}
          />
          <Text style={[styles.metaText, { color: theme.colors.textSecondary }]}>
            {t('profile.joined')} {formatJoinDate(createdAt!)}
          </Text>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={theme.colors.textSecondary}
            style={styles.chevron}
          />
        </TouchableOpacity>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 12,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: 16,
    marginBottom: 4,
  },
  metaText: {
    fontSize: 15,
    marginLeft: 4,
  },
  linkText: {
    textDecorationLine: 'underline',
  },
  linkIconWrapper: {
    transform: [{ rotate: '-45deg' }],
  },
  chevron: {
    marginLeft: 4,
  },
});
















