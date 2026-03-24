import React, { memo, useState, useEffect } from 'react';
import { View, Text, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { Feed } from '@/components/Feed/index';
import MediaGrid from './MediaGrid';
import VideosGrid from './VideosGrid';
import { FeedCard, type FeedCardData } from '@/components/FeedCard';
import { StarterPackCard, StarterPackCardSkeleton, type StarterPackCardData } from '@/components/StarterPackCard';
import { feedService } from '@/services/feedService';
import { customFeedsService } from '@/services/customFeedsService';
import { ListCard, type ListCardData } from '@/components/ListCard';
import { starterPacksService } from '@/services/starterPacksService';
import { listsService } from '@/services/listsService';
import type { FeedType } from '@mention/shared-types';
import type { ProfileTabsProps } from './types';
import { logger } from '@/lib/logger';

const PinnedPostItem = React.lazy(() => import('@/components/Feed/PostItem'));

/**
 * Profile tab content switcher
 * Renders appropriate content based on selected tab.
 * Both native and federated profiles use the same Feed component.
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

  // Fetch pinned post once per profile (local profiles only)
  useEffect(() => {
    if (isFederated || !profileId || (isPrivate && !isOwnProfile)) {
      setPinnedPost(null);
      return;
    }

    let cancelled = false;
    feedService.getPinnedPost(profileId)
      .then((post) => { if (!cancelled) setPinnedPost(post); })
      .catch((err) => {
        logger.warn('[ProfileTabs] Failed to load pinned post', err);
        if (!cancelled) setPinnedPost(null);
      });

    return () => { cancelled = true; };
  }, [profileId, isPrivate, isOwnProfile, isFederated]);

  // Don't render feed content without a valid profile identifier
  if (!profileId && !actorUri) {
    return null;
  }

  // Show private message for restricted profiles
  if (isPrivate && !isOwnProfile) {
    return (
      <View className="items-center justify-center p-8" style={{ minHeight: 200 }}>
        <Ionicons
          name="lock-closed"
          size={48}
          color={theme.colors.textSecondary}
          style={{ marginBottom: 16 }}
        />
        <Text className="text-foreground text-lg font-semibold text-center mb-2">
          {t('profile.private.message', { defaultValue: 'This profile is private' })}
        </Text>
        <Text className="text-muted-foreground text-sm text-center">
          {t('profile.private.subtext', { defaultValue: 'Follow this account to see their posts' })}
        </Text>
      </View>
    );
  }

  // Starter Packs tab (local profiles only)
  if (tab === 'starter_packs' && !isFederated) {
    return (
      <ProfileStarterPacks
        profileId={profileId}
        isOwnProfile={isOwnProfile}
      />
    );
  }

  // Lists tab (local profiles only)
  if (tab === 'lists' && !isFederated) {
    return (
      <ProfileLists
        profileId={profileId}
        isOwnProfile={isOwnProfile}
      />
    );
  }

  // Feeds tab (local profiles only)
  if (tab === 'feeds' && !isFederated) {
    return (
      <ProfileFeeds
        profileId={profileId}
        isOwnProfile={isOwnProfile}
      />
    );
  }

  // Media grid (local profiles only)
  if (tab === 'media' && !isFederated) {
    return (
      <MediaGrid
        userId={profileId}
        isPrivate={isPrivate}
        isOwnProfile={isOwnProfile}
      />
    );
  }

  // Videos grid (local profiles only)
  if (tab === 'videos' && !isFederated) {
    return (
      <VideosGrid
        userId={profileId}
        isPrivate={isPrivate}
        isOwnProfile={isOwnProfile}
      />
    );
  }

  // Unified feed for posts, replies, likes, reposts — works for both native and federated
  return (
    <View>
      {/* Pinned post - only show on posts tab for local profiles */}
      {!isFederated && tab === 'posts' && pinnedPost && (
        <React.Suspense fallback={null}>
          <PinnedPostItem post={pinnedPost} showPinned />
        </React.Suspense>
      )}
      <Feed
        type={(isFederated ? 'posts' : tab) as FeedType}
        userId={profileId}
        hideHeader={true}
        scrollEnabled={false}
        contentContainerStyle={{ paddingBottom: 100 }}
      />
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
        logger.warn('Failed to load profile feeds');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchFeeds();

    return () => { cancelled = true; };
  }, [profileId, isOwnProfile]);

  if (loading) {
    return (
      <View className="items-center justify-center p-8">
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
    );
  }

  if (feeds.length === 0) {
    return (
      <View className="items-center justify-center p-8 gap-3" style={{ minHeight: 200 }}>
        <Ionicons name="layers-outline" size={48} color={theme.colors.textSecondary} />
        <Text className="text-muted-foreground text-base font-medium">
          {t('profile.feeds.empty', { defaultValue: 'No feeds yet' })}
        </Text>
      </View>
    );
  }

  return (
    <View className="p-4 gap-3">
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

const ProfileStarterPacks = memo(function ProfileStarterPacks({
  profileId,
  isOwnProfile,
}: {
  profileId?: string;
  isOwnProfile: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [packs, setPacks] = useState<StarterPackCardData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;

    const fetchPacks = async () => {
      try {
        const params = isOwnProfile ? { mine: true } : { userId: profileId };
        const res = await starterPacksService.list(params);
        if (!cancelled) {
          const items: StarterPackCardData[] = (res.items || []).map((pack: Record<string, unknown>) => {
            const memberIds = (pack.memberOxyUserIds || []) as string[];
            return {
              id: String(pack._id || pack.id),
              name: (pack.name as string) || 'Untitled Pack',
              description: pack.description as string | undefined,
              creator: (pack.creator || pack.owner) as StarterPackCardData['creator'],
              memberCount: memberIds.length,
              useCount: (pack.useCount as number) || 0,
              memberAvatars: (pack.memberAvatars || []) as string[],
              totalMembers: memberIds.length,
            };
          });
          setPacks(items);
        }
      } catch (e) {
        logger.warn('Failed to load profile starter packs');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchPacks();

    return () => { cancelled = true; };
  }, [profileId, isOwnProfile]);

  if (loading) {
    return (
      <View className="p-4 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <StarterPackCardSkeleton key={i} />
        ))}
      </View>
    );
  }

  if (packs.length === 0) {
    return (
      <View className="items-center justify-center p-8 gap-3" style={{ minHeight: 200 }}>
        <Ionicons name="rocket-outline" size={48} color={theme.colors.textSecondary} />
        <Text className="text-muted-foreground text-base font-medium">
          {t('profile.starterPacks.empty', { defaultValue: 'No starter packs yet' })}
        </Text>
      </View>
    );
  }

  return (
    <View className="p-4 gap-3">
      {packs.map((pack) => (
        <StarterPackCard
          key={pack.id}
          pack={pack}
          onPress={() => router.push(`/starter-packs/${pack.id}`)}
        />
      ))}
    </View>
  );
});

const ProfileLists = memo(function ProfileLists({
  profileId,
  isOwnProfile,
}: {
  profileId?: string;
  isOwnProfile: boolean;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [lists, setLists] = useState<ListCardData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;

    const fetchLists = async () => {
      try {
        const params = isOwnProfile ? { mine: true } : { userId: profileId };
        const res = await listsService.list(params);
        if (!cancelled) {
          const items: ListCardData[] = (res.items || []).map((l: Record<string, unknown>) => {
            const listId = String(l._id || l.id);
            const owner = (l.owner || l.createdBy || l.creator) as Record<string, string> | undefined;
            return {
              id: listId,
              uri: (l.uri as string) || `list:${listId}`,
              name: (l.title as string) || 'Untitled List',
              description: l.description as string | undefined,
              avatar: l.avatar as string | undefined,
              creator: owner
                ? {
                    username: owner.username || '',
                    displayName: owner.displayName,
                    avatar: owner.avatar,
                  }
                : undefined,
              purpose: (l.purpose as string) || 'curatelist',
              itemCount: ((l.memberOxyUserIds || []) as string[]).length,
            };
          });
          setLists(items);
        }
      } catch (e) {
        logger.warn('Failed to load profile lists');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    fetchLists();

    return () => { cancelled = true; };
  }, [profileId, isOwnProfile]);

  if (loading) {
    return (
      <View className="items-center justify-center p-8">
        <ActivityIndicator size="small" color={theme.colors.primary} />
      </View>
    );
  }

  if (lists.length === 0) {
    return (
      <View className="items-center justify-center p-8 gap-3" style={{ minHeight: 200 }}>
        <Ionicons name="list-outline" size={48} color={theme.colors.textSecondary} />
        <Text className="text-muted-foreground text-base font-medium">
          {t('profile.lists.empty', { defaultValue: 'No lists yet' })}
        </Text>
      </View>
    );
  }

  return (
    <View className="p-4 gap-3">
      {lists.map((list) => (
        <ListCard
          key={list.id}
          list={list}
          onPress={() => router.push(`/lists/${list.id}`)}
        />
      ))}
    </View>
  );
});
