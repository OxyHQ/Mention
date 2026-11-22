import { memo } from 'react';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import type { PrivateBadgeProps } from './types';
import { HStack, Icon, RawText, toElement } from '@oxy.so/bloom-language';

/**
 * Private profile indicator badge
 * Shows lock icon with privacy level text
 */
export const PrivateBadge = memo(function PrivateBadge({ privacySettings }: PrivateBadgeProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const isFollowersOnly = privacySettings?.profileVisibility === 'followers_only';

  return toElement(
    HStack(
      Icon(RiLockLine).size('xs').foreground('muted'),
      RawText(isFollowersOnly ? t('settings.privacy.followersOnly') : t('settings.privacy.private'))
        .foreground('muted')
        .font('xs')
        .leading('16px')
        .weight('medium'),
    )
      .padding('horizontal', '6')
      .padding('vertical', '2xs')
      .background('mutedFill')
      .corner('md')
      .align('center')
      .alignSelf('start')
      .spacing('xs')
      .margin('top', 'xs')
      .margin('bottom', 'xs'),
  );
});
