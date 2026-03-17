import React, { memo, useCallback } from 'react';
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
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
    <View className="flex-row flex-wrap mb-3">
      {hasLocation && (
        <View className="flex-row items-center mr-4 mb-1">
          <Ionicons
            name="location-outline"
            size={16}
            color={theme.colors.textSecondary}
          />
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
              <Ionicons
                name="link-outline"
                size={16}
                color={theme.colors.textSecondary}
              />
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
          <Ionicons
            name="calendar-outline"
            size={16}
            color={theme.colors.textSecondary}
          />
          <Text className="text-muted-foreground text-[15px] ml-1">
            {t('profile.joined')} {formatJoinDate(createdAt!)}
          </Text>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={theme.colors.textSecondary}
            style={{ marginLeft: 4 }}
          />
        </TouchableOpacity>
      )}
    </View>
  );
});
