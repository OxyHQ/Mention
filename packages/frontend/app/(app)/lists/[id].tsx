import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  Share,
  Platform,
  TouchableOpacity,
  Pressable,
} from 'react-native';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '@oxyhq/services';
import { useQuery } from '@tanstack/react-query';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_VIDEO_POSTER } from '@mention/shared-types';
import { ProfileCard, ProfileCardSkeletonList } from '@/components/ProfileCard';

import Feed from '@/components/Feed/Feed';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { listsService } from '@/services/listsService';
import { subscribeToListChanges } from '@/services/listMutations';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { EntityFollowButton } from '@/components/EntityFollowButton';
import { getNormalizedUserHandle, type User } from '@oxyhq/core';

interface ListOwner {
  _id?: string;
  username?: string;
  displayName?: string;
  // Populated from `MentionListOwner` (avatar is `string | null`).
  avatar?: string | null;
}

interface ListData {
  _id?: string;
  id?: string;
  title?: string;
  description?: string;
  avatar?: string;
  isPublic?: boolean;
  owner?: ListOwner;
  createdBy?: ListOwner;
  creator?: ListOwner;
  ownerOxyUserId?: string;
  memberOxyUserIds?: string[];
  subscriberCount?: number;
}

const TABS_CONFIG = [
  { id: 'posts', labelKey: 'lists.tabs.posts' },
  { id: 'members', labelKey: 'lists.tabs.members' },
];

export default function ListDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const theme = useTheme();
  const { t } = useTranslation();
  const safeBack = useSafeBack();

  const [list, setList] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState('posts');

  // Stable across renders so the posts-tab Feed's `listHeaderComponent`
  // (which embeds this tab bar) keeps a stable element identity and the
  // memoized Feed does not re-render every parent render.
  const TABS = useMemo(() => TABS_CONFIG.map(tab => ({ id: tab.id, label: t(tab.labelKey) })), [t]);

  const loadList = useCallback(async () => {
    if (!id) return;
    try {
      const data = await listsService.get(String(id));
      setList(data);
      setError(null);
    } catch {
      setError('Failed to load list');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Auto-refresh when this list's membership/metadata changes anywhere in the
  // app (e.g. from a profile/post "Add to list" action). Re-fetching the list
  // produces fresh `memberOxyUserIds`, which changes the `<Feed authors>` filter
  // so the embedded feed re-fetches automatically — no manual refresh needed.
  useEffect(() => {
    return subscribeToListChanges((changedId) => {
      if (!id) return;
      if (changedId === null || String(changedId) === String(id)) {
        loadList();
      }
    });
  }, [id, loadList]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadList();
  }, [loadList]);

  const listOwner = list?.owner || list?.createdBy || list?.creator;
  const isOwnList = Boolean(user?.id && list?.ownerOxyUserId === user.id);
  const memberCount = (list?.memberOxyUserIds || []).length;
  const subscriberCount = list?.subscriberCount ?? 0;
  const listId = String(list?._id || list?.id || id);

  const handleShare = useCallback(async () => {
    const url = `${Platform.OS === 'web' ? window.location.origin : 'https://mention.earth'}/lists/${listId}`;
    if (Platform.OS === 'web') {
      await Clipboard.setStringAsync(url);
    } else {
      await Share.share({ url, message: list?.title || 'Check out this list' });
    }
  }, [listId, list?.title]);

  const bylineText = useMemo(() => {
    if (isOwnList) return t('lists.byYou', { defaultValue: 'List by you' });
    if (listOwner?.displayName) return `List by ${listOwner.displayName}`;
    if (listOwner?.username) return `List by @${listOwner.username}`;
    return 'List';
  }, [isOwnList, listOwner, t]);

  // Subheader (avatar + title + byline + stats + follow) and the tab bar are the
  // list page's scroll-away chrome. On the `posts` tab they are handed to the
  // scroll-owning <Feed> as its `listHeaderComponent` so the single virtualized
  // list owns the document scroll on web (mirrors `feeds/[id].tsx` and native's
  // `ListHeaderComponent`); on the `members` tab the same chrome renders inside
  // that tab's own <ScrollView>. Declared after the data so it can read `list`.
  const renderSubheader = useCallback(() => (
    <View className="px-4 pt-3 pb-2 bg-background">
      <View className="flex-row items-start gap-3">
        <Avatar
          source={list?.avatar || undefined}
          size={58}
          variant={MEDIA_VARIANT_VIDEO_POSTER}
          style={{ borderRadius: 12 }}
        />
        <View className="flex-1 justify-center">
          <Text
            className="text-foreground text-[22px] font-bold leading-[26px]"
            numberOfLines={4}
          >
            {list?.title || 'Untitled List'}
          </Text>
          <Pressable
            onPress={() => {
              const handle = getNormalizedUserHandle({ username: listOwner?.username });
              if (handle && !isOwnList) {
                router.push(`/@${handle}`);
              }
            }}
            disabled={isOwnList || !listOwner?.username}
          >
            <Text className="text-muted-foreground text-sm mt-0.5">
              {bylineText}
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Description */}
      {list?.description ? (
        <Text className="text-foreground text-[15px] leading-[20px] mt-3">
          {list.description}
        </Text>
      ) : null}

      {/* Stats row */}
      <View className="flex-row items-center gap-4 mt-3 mb-1">
        <View className="flex-row items-center gap-1">
          <Text className="text-foreground text-sm font-semibold">
            {memberCount}
          </Text>
          <Text className="text-muted-foreground text-sm">
            {memberCount === 1 ? 'member' : 'members'}
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          <Text className="text-foreground text-sm font-semibold">
            {subscriberCount}
          </Text>
          <Text className="text-muted-foreground text-sm">
            {subscriberCount === 1
              ? t('lists.subscriberSingular', { defaultValue: 'subscriber' })
              : t('lists.subscriberPlural', { defaultValue: 'subscribers' })}
          </Text>
        </View>
        <View className="flex-row items-center gap-1">
          <Ionicons
            name={list?.isPublic ? 'globe-outline' : 'lock-closed-outline'}
            size={14}
            color={theme.colors.textSecondary}
          />
          <Text className="text-muted-foreground text-sm">
            {list?.isPublic ? 'Public' : 'Private'}
          </Text>
        </View>
        {!isOwnList ? (
          <View className="ml-auto">
            <EntityFollowButton
              entityType="list"
              entityId={listId}
              label={t('lists.followList', { defaultValue: 'Follow list' })}
              followingLabel={t('lists.followingList', { defaultValue: 'Following' })}
              size="sm"
            />
          </View>
        ) : null}
      </View>
    </View>
  ), [list?.avatar, list?.title, list?.description, list?.isPublic, listOwner?.username, isOwnList, bylineText, memberCount, subscriberCount, listId, theme.colors.textSecondary, t]);

  // Chrome (subheader + tab bar) handed to the posts-tab Feed as its
  // listHeaderComponent. A single element so the Feed treats it as one header.
  const postsTabHeader = useMemo(() => (
    <View>
      {renderSubheader()}
      <AnimatedTabBar
        tabs={TABS}
        activeTabId="posts"
        onTabPress={setActiveTab}
        instanceId={`list-${listId}`}
      />
    </View>
  ), [renderSubheader, TABS, listId]);

  const headerRightComponents = useMemo(() => [
    <IconButton variant="icon" key="share" onPress={handleShare}>
      <Ionicons
        name={Platform.OS === 'web' ? 'link-outline' : 'share-outline'}
        size={22}
        color={theme.colors.text}
      />
    </IconButton>,
    ...(isOwnList
      ? [
          <IconButton
            variant="icon"
            key="edit"
            onPress={() => router.push(`/lists/${listId}/edit`)}
          >
            <Ionicons name="create-outline" size={22} color={theme.colors.text} />
          </IconButton>,
        ]
      : []),
  ], [handleShare, isOwnList, listId, theme.colors.text]);

  // Loading state
  if (loading) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: '',
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View className="flex-1 items-center justify-center">
          <SpinnerIcon size={28} className="text-primary" />
        </View>
      </ThemedView>
    );
  }

  // Error state
  if (error || !list) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('lists.detail.title'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View className="flex-1 items-center justify-center gap-3">
          <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
          <Text className="text-muted-foreground text-base">
            {error || 'List not found'}
          </Text>
          <TouchableOpacity onPress={loadList}>
            <Text className="text-primary text-sm font-medium">Try again</Text>
          </TouchableOpacity>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: list.title || t('lists.detail.title'),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: headerRightComponents,
        }}
        hideBottomBorder
        disableSticky
      />

      {/* Tab content.
          `posts` is the ONLY feed tab and it is the scroll-owning virtualized
          <Feed> (no `scrollEnabled={false}`): on web it owns the document scroll
          via the window virtualizer, with the subheader + tab bar handed to it as
          its `listHeaderComponent` (so they scroll away with the content and the
          shell mask/rails/insets still apply); on native the Feed owns its own
          scroll + pull-to-refresh. The `members` tab renders NON-feed content
          inside its own <ScrollView>, so no feed is embedded in a nested scroller
          anywhere here. Mirrors `feeds/[id].tsx`. */}
      {activeTab === 'posts' ? (
        memberCount === 0 ? (
          <ScrollView
            className="flex-1"
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.primary}
              />
            }
          >
            {renderSubheader()}
            <AnimatedTabBar
              tabs={TABS}
              activeTabId={activeTab}
              onTabPress={setActiveTab}
              instanceId={`list-${listId}`}
            />
            <View className="items-center justify-center p-8 gap-3" style={{ minHeight: 200 }}>
              <Ionicons name="newspaper-outline" size={48} color={theme.colors.textSecondary} />
              <Text className="text-muted-foreground text-base font-medium text-center">
                {t('lists.emptyPosts', { defaultValue: 'No posts yet' })}
              </Text>
              <Text className="text-muted-foreground text-sm text-center">
                {t('lists.emptyPostsSubtext', {
                  defaultValue: 'Add people to this list to see their posts here',
                })}
              </Text>
            </View>
          </ScrollView>
        ) : (
          <Feed
            type="mixed"
            filters={{ authors: (list.memberOxyUserIds || []).join(',') }}
            hideHeader
            listHeaderComponent={postsTabHeader}
          />
        )
      ) : (
        <ListMembers
          listId={listId}
          memberIds={list.memberOxyUserIds || []}
          isOwnList={isOwnList}
          refreshing={refreshing}
          onRefresh={onRefresh}
          header={
            <View>
              {renderSubheader()}
              <AnimatedTabBar
                tabs={TABS}
                activeTabId={activeTab}
                onTabPress={setActiveTab}
                instanceId={`list-${listId}`}
              />
            </View>
          }
        />
      )}
    </ThemedView>
  );
}

/** Member profiles stay fresh for 5 minutes — membership changes invalidate the list itself. */
const MEMBERS_STALE_TIME_MS = 5 * 60_000;

/** Upper bound on placeholder rows while member profiles resolve. */
const MAX_MEMBER_SKELETON_ROWS = 8;

/**
 * Members tab: shows list members as the shared user row.
 * For list owners, shows an "Add people" button.
 */
function ListMembers({
  listId,
  memberIds,
  isOwnList,
  refreshing,
  onRefresh,
  header,
}: {
  listId: string;
  memberIds: string[];
  isOwnList: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  header?: React.ReactNode;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const { oxyServices } = useAuth();

  // The list document carries only member ids — Oxy owns the identities, so the
  // profiles are resolved in ONE bulk call and rendered through the shared row.
  const membersKey = useMemo(() => memberIds.join(','), [memberIds]);
  const { data: members = [], isPending } = useQuery<User[]>({
    queryKey: ['lists', listId, 'members', membersKey],
    queryFn: () => oxyServices.getUsersByIds(memberIds),
    enabled: memberIds.length > 0,
    staleTime: MEMBERS_STALE_TIME_MS,
  });

  // The membership size is known before the profiles are: paint exactly that many
  // placeholder rows (capped) so the tab reserves its real height from the start.
  const resolvingMembers = isPending && memberIds.length > 0;
  const skeletonRowCount = Math.min(memberIds.length, MAX_MEMBER_SKELETON_ROWS);

  return (
    <ScrollView
      className="flex-1"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={theme.colors.primary}
        />
      }
      contentContainerStyle={{ paddingBottom: 100 }}
    >
      {header}
      {isOwnList && (
        <TouchableOpacity
          className="flex-row items-center gap-3 px-4 py-3 border-b border-border"
          onPress={() => router.push(`/lists/${listId}/edit`)}
          activeOpacity={0.7}
        >
          <View
            className="w-10 h-10 rounded-full items-center justify-center bg-primary"
          >
            <Ionicons name="person-add" size={20} color="#fff" />
          </View>
          <Text className="text-primary text-[15px] font-semibold">
            {t('lists.addPeople', { defaultValue: 'Add people' })}
          </Text>
        </TouchableOpacity>
      )}

      {memberIds.length === 0 ? (
        <View className="items-center justify-center p-8 gap-3" style={{ minHeight: 200 }}>
          <Ionicons name="people-outline" size={48} color={theme.colors.textSecondary} />
          <Text className="text-muted-foreground text-base font-medium text-center">
            {t('lists.emptyMembers', { defaultValue: 'No members yet' })}
          </Text>
          {isOwnList && (
            <Text className="text-muted-foreground text-sm text-center">
              {t('lists.emptyMembersSubtext', {
                defaultValue: 'Add people to curate this list',
              })}
            </Text>
          )}
        </View>
      ) : (
        <View className="pt-2">
          <Text className="text-muted-foreground text-sm mb-2 px-4">
            {memberIds.length} {memberIds.length === 1 ? 'member' : 'members'}
          </Text>
          {resolvingMembers && (
            <ProfileCardSkeletonList count={skeletonRowCount} showFollowButton />
          )}
          {members.map((member) => (
            <ProfileCard
              key={member.id}
              profile={{
                id: member.id,
                username: member.username,
                name: member.name,
                avatar: member.avatar,
                color: member.color,
                // `verified` reaches the SDK `User` through its index signature
                // (typed `unknown`), so it is narrowed rather than cast.
                verified: typeof member.verified === 'boolean' ? member.verified : undefined,
                isFederated: member.isFederated,
                instance: member.instance,
              }}
              showFollowButton
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}
