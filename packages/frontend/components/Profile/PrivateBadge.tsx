// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { memo } from 'react';
import { View, Text } from 'react-native';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import type { PrivateBadgeProps } from './types';

/**
 * Private profile indicator badge
 * Shows lock icon with privacy level text
 */
export const PrivateBadge = memo(function PrivateBadge({ privacySettings }: PrivateBadgeProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const isFollowersOnly = privacySettings?.profileVisibility === 'followers_only';

  return (
    <View className="flex-row items-center self-start rounded-xl px-1.5 py-0.5 gap-1 mt-1 mb-1 bg-muted">
      <RiLockLine size="xs" fill={theme.colors.textSecondary} />
      <Text className="text-muted-foreground text-xs font-medium">
        {isFollowersOnly ? t('settings.privacy.followersOnly') : t('settings.privacy.private')}
      </Text>
    </View>
  );
});
