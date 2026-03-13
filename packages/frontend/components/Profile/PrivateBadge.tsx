import React, { memo } from 'react';
import { View, Text } from 'react-native';
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
    <View className="flex-row items-center self-start rounded-xl px-1.5 py-0.5 gap-1 mt-1 mb-1" style={{ backgroundColor: 'rgba(255, 255, 255, 0.1)' }}>
      <Ionicons
        name="lock-closed"
        size={12}
        color={theme.colors.textSecondary}
      />
      <Text className="text-muted-foreground text-xs font-medium">
        {isFollowersOnly
          ? t('settings.privacy.followersOnly')
          : t('settings.privacy.private')}
      </Text>
    </View>
  );
});
