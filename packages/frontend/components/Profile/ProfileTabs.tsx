import React, { memo } from 'react';
import { View, Text, Platform } from 'react-native';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery } from '@tanstack/react-query';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services/ui/client';
import { Spinner } from '@/components/ui/Spinner';
import { Feed } from '@/components/Feed/index';
import MediaGrid from './MediaGrid';
import VideosGrid from './VideosGrid';
import { FeedCard } from '@/components/FeedCard';
import { StarterPackCard, StarterPackCardSkeleton, type StarterPackCardData } from '@/components/StarterPackCard';
import { feedService } from '@/services/feedService';
import { customFeedsService } from '@/services/customFeedsService';
import { ListCard, type ListCardData } from '@/components/ListCard';
import { starterPacksService } from '@/services/starterPacksService';
import { listsService } from '@/services/listsService';
import type { FeedType, HydratedPost } from '@mention/shared-types';
import type { ProfileTabsProps } from './types';
import { logger } from '@oxyhq/core/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { StarterPackIcon } from '@/assets/icons/starter-pack-icon';

const IS_WEB = Platform.OS === 'web';

const PinnedPostItem = React.lazy(() => import('@/components/Feed/PostItem'));

interface ProfileTabsRuntimeProps extends ProfileTabsProps {
  /**
   * Native post and grid tabs hand their profile summary to the owning
   * FlashList as its normal header and the tab selector as a separate sticky
   * data row. This removes the parent ScrollView + non-scrolling-list
   * composition without pinning the entire profile summary.
   */
  listHeaderComponent?: React.ReactElement | null;
  listStickyHeaderComponent?: React.ReactElement | null;
  listOwnsScroll?: boolean;
  listContentContainerStyle?: React.ComponentProps<typeof View>['style'];
  listOnScroll?: React.ComponentProps<typeof MediaGrid>['onScroll'];
  listScrollRef?: React.ComponentProps<typeof MediaGrid>['scrollRef'];
}

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
  actorUri,
  listHeaderComponent,
  listStickyHeaderComponent,
  listOwnsScroll = false,
  listContentContainerStyle,
  listOnScroll,
  listScrollRef,
}: ProfileTabsRuntimeProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { user } = useAuth();

  // Pinned post lives in React Query so pin/unpin can invalidate it
  // (see usePostActions) and the post re-sorts without a profile remount.
  // Only the posts tab renders the pinned post (see below), so the query is
  // gated to `tab === 'posts'` — otherwise every profile tab fired this fetch.
  // Pin/unpin still invalidates correctly because pinning happens from the
  // posts tab, where this query is enabled.
  const pinnedPostQuery = useQuery<HydratedPost | null>({
    queryKey: viewerQueryKeys.pinnedPost(user?.id, profileId ?? ''),
    queryFn: () => feedService.getPinnedPost(profileId as string),
    enabled: tab === 'posts' && Boolean(profileId) && !(isPrivate && !isOwnProfile),
  });
  const pinnedPost = pinnedPostQuery.data ?? null;

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

  // Starter Packs tab
  if (tab === 'starter_packs') {
    return (
      <ProfileStarterPacks
        profileId={profileId}
        isOwnProfile={isOwnProfile}
        viewerId={user?.id}
      />
    );
  }

  // Lists tab
  if (tab === 'lists') {
    return (
      <ProfileLists
        profileId={profileId}
        isOwnProfile={isOwnProfile}
        viewerId={user?.id}
      />
    );
  }

  // Feeds tab
  if (tab === 'feeds') {
    return (
      <ProfileFeeds
        profileId={profileId}
        isOwnProfile={isOwnProfile}
        viewerId={user?.id}
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
        ownsScroll={listOwnsScroll}
        listHeaderComponent={listHeaderComponent}
        listStickyHeaderComponent={listStickyHeaderComponent}
        contentContainerStyle={listContentContainerStyle}
        onScroll={listOnScroll}
        scrollRef={listScrollRef}
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
        ownsScroll={listOwnsScroll}
        listHeaderComponent={listHeaderComponent}
        listStickyHeaderComponent={listStickyHeaderComponent}
        contentContainerStyle={listContentContainerStyle}
        onScroll={listOnScroll}
        scrollRef={listScrollRef}
      />
    );
  }

  // Unified feed for posts, replies, likes, boosts — works for both native and federated.
  //
  // WEB keeps document virtualization and the existing sticky profile chrome.
  // NATIVE hands profile summary + tabs + pinned post to the Feed's FlashList
  // header, so FlashList is the single vertical scroll owner and its mounted row
  // count remains bounded. The legacy non-scrolling Feed fallback stays only for
  // callers that have not opted into feed ownership.
  const pinnedPostElement = tab === 'posts' && pinnedPost ? (
    <React.Suspense fallback={null}>
      <PinnedPostItem post={pinnedPost} showPinned />
    </React.Suspense>
  ) : null;

  if (listOwnsScroll) {
    return (
      <Feed
        type={tab as FeedType}
        userId={profileId}
        hideHeader
        scrollEnabled
        listHeaderComponent={listHeaderComponent}
        listStickyHeaderComponent={listStickyHeaderComponent}
        listLeadingComponent={pinnedPostElement}
        contentContainerStyle={[
          listContentContainerStyle,
          { paddingBottom: 100 },
        ]}
      />
    );
  }

  return (
    <View>
      {/* Pinned post - only show on posts tab */}
      {pinnedPostElement}
      <Feed
        type={tab as FeedType}
        userId={profileId}
        hideHeader={true}
        scrollEnabled={IS_WEB ? undefined : false}
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
  /** The feed generator's own avatar (only set on feed-generator items). */
  avatar?: string;
  /**
   * The MTN descriptor (`feedgen|<uri>`) for a FEED GENERATOR item — a synced
   * Bluesky feed. When present, the card opens through the feed engine (native
   * posts) instead of the CustomFeed detail screen.
   */
  descriptor?: string;
}

const ProfileFeeds = memo(function ProfileFeeds({
  profileId,
  isOwnProfile,
  viewerId,
}: {
  profileId?: string;
  isOwnProfile: boolean;
  viewerId?: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();

  // React Query (keyed on the profile + ownership) replaces the per-tab
  // useEffect+useState fetch, so revisiting the tab/profile reads cache instead of
  // refetching. Mirrors the pinnedPostQuery above.
  const { data: feeds = [], isPending: loading } = useQuery<ProfileFeedItem[]>({
    queryKey: viewerQueryKeys.profileFeeds(viewerId, profileId, isOwnProfile),
    enabled: Boolean(profileId),
    queryFn: async (): Promise<ProfileFeedItem[]> => {
      const params = isOwnProfile ? { mine: true } : { userId: profileId };
      // Custom feeds (native user curations) AND feed generators (synced Bluesky
      // feeds, keyed on createdBy) both surface on the Feeds tab — a federated
      // profile has only generators, a native profile only custom feeds. Each half
      // fails soft so one outage never blanks the other.
      const [custom, generators] = await Promise.all([
        customFeedsService.list(params).catch(() => {
          logger.warn('Failed to load profile custom feeds');
          return { items: [] };
        }),
        customFeedsService.listGenerators(params).catch(() => {
          logger.warn('Failed to load profile feed generators');
          return { items: [] };
        }),
      ]);
      const generatorItems: ProfileFeedItem[] = (generators.items || []).map((gen) => ({
        id: gen.id,
        descriptor: gen.descriptor,
        title: gen.title,
        description: gen.description,
        avatar: gen.avatar,
        likeCount: gen.likeCount,
        // Only attach a creator byline when the owner resolved to a real handle
        // (the ghost-handle rule — an unresolved owner shows no @handle line).
        owner: gen.owner && gen.owner.username
          ? { username: gen.owner.username, displayName: gen.owner.name?.displayName, avatar: gen.owner.avatar ?? undefined }
          : undefined,
      }));
      return [...(custom.items || []), ...generatorItems];
    },
  });

  if (loading) {
    return (
      <View className="items-center justify-center p-8">
        <Spinner />
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
      {feeds.map((feed) => {
        // A feed generator (synced Bluesky feed) opens through the MTN engine via
        // its descriptor; a native custom feed uses FeedCard's default `/feeds/:id`.
        const descriptor = feed.descriptor;
        return (
          <FeedCard
            key={feed.id || feed._id}
            onPress={
              descriptor
                ? () => router.push({ pathname: '/feeds/view', params: { descriptor, title: feed.title ?? '' } })
                : undefined
            }
            feed={{
              id: String(feed.id || feed._id),
              displayName: feed.title || 'Untitled',
              description: feed.description,
              avatar: feed.avatar,
              memberCount: feed.memberCount ?? (feed.memberOxyUserIds || []).length,
              topicCount: feed.topicCount ?? (feed.keywords || []).length,
              memberAvatars: feed.memberAvatars || [],
              creator: feed.owner,
              likeCount: feed.likeCount,
            }}
          />
        );
      })}
    </View>
  );
});

const ProfileStarterPacks = memo(function ProfileStarterPacks({
  profileId,
  isOwnProfile,
  viewerId,
}: {
  profileId?: string;
  isOwnProfile: boolean;
  viewerId?: string;
}) {
  const { t } = useTranslation();

  // React Query (keyed on the profile + ownership) replaces the per-tab
  // useEffect+useState fetch, so revisiting the tab/profile reads cache instead of
  // refetching. Mirrors the pinnedPostQuery above.
  const { data: packs = [], isPending: loading } = useQuery<StarterPackCardData[]>({
    queryKey: viewerQueryKeys.profileStarterPacks(
      viewerId,
      profileId,
      isOwnProfile,
    ),
    enabled: Boolean(profileId),
    queryFn: async () => {
      try {
        const params = isOwnProfile ? { mine: true } : { userId: profileId };
        const res = await starterPacksService.list(params);
        return (res.items || []).map((pack: Record<string, unknown>) => {
          const memberIds = (pack.memberOxyUserIds || []) as string[];
          return {
            id: String(pack._id || pack.id),
            name: (pack.name as string) || 'Untitled Pack',
            description: pack.description as string | undefined,
            creator: pack.creator as StarterPackCardData['creator'],
            memberCount: memberIds.length,
            useCount: (pack.useCount as number) || 0,
            memberAvatars: (pack.memberAvatars || []) as string[],
            totalMembers: memberIds.length,
          };
        });
      } catch {
        logger.warn('Failed to load profile starter packs');
        return [];
      }
    },
  });

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
        <StarterPackIcon size={48} className="text-muted-foreground" />
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
  viewerId,
}: {
  profileId?: string;
  isOwnProfile: boolean;
  viewerId?: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();

  // React Query (keyed on the profile + ownership) replaces the per-tab
  // useEffect+useState fetch, so revisiting the tab/profile reads cache instead of
  // refetching. Mirrors the pinnedPostQuery above.
  const { data: lists = [], isPending: loading } = useQuery<ListCardData[]>({
    queryKey: viewerQueryKeys.profileLists(viewerId, profileId, isOwnProfile),
    enabled: Boolean(profileId),
    queryFn: async () => {
      try {
        const params = isOwnProfile ? { mine: true } : { userId: profileId };
        const res = await listsService.list(params);
        return (res.items || []).map((l: Record<string, unknown>) => {
          const listId = String(l._id || l.id);
          const owner = (l.owner || l.createdBy || l.creator) as Record<string, string> | undefined;
          return {
            id: listId,
            uri: (l.uri as string) || `list:${listId}`,
            name: (l.title as string) || 'Untitled List',
            description: l.description as string | undefined,
            creator: owner
              ? {
                  username: owner.username || '',
                  displayName: owner.displayName,
                  avatar: owner.avatar,
                }
              : undefined,
            purpose: l.purpose === 'modlist' ? 'modlist' : 'curatelist',
            itemCount: ((l.memberOxyUserIds || []) as string[]).length,
          };
        });
      } catch {
        logger.warn('Failed to load profile lists');
        return [];
      }
    },
  });

  if (loading) {
    return (
      <View className="items-center justify-center p-8">
        <Spinner />
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
