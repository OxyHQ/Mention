import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Share,
  Platform,
  TouchableOpacity,
  Pressable,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useAuth } from '@oxyhq/services';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Avatar } from '@oxyhq/bloom/avatar';
import Feed from '@/components/Feed/Feed';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { listsService } from '@/services/listsService';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';

interface ListOwner {
  _id?: string;
  username?: string;
  displayName?: string;
  avatar?: string;
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
  memberOxyUserIds?: string[];
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

  const TABS = TABS_CONFIG.map(tab => ({ id: tab.id, label: t(tab.labelKey) }));

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

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadList();
  }, [loadList]);

  const listOwner = list?.owner || list?.createdBy || list?.creator;
  const isOwnList = Boolean(
    user && listOwner && (
      listOwner._id === user.id ||
      listOwner.username === user.username
    )
  );
  const memberCount = (list?.memberOxyUserIds || []).length;
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
          <ActivityIndicator size="large" color={theme.colors.primary} />
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

      {/* Subheader: Avatar + Title + Byline */}
      <View className="px-4 pt-3 pb-2 bg-background">
        <View className="flex-row items-start gap-3">
          <Avatar
            source={list.avatar || undefined}
            size={58}
            style={{ borderRadius: 12 }}
          />
          <View className="flex-1 justify-center">
            <Text
              className="text-foreground text-[22px] font-bold leading-[26px]"
              numberOfLines={4}
            >
              {list.title || 'Untitled List'}
            </Text>
            <Pressable
              onPress={() => {
                if (listOwner?.username && !isOwnList) {
                  router.push(`/profile/${listOwner.username}`);
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
        {list.description ? (
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
            <Ionicons
              name={list.isPublic ? 'globe-outline' : 'lock-closed-outline'}
              size={14}
              color={theme.colors.textSecondary}
            />
            <Text className="text-muted-foreground text-sm">
              {list.isPublic ? 'Public' : 'Private'}
            </Text>
          </View>
        </View>
      </View>

      {/* Tab bar */}
      <AnimatedTabBar
        tabs={TABS}
        activeTabId={activeTab}
        onTabPress={setActiveTab}
        instanceId={`list-${listId}`}
      />

      {/* Tab content */}
      {activeTab === 'posts' ? (
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
          {memberCount === 0 ? (
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
          ) : (
            <Feed
              type="mixed"
              filters={{ authors: (list.memberOxyUserIds || []).join(',') }}
              hideHeader
              scrollEnabled={false}
            />
          )}
        </ScrollView>
      ) : (
        <ListMembers
          listId={listId}
          memberIds={list.memberOxyUserIds || []}
          isOwnList={isOwnList}
          refreshing={refreshing}
          onRefresh={onRefresh}
        />
      )}
    </ThemedView>
  );
}

/**
 * Members tab: shows list members with avatars and usernames.
 * For list owners, shows an "Add people" button.
 */
function ListMembers({
  listId,
  memberIds,
  isOwnList,
  refreshing,
  onRefresh,
}: {
  listId: string;
  memberIds: string[];
  isOwnList: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
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
        <View className="px-4 pt-2">
          <Text className="text-muted-foreground text-sm mb-2">
            {memberIds.length} {memberIds.length === 1 ? 'member' : 'members'}
          </Text>
          {/* Member IDs are shown — a full member resolver would fetch user profiles */}
          {memberIds.map((memberId) => (
            <TouchableOpacity
              key={memberId}
              className="flex-row items-center gap-3 py-3 border-b border-border"
              onPress={() => router.push(`/profile/${memberId}`)}
              activeOpacity={0.7}
            >
              <Avatar size={40} />
              <Text className="text-foreground text-[15px] font-medium flex-1" numberOfLines={1}>
                {memberId}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </ScrollView>
  );
}
