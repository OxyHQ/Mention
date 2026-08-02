import React, { useCallback, useMemo, useState } from 'react';
import { Platform, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { VirtualList } from '@oxyhq/bloom/list';
import { toast } from '@oxyhq/bloom/toast';
import { useAuth } from '@oxyhq/services/ui/client';
import { createLogger } from '@oxyhq/core/logger';
import type { Channel } from '@mention/shared-types';

import { ChannelCard } from '@/components/ChannelCard';
import { ChannelFollowButton } from '@/components/ChannelFollowButton';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadMoreSentinel } from '@/components/common/LoadMoreSentinel';
import { ThemedText } from '@/components/ThemedText';
import { usePanelChromeTopInset } from '@/components/shell/PanelChrome';
import { channelsService, type ChannelDirectoryPage } from '@/services/channelsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getErrorMessage } from '@/utils/apiError';

const channelsTabLogger = createLogger('ExploreChannels');

/**
 * Explore › Channels — the channel directory, most-followed first.
 *
 * Discovery only. Everything that is ABOUT the reader rather than about the
 * catalogue — the invitations waiting on them, the channels they publish to, the
 * ones they already follow, and creating a new one — stays on `/channels`, which
 * the header row links to. Splitting it that way is what lets this tab serve a
 * signed-out visitor: the directory is a reader-agnostic read, so it answers
 * without a session and simply omits the follow pills.
 *
 * It shares `viewerQueryKeys.channelDirectory` with `/channels`, so opening one
 * after the other reuses the same pages instead of refetching the catalogue.
 */
export function ChannelsTab() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const { user, canUsePrivateApi, isAuthResolved, isPrivateApiPending } = useAuth();
  const viewerId = user?.id;

  // Channels followed during THIS visit. For a signed-in reader the directory
  // leaves out what they already follow, so this set is the whole difference
  // between what the server said and what they have since done — no refetch, and
  // no row vanishing from under a scroll position. Same mechanism as the
  // "Discover" section of `/channels`, and for the same reason: these rows carry
  // no `viewerState` to patch.
  const [followedHere, setFollowedHere] = useState<ReadonlySet<string>>(new Set());
  const [pendingFollowId, setPendingFollowId] = useState<string | null>(null);

  // The SSO restore can take seconds on a cold web boot. Reading before it lands
  // fetches the signed-out directory and then never corrects itself, so the read
  // waits — and `viewerId` is in the key, so the session landing refetches.
  const readsReady = isAuthResolved && !isPrivateApiPending;

  const directoryQuery = useInfiniteQuery<ChannelDirectoryPage>({
    queryKey: viewerQueryKeys.channelDirectory(viewerId),
    enabled: readsReady,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      channelsService.listDirectory({
        authenticated: canUsePrivateApi,
        cursor: typeof pageParam === 'string' ? pageParam : undefined,
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
  });

  const { fetchNextPage, hasNextPage, isFetchingNextPage } = directoryQuery;

  const channels = useMemo(
    () => (directoryQuery.data?.pages ?? []).flatMap((page) => page.items),
    [directoryQuery.data],
  );

  const handleLoadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const handleFollowToggle = useCallback(
    async (channel: Channel) => {
      if (!canUsePrivateApi || pendingFollowId) return;
      const next = !followedHere.has(channel.id);
      setPendingFollowId(channel.id);
      try {
        if (next) {
          await channelsService.follow(channel.id);
        } else {
          await channelsService.unfollow(channel.id);
        }
        setFollowedHere((previous) => {
          const updated = new Set(previous);
          if (next) updated.add(channel.id);
          else updated.delete(channel.id);
          return updated;
        });
        // The reader's subscription list is not mounted here, but `/channels`
        // reads it from the same cache — marking it stale is what stops that
        // screen opening onto a list this tab has already changed.
        queryClient.invalidateQueries({ queryKey: viewerQueryKeys.followedChannels(viewerId) });
      } catch (error) {
        const message = t('channels.followFailed', {
          defaultValue: 'Failed to update this channel',
        });
        // The SDK logger takes the error SECOND; context, if any, goes third.
        channelsTabLogger.error(message, error);
        toast(getErrorMessage(error, message), { type: 'error' });
      }
      setPendingFollowId(null);
    },
    [canUsePrivateApi, pendingFollowId, followedHere, queryClient, viewerId, t],
  );

  const renderChannel = useCallback(
    ({ item }: { item: Channel }) => (
      <ChannelCard
        channel={item}
        headerRight={
          canUsePrivateApi ? (
            <ChannelFollowButton
              isFollowing={followedHere.has(item.id)}
              isPending={pendingFollowId === item.id}
              onPress={() => handleFollowToggle(item)}
            />
          ) : undefined
        }
      />
    ),
    [canUsePrivateApi, followedHere, pendingFollowId, handleFollowToggle],
  );

  // The one route out of discovery and into the reader's own channels —
  // invitations, what they publish to, and the create form all live there. Shown
  // only to a signed-in reader, for whom that screen has something to say.
  const listHeader = useMemo(
    () =>
      canUsePrivateApi ? (
        <TouchableOpacity
          onPress={() => router.push('/channels')}
          activeOpacity={0.7}
          accessibilityRole="button"
          className="flex-row items-center gap-2 px-3 py-3 border-b border-border">
          <Ionicons name="megaphone-outline" size={18} color={colors.textSecondary} />
          <ThemedText className="flex-1 text-sm font-semibold">
            {t('channels.yourChannels', { defaultValue: 'Your channels' })}
          </ThemedText>
          <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
        </TouchableOpacity>
      ) : null,
    [canUsePrivateApi, colors.textSecondary, t],
  );

  // Web pagination rides the sentinel (Bloom's web `VirtualList` is a window
  // virtualizer with no `onEndReached`); native uses `onEndReached` and leaves
  // the sentinel inert. Both are wired, and each platform uses the one that works.
  const listFooter = useCallback(
    () => (
      <View className="items-center py-4">
        <LoadMoreSentinel onLoadMore={handleLoadMore} enabled={hasNextPage === true} />
        {isFetchingNextPage ? <Loading className="text-primary" size="small" /> : null}
      </View>
    ),
    [handleLoadMore, hasNextPage, isFetchingNextPage],
  );

  // NATIVE: the explore header + tab bar are absolute overlays, so the list has
  // to reserve their height as scrollable top padding or it starts underneath
  // them. WEB: that chrome is sticky in normal flow and needs no inset.
  const chromeTopInset = usePanelChromeTopInset();
  const contentContainerStyle = useMemo(
    () => ({ paddingTop: Platform.OS === 'web' ? 0 : chromeTopInset, paddingBottom: 24 }),
    [chromeTopInset],
  );

  if (directoryQuery.isPending) {
    return (
      <View className="flex-1 items-center py-10" style={contentContainerStyle}>
        <Loading className="text-primary" size="large" style={{ flex: undefined }} />
      </View>
    );
  }

  if (directoryQuery.isError) {
    return (
      <View className="flex-1" style={contentContainerStyle}>
        <EmptyState
          title={t('channels.loadFailed', { defaultValue: 'Failed to load channels' })}
          icon={{ name: 'alert-circle-outline', size: 48 }}
          error={{
            title: t('channels.loadFailed', { defaultValue: 'Failed to load channels' }),
            message: t('common.tryAgain', { defaultValue: 'Try again' }),
            onRetry: async () => {
              await directoryQuery.refetch();
            },
          }}
        />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <VirtualList
        data={channels}
        renderItem={renderChannel}
        keyExtractor={(item: Channel) => item.id}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        ListEmptyComponent={
          <EmptyState
            title={t('channels.emptyDirectory', { defaultValue: 'No channels to discover yet' })}
            icon={{ name: 'megaphone-outline', size: 48 }}
          />
        }
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        removeClippedSubviews={false}
        recycleItems={true}
        contentContainerStyle={contentContainerStyle}
        refreshing={directoryQuery.isRefetching}
        onRefresh={directoryQuery.refetch}
      />
    </View>
  );
}
