import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import type { PrivateBadgeProps } from './types';

/**
 * Private profile indicator badge
 * Shows lock icon with privacy level text
 */
export const PrivateBadge = memo(function PrivateBadge({
  privacySettings,
}: PrivateBadgeProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const isFollowersOnly = privacySettings?.profileVisibility === 'followers_only';

  return (
    <View style={styles.container}>
      <Ionicons
        name="lock-closed"
        size={12}
        color={theme.colors.textSecondary}
      />
      <Text style={[styles.text, { color: theme.colors.textSecondary }]}>
        {isFollowersOnly
          ? t('settings.privacy.followersOnly')
          : t('settings.privacy.private')}
      </Text>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 12,
    gap: 4,
    marginTop: 4,
    marginBottom: 4,
  },
  text: {
    fontSize: 12,
    fontWeight: '500',
  },
});
















