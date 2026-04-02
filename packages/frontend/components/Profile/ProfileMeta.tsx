import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { LocationIcon } from '@/assets/icons/location-icon';
import { LinkIcon } from '@/assets/icons/link-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
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
    <View className="flex-row flex-wrap mb-3">
      {hasLocation && (
        <View className="flex-row items-center mr-4 mb-1">
          <LocationIcon size={16} className="text-muted-foreground" />
          <Text className="text-muted-foreground text-[15px] ml-1">
            {location}
          </Text>
        </View>
      )}

      {hasLinks && links!.map((link, index) => {
        const href = link.startsWith('http') ? link : `https://${link}`;
        const displayText = link.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
        return (
          <TouchableOpacity
            key={index}
            className="flex-row items-center mr-4 mb-1"
            onPress={() => Linking.openURL(href)}
            activeOpacity={0.7}
          >
            <View style={{ transform: [{ rotate: '-45deg' }] }}>
              <LinkIcon size={16} className="text-muted-foreground" />
            </View>
            <Text className="text-primary text-[15px] ml-1 underline">
              {displayText}
            </Text>
          </TouchableOpacity>
        );
      })}

      {hasJoinDate && (
        <TouchableOpacity
          className="flex-row items-center mr-4 mb-1"
          onPress={() => router.push(`/@${username}/about` as any)}
          activeOpacity={0.7}
        >
          <CalendarIcon size={16} className="text-muted-foreground" />
          <Text className="text-muted-foreground text-[15px] ml-1">
            {t('profile.joined')} {formatJoinDate(createdAt!)}
          </Text>
          <ChevronRightIcon size={16} className="text-muted-foreground" style={{ marginLeft: 4 }} />
        </TouchableOpacity>
      )}
    </View>
  );
});
