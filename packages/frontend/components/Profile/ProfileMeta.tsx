import { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiArrowRightSLine } from '@oxy.so/bloom/icons/RiArrowRightSLine';
import { RiFlowerLine } from '@oxy.so/bloom/icons/RiFlowerLine';
import { RiMapPinLine } from '@oxy.so/bloom/icons/RiMapPinLine';
import type { ProfileMetaProps } from './types';

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
      {hasLocation && (
        <View className="flex-row items-center gap-1">
          <RiMapPinLine width={16} height={16} fill={colors.textSecondary} />
          <Text className="text-muted-foreground text-[15px]">{location}</Text>
        </View>
      )}

      {createdAt && (
        <TouchableOpacity
          className="flex-row items-center gap-1"
          onPress={openAbout}
          disabled={!aboutHref}
          activeOpacity={0.7}
        >
          <RiFlowerLine width={16} height={16} fill={colors.textSecondary} />
          <Text className="text-muted-foreground text-[15px]">
            {t('profile.joined')} {formatJoinDate(createdAt)}
          </Text>
          {aboutHref ? (
            <RiArrowRightSLine width={16} height={16} fill={colors.textSecondary} />
          ) : null}
        </TouchableOpacity>
      )}
    </View>
  );
});
