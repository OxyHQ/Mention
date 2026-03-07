import React, { memo, useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Feed } from '@/components/Feed/index';
import PostItem from '@/components/Feed/PostItem';
import MediaGrid from './MediaGrid';
import VideosGrid from './VideosGrid';
import { FeedCard, type FeedCardData } from '@/components/FeedCard';
import { feedService } from '@/services/feedService';
import { customFeedsService } from '@/services/customFeedsService';
import { federationService } from '@/services/federationService';
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
  isFederated,
  actorUri,
}: ProfileTabsProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [pinnedPost, setPinnedPost] = useState<any>(null);

  // Fetch pinned post (local profiles only)
  useEffect(() => {
    if (isFederated || !profileId || (isPrivate && !isOwnProfile)) {
      setPinnedPost(null);
      return;
    }

    let cancelled = false;
    feedService.getPinnedPost(profileId).then((post) => {
      if (!cancelled) setPinnedPost(post);
    });

    return () => { cancelled = true; };
  }, [profileId, isPrivate, isOwnProfile, isFederated]);

  // Federated posts
  if (isFederated && actorUri) {
    return <FederatedPosts actorUri={actorUri} />;
  }

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

  // Feeds tab
  if (tab === 'feeds') {
    return (
      <ProfileFeeds
        profileId={profileId}
        isOwnProfile={isOwnProfile}
      />
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
        <React.Suspense fallback={null}>
          <PinnedPostItem post={pinnedPost} showPinned />
        </React.Suspense>
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

/**
 * Federated posts component - fetches posts from a remote ActivityPub actor
 */
const FederatedPosts = memo(function FederatedPosts({ actorUri }: { actorUri: string }) {
  const theme = useTheme();
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    federationService.getActorPosts(actorUri).then((data) => {
      if (!cancelled) {
        setPosts(data.posts);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, [actorUri]);

  if (loading) {
    return (
      <View style={styles.feedsLoading}>
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
    );
  }

  if (posts.length === 0) {
    return (
      <View style={styles.feedsEmpty}>
        <Text style={{ color: theme.colors.textSecondary, fontSize: 15 }}>
          No posts available
        </Text>
      </View>
    );
  }

  return (
    <View>
      {posts.map((post) => (
        <PostItem key={post._id || post.id} post={post} />
      ))}
    </View>
  );
});

interface ProfileFeedItem {
  id?: string;
  _id?: string;
  title?: string;
  description?: string;
  memberCount?: number;
  topicCount?: number;
  memberOxyUserIds?: string[];
  keywords?: string[];
  memberAvatars?: string[];
  owner?: { username: string; displayName?: string; avatar?: string };
  likeCount?: number;
}

const ProfileFeeds = memo(function ProfileFeeds({
  profileId,
  isOwnProfile,
}: {
  profileId?: string;
  isOwnProfile: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [feeds, setFeeds] = useState<ProfileFeedItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;

    const fetchFeeds = async () => {
      try {
        const params = isOwnProfile
          ? { mine: true }
          : { userId: profileId };
        const res = await customFeedsService.list(params);
        if (!cancelled) setFeeds(res.items || []);
      } catch (e) {
        console.warn('Failed to load profile feeds', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchFeeds();

    return () => { cancelled = true; };
  }, [profileId, isOwnProfile]);

  if (loading) {
    return (
      <View style={styles.feedsLoading}>
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
    );
  }

  if (feeds.length === 0) {
    return (
      <View style={styles.feedsEmpty}>
        <Ionicons name="layers-outline" size={48} color={theme.colors.textSecondary} />
        <Text style={[styles.feedsEmptyText, { color: theme.colors.textSecondary }]}>
          {t('profile.feeds.empty', { defaultValue: 'No feeds yet' })}
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.feedsList}>
      {feeds.map((feed) => (
        <FeedCard
          key={feed.id || feed._id}
          feed={{
            id: String(feed.id || feed._id),
            displayName: feed.title || 'Untitled',
            description: feed.description,
            memberCount: feed.memberCount ?? (feed.memberOxyUserIds || []).length,
            topicCount: feed.topicCount ?? (feed.keywords || []).length,
            memberAvatars: feed.memberAvatars || [],
            creator: feed.owner,
            likeCount: feed.likeCount,
          }}
        />
      ))}
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
  feedsLoading: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedsEmpty: {
    padding: 32,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 200,
    gap: 12,
  },
  feedsEmptyText: {
    fontSize: 16,
    fontWeight: '500',
  },
  feedsList: {
    padding: 16,
    gap: 12,
  },
});
