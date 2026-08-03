import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { LocationIcon } from '@/assets/icons/location-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
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
  }, [aboutHref]);

  if (!hasLocation && !hasJoinDate) {
    return null;
  }

  return (
    <View className="flex-row flex-wrap mb-3 gap-x-4 gap-y-1">
      {hasLocation && (
        <View className="flex-row items-center gap-1">
          <LocationIcon size={16} className="text-muted-foreground" />
          <Text className="text-muted-foreground text-[15px]">
            {location}
          </Text>
        </View>
      )}

      {createdAt && (
        <TouchableOpacity
          className="flex-row items-center gap-1"
          onPress={openAbout}
          disabled={!aboutHref}
          activeOpacity={0.7}
        >
          <CalendarIcon size={16} className="text-muted-foreground" />
          <Text className="text-muted-foreground text-[15px]">
            {t('profile.joined')} {formatJoinDate(createdAt)}
          </Text>
          {aboutHref ? <ChevronRightIcon size={16} className="text-muted-foreground" /> : null}
        </TouchableOpacity>
      )}
    </View>
  );
});
