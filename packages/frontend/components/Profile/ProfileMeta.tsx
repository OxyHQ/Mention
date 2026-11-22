import { memo, useCallback } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiFlowerLine } from '@oxy.so/bloom/icons/RiFlowerLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import type { ProfileMetaProps } from './types';

import { HStack, Icon, RawText, toElement } from '@oxy.so/bloom-language';

/**
 * Profile metadata component
 * Displays location and join date
 */
export const ProfileMeta = memo(function ProfileMeta({
  location,
  createdAt,
  aboutHref,
}: ProfileMetaProps) {
  const { colors } = useTheme();
  const router = useRouter();
  const { t } = useTranslation();

  const hasLocation = Boolean(location);
  const hasJoinDate = Boolean(createdAt);

  const formatJoinDate = useCallback((date: string) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'long',
      year: 'numeric',
    });
  }, []);

  const openAbout = useCallback(() => {
    if (aboutHref) router.push(aboutHref);
  }, [aboutHref, router]);

  if (!hasLocation && !hasJoinDate) {
    return null;
  }

  return (
    <View className="flex-row flex-wrap mb-3 gap-x-4 gap-y-1">
      {hasLocation &&
        toElement(
          HStack(
            Icon(RiMapPinLine).size('sm').foreground('muted'),
            RawText(location).foreground('muted').font('md'),
          )
            .align('center')
            .spacing('xs'),
        )}
      {createdAt && (
        <TouchableOpacity
          className="flex-row items-center gap-1"
          onPress={openAbout}
          disabled={!aboutHref}
          activeOpacity={0.7}
        >
          {toElement(Icon(RiFlowerLine).size('sm').foreground('muted'))}
          {toElement(
            RawText(t('profile.joined'), ' ', formatJoinDate(createdAt))
              .foreground('muted')
              .font('md'),
          )}
          {aboutHref ? toElement(Icon(RiArrowRightSLine).size('sm').foreground('muted')) : null}
        </TouchableOpacity>
      )}
    </View>
  );
});
