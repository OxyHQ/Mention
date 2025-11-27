import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Feed } from '@/components/Feed/index';
import MediaGrid from './MediaGrid';
import VideosGrid from './VideosGrid';
import type { FeedType } from '@mention/shared-types';
import type { ProfileTabsProps } from './types';

/**
 * Profile tab content switcher
 * Renders appropriate content based on selected tab
 */
export const ProfileTabs = memo(function ProfileTabs({
  tab,
  profileId,
  isPrivate,
  isOwnProfile,
}: ProfileTabsProps) {
  const theme = useTheme();
  const { t } = useTranslation();

  // Show private message for restricted profiles
  if (isPrivate && !isOwnProfile) {
    return (
      <View style={styles.privateContainer}>
        <Ionicons
          name="lock-closed"
          size={48}
          color={theme.colors.textSecondary}
          style={styles.lockIcon}
        />
        <Text style={[styles.privateMessage, { color: theme.colors.text }]}>
          {t('profile.private.message', { defaultValue: 'This profile is private' })}
        </Text>
        <Text style={[styles.privateSubtext, { color: theme.colors.textSecondary }]}>
          {t('profile.private.subtext', { defaultValue: 'Follow this account to see their posts' })}
        </Text>
      </View>
    );
  }

  // Media grid
  if (tab === 'media') {
    return (
      <MediaGrid
        userId={profileId}
        isPrivate={isPrivate}
        isOwnProfile={isOwnProfile}
      />
    );
  }

  // Videos grid
  if (tab === 'videos') {
    return (
      <VideosGrid
        userId={profileId}
        isPrivate={isPrivate}
        isOwnProfile={isOwnProfile}
      />
    );
  }

  // Feed for posts, replies, likes, reposts
  return (
    <Feed
      type={tab as FeedType}
      userId={profileId}
      hideHeader={true}
      scrollEnabled={false}
      contentContainerStyle={styles.feedContent}
    />
  );
});

const styles = StyleSheet.create({
  privateContainer: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 200,
  },
  lockIcon: {
    marginBottom: 16,
  },
  privateMessage: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 8,
  },
  privateSubtext: {
    fontSize: 14,
    textAlign: 'center',
  },
  feedContent: {
    paddingBottom: 100,
  },
});




