import React, { memo, useState, useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Feed } from '@/components/Feed/index';
import MediaGrid from './MediaGrid';
import VideosGrid from './VideosGrid';
import { feedService } from '@/services/feedService';
import type { FeedType } from '@mention/shared-types';
import type { ProfileTabsProps } from './types';

const PinnedPostItem = React.lazy(() => import('@/components/Feed/PostItem'));

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
  const [pinnedPost, setPinnedPost] = useState<any>(null);

  // Fetch pinned post
  useEffect(() => {
    if (!profileId || (isPrivate && !isOwnProfile)) {
      setPinnedPost(null);
      return;
    }

    let cancelled = false;
    feedService.getPinnedPost(profileId).then((post) => {
      if (!cancelled) setPinnedPost(post);
    });

    return () => { cancelled = true; };
  }, [profileId, isPrivate, isOwnProfile]);

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
    <View>
      {/* Pinned post - only show on posts tab */}
      {tab === 'posts' && pinnedPost && (
        <View>
          <View style={[styles.pinnedLabel, { borderBottomColor: theme.colors.border }]}>
            <Ionicons name="pin" size={14} color={theme.colors.textSecondary} />
            <Text style={[styles.pinnedLabelText, { color: theme.colors.textSecondary }]}>
              {t('profile.pinnedPost', { defaultValue: 'Pinned' })}
            </Text>
          </View>
          <React.Suspense fallback={null}>
            <PinnedPostItem post={pinnedPost} />
          </React.Suspense>
        </View>
      )}
      <Feed
        type={tab as FeedType}
        userId={profileId}
        hideHeader={true}
        scrollEnabled={false}
        contentContainerStyle={styles.feedContent}
      />
    </View>
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
  pinnedLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  pinnedLabelText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
