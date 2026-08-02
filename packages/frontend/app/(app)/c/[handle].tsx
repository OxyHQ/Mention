import React, { useCallback, useMemo, useState } from 'react';
import {
  Platform,
  RefreshControl,
  ScrollView,
  Share,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services/ui/client';
import { createLogger } from '@oxyhq/core/logger';
import type { Channel, ChannelMemberSummary } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR_LG } from '@mention/shared-types/post';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import Feed from '@/components/Feed/Feed';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { EmptyState } from '@/components/common/EmptyState';
import { ProfileCard } from '@/components/ProfileCard';
import { ChannelFollowButton } from '@/components/ChannelFollowButton';
import { SEO } from '@/components/SEO';
import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { channelsService } from '@/services/channelsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { formatCompactNumber } from '@/utils/formatNumber';
import { getErrorMessage } from '@/utils/apiError';

const channelLogger = createLogger('Channel');

const TABS_CONFIG = [
  { id: 'posts', labelKey: 'channels.tabs.posts', fallback: 'Posts' },
  { id: 'members', labelKey: 'channels.tabs.members', fallback: 'Publishers' },
];

/**
 * ONE channel's page: its profile, its posts, and who publishes to it.
 *
 * The URL carries the readable handle and the FEED carries the id — `channel.id`
 * from the fetched DTO, never the URL segment. `GET /channels/:idOrHandle` is the
 * one place both spellings resolve; the `channel|<id>` descriptor takes only the
 * stable one, which is what lets a rename cost a link without breaking a pinned
 * home tab.
 *
 * All the page chrome (subheader + tab bar) is handed to the posts tab's `<Feed>`
 * as a single `listHeaderComponent`, so the virtualized feed stays the SOLE
 * scroll owner on web. The members tab has no feed and brings its own ScrollView.
 */
export default function ChannelScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const routeHandle = String(handle ?? '');
  const { t } = useTranslation();
  const theme = useTheme();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();
  const { user, canUsePrivateApi, isAuthResolved, isPrivateApiPending } = useAuth();
  const viewerId = user?.id;
  const [activeTab, setActiveTab] = useState('posts');

  // Stable across renders so the posts-tab Feed's `listHeaderComponent` keeps a
  // stable element identity and the memoized Feed does not re-render with it.
  const TABS = useMemo(
    () => TABS_CONFIG.map((tab) => ({ id: tab.id, label: t(tab.labelKey, { defaultValue: tab.fallback }) })),
    [t],
  );

  // Both reads wait for the cold boot to settle rather than firing while the
  // session is still resolving: an anonymous answer cached under the viewer's own
  // key would leave the page with no `viewerState` and nothing to refetch it.
  const readsReady = routeHandle.length > 0 && isAuthResolved && !isPrivateApiPending;

  const channelQueryKey = viewerQueryKeys.channel(viewerId, routeHandle);
  const {
    data: channel,
    isLoading,
    isError,
    refetch,
    isRefetching,
  } = useQuery<Channel | null>({
    queryKey: channelQueryKey,
    queryFn: () => channelsService.get(routeHandle, { authenticated: canUsePrivateApi }),
    enabled: readsReady,
  });

  const channelId = channel?.id ?? '';
  const viewerState = channel?.viewerState;
  const isFollowing = viewerState?.isFollowing === true;
  const isOwner = Boolean(viewerId && channel?.ownerOxyUserId === viewerId);
  const isPendingInvitee = viewerState?.memberStatus === 'pending';

  const membersQuery = useQuery<ChannelMemberSummary[]>({
    queryKey: viewerQueryKeys.channelMembers(viewerId, routeHandle),
    queryFn: () => channelsService.listMembers(routeHandle, { authenticated: canUsePrivateApi }),
    enabled: readsReady && activeTab === 'members',
  });

  const reportFailure = useCallback(
    (error: unknown, fallback: string) => {
      channelLogger.error(fallback, error, { channel: routeHandle });
      toast(getErrorMessage(error, fallback), { type: 'error' });
    },
    [routeHandle],
  );

  const followMutation = useMutation<boolean, unknown, boolean>({
    mutationFn: async (next) => {
      if (next) {
        await channelsService.follow(channelId);
      } else {
        await channelsService.unfollow(channelId);
      }
      return next;
    },
    onSuccess: (next) => {
      // Written straight into this page's own cache rather than invalidated: the
      // server already answered, and a refetch would repaint the whole header for
      // a change of one boolean and one counter.
      queryClient.setQueryData<Channel | null>(channelQueryKey, (previous) =>
        previous
          ? {
              ...previous,
              followerCount: Math.max(0, previous.followerCount + (next ? 1 : -1)),
              viewerState: {
                ...(previous.viewerState ?? { isFollowing: false, notify: false }),
                isFollowing: next,
                // A fresh follow is created notifying; unfollowing takes the row
                // with it, so the flag has nothing left to mean.
                notify: next,
              },
            }
          : previous,
      );
      // Both of the directory's reader-facing lists split on this exact
      // relationship, and neither is mounted here — marking them stale re-splits
      // them on the next visit instead of yanking a row out from under a scroll
      // position. Named one by one rather than invalidating `channelsRoot`, which
      // would also throw away the detail row this handler just wrote by hand.
      queryClient.invalidateQueries({ queryKey: viewerQueryKeys.channelDirectory(viewerId) });
      queryClient.invalidateQueries({ queryKey: viewerQueryKeys.followedChannels(viewerId) });
    },
    onError: (error) =>
      reportFailure(error, t('channels.followFailed', { defaultValue: 'Failed to update this channel' })),
  });

  const notifyMutation = useMutation<boolean, unknown, boolean>({
    mutationFn: (notify) => channelsService.setNotify(channelId, notify),
    onSuccess: (notify) => {
      queryClient.setQueryData<Channel | null>(channelQueryKey, (previous) =>
        previous?.viewerState
          ? { ...previous, viewerState: { ...previous.viewerState, notify } }
          : previous,
      );
    },
    onError: (error) =>
      reportFailure(error, t('channels.notifyFailed', { defaultValue: 'Failed to update notifications' })),
  });

  const inviteMutation = useMutation<void, unknown, 'accept' | 'decline'>({
    mutationFn: (answer) =>
      answer === 'accept'
        ? channelsService.acceptInvite(channelId)
        : channelsService.declineInvite(channelId),
    onSuccess: (_result, answer) => {
      // Membership decides who may publish AND what the members list contains, so
      // the whole channel namespace is re-read rather than patched in two places.
      queryClient.invalidateQueries({ queryKey: viewerQueryKeys.channelsRoot(viewerId) });
      toast(
        answer === 'accept'
          ? t('channels.inviteAccepted', { defaultValue: 'You can now publish to this channel' })
          : t('channels.inviteDeclined', { defaultValue: 'Invitation declined' }),
        { type: 'success' },
      );
    },
    onError: (error) =>
      reportFailure(error, t('channels.inviteFailed', { defaultValue: 'Failed to answer the invitation' })),
  });

  const handleFollowPress = useCallback(() => {
    if (!channelId || !canUsePrivateApi || followMutation.isPending) return;
    followMutation.mutate(!isFollowing);
  }, [channelId, canUsePrivateApi, followMutation, isFollowing]);

  const handleNotifyPress = useCallback(() => {
    if (!channelId || notifyMutation.isPending) return;
    notifyMutation.mutate(!(viewerState?.notify === true));
  }, [channelId, notifyMutation, viewerState?.notify]);

  const handleShare = useCallback(async () => {
    const origin = Platform.OS === 'web' ? window.location.origin : 'https://mention.earth';
    const url = `${origin}/c/${routeHandle}`;
    if (Platform.OS === 'web') {
      await Clipboard.setStringAsync(url);
      toast(t('common.linkCopied', { defaultValue: 'Link copied' }), { type: 'success' });
      return;
    }
    await Share.share({ url, message: channel?.title ?? url });
  }, [routeHandle, channel?.title, t]);

  const onRefresh = useCallback(() => {
    refetch();
    if (activeTab === 'members') membersQuery.refetch();
  }, [refetch, activeTab, membersQuery]);

  // Pinning is how a followed channel stays reachable: the home screen already
  // renders any `channel|<id>` descriptor as its own tab, and the key follows the
  // `<source>:<id>` convention every other pinnable feed uses.
  const { isPinned: isFeedPinned, pin, unpin, canEdit: canPin } = useFeedPreferences();
  const pinKey = channelId ? `channel:${channelId}` : '';
  const isPinned = pinKey.length > 0 && isFeedPinned(pinKey);

  const handleTogglePin = useCallback(() => {
    if (!channelId) return;
    if (isFeedPinned(pinKey)) unpin(pinKey);
    else pin({ key: pinKey, descriptor: `channel|${channelId}` });
  }, [channelId, pinKey, isFeedPinned, pin, unpin]);

  const subheader = useMemo(() => {
    if (!channel) return null;
    return (
      <View className="px-4 pt-3 pb-2 bg-background">
        <View className="flex-row items-start gap-3">
          <Avatar
            source={channel.avatar}
            size={58}
            variant={MEDIA_VARIANT_AVATAR_LG}
            shape="squircle"
          />
          <View className="flex-1 justify-center">
            <Text className="text-foreground text-[22px] font-bold leading-[26px]" numberOfLines={3}>
              {channel.title}
            </Text>
            <Text className="text-muted-foreground text-sm mt-0.5" numberOfLines={1}>
              {`@${channel.handle}`}
            </Text>
          </View>
        </View>

        {channel.description ? (
          <Text className="text-foreground text-[15px] leading-[20px] mt-3">
            {channel.description}
          </Text>
        ) : null}

        <View className="flex-row items-center gap-4 mt-3 mb-1">
          <View className="flex-row items-center gap-1">
            <Text className="text-foreground text-sm font-semibold">
              {formatCompactNumber(channel.followerCount)}
            </Text>
            <Text className="text-muted-foreground text-sm">
              {t('channels.followersWord', { defaultValue: 'followers' })}
            </Text>
          </View>
          <View className="flex-row items-center gap-1">
            <Text className="text-foreground text-sm font-semibold">
              {formatCompactNumber(channel.postCount)}
            </Text>
            <Text className="text-muted-foreground text-sm">
              {t('channels.postsWord', { defaultValue: 'posts' })}
            </Text>
          </View>

          {canUsePrivateApi && !isOwner ? (
            <View className="ml-auto flex-row items-center gap-2">
              {isFollowing ? (
                <TouchableOpacity
                  onPress={handleNotifyPress}
                  disabled={notifyMutation.isPending}
                  activeOpacity={0.7}
                  accessibilityRole="button"
                  accessibilityState={{ selected: viewerState?.notify === true }}
                  accessibilityLabel={t('channels.notifyToggle', {
                    defaultValue: 'Notify me about new posts',
                  })}
                  className="h-9 w-9 items-center justify-center rounded-full border border-border">
                  <Ionicons
                    name={viewerState?.notify === true ? 'notifications' : 'notifications-off-outline'}
                    size={18}
                    color={viewerState?.notify === true ? theme.colors.primary : theme.colors.textSecondary}
                  />
                </TouchableOpacity>
              ) : null}
              <ChannelFollowButton
                isFollowing={isFollowing}
                isPending={followMutation.isPending}
                onPress={handleFollowPress}
              />
            </View>
          ) : null}
        </View>

        {isPendingInvitee ? (
          <View className="mt-2 rounded-2xl border border-border p-3 gap-3">
            <Text className="text-foreground text-sm">
              {t('channels.invitePending', {
                channel: channel.title,
                defaultValue: 'You have been invited to publish to «{{channel}}».',
              })}
            </Text>
            <View className="flex-row gap-2">
              <TouchableOpacity
                onPress={() => inviteMutation.mutate('accept')}
                disabled={inviteMutation.isPending}
                activeOpacity={0.8}
                accessibilityRole="button"
                className="flex-1 items-center justify-center rounded-full bg-primary py-2">
                <Text className="text-primary-foreground text-[13px] font-bold">
                  {t('channels.acceptInvite', { defaultValue: 'Accept' })}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => inviteMutation.mutate('decline')}
                disabled={inviteMutation.isPending}
                activeOpacity={0.8}
                accessibilityRole="button"
                className="flex-1 items-center justify-center rounded-full border border-border py-2">
                <Text className="text-foreground text-[13px] font-bold">
                  {t('channels.declineInvite', { defaultValue: 'Decline' })}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}
      </View>
    );
  }, [
    channel,
    t,
    canUsePrivateApi,
    isOwner,
    isFollowing,
    handleFollowPress,
    followMutation.isPending,
    handleNotifyPress,
    notifyMutation.isPending,
    viewerState?.notify,
    theme.colors.primary,
    theme.colors.textSecondary,
    isPendingInvitee,
    inviteMutation,
  ]);

  const tabBar = useMemo(
    () => (
      <AnimatedTabBar
        tabs={TABS}
        activeTabId={activeTab}
        onTabPress={setActiveTab}
        instanceId={`channel-${channelId || routeHandle}`}
      />
    ),
    [TABS, activeTab, channelId, routeHandle],
  );

  const postsTabHeader = useMemo(
    () => (
      <View>
        {subheader}
        {tabBar}
      </View>
    ),
    [subheader, tabBar],
  );

  const headerOptions = useMemo(
    () => ({
      title: channel?.title ?? t('channels.detailTitle', { defaultValue: 'Channel' }),
      leftComponents: [
        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
          <BackArrowIcon size={20} className="text-foreground" />
        </IconButton>,
      ],
      rightComponents: [
        ...(canPin && channelId
          ? [
              <IconButton
                variant="icon"
                key="pin"
                onPress={handleTogglePin}
                accessibilityLabel={t('channels.pinToHome', { defaultValue: 'Pin to home' })}>
                <Ionicons
                  name={isPinned ? 'bookmark' : 'bookmark-outline'}
                  size={22}
                  color={isPinned ? theme.colors.primary : theme.colors.text}
                />
              </IconButton>,
            ]
          : []),
        <IconButton variant="icon" key="share" onPress={handleShare}>
          <Ionicons
            name={Platform.OS === 'web' ? 'link-outline' : 'share-outline'}
            size={22}
            color={theme.colors.text}
          />
        </IconButton>,
        ...(isOwner && channelId
          ? [
              <IconButton
                variant="icon"
                key="settings"
                onPress={() => router.push(`/c/${routeHandle}/settings`)}>
                <Ionicons name="settings-outline" size={22} color={theme.colors.text} />
              </IconButton>,
            ]
          : []),
      ],
    }),
    [
      channel?.title,
      t,
      safeBack,
      handleShare,
      theme.colors.text,
      theme.colors.primary,
      isOwner,
      channelId,
      routeHandle,
      canPin,
      isPinned,
      handleTogglePin,
    ],
  );

  if (isLoading || !readsReady) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <View className="flex-1 items-center justify-center">
          <SpinnerIcon size={28} className="text-primary" />
        </View>
      </ThemedView>
    );
  }

  if (isError || !channel) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <EmptyState
          title={t('channels.notFound', { defaultValue: 'Channel not found' })}
          icon={{ name: 'alert-circle-outline', size: 48 }}
          error={{
            title: t('channels.notFound', { defaultValue: 'Channel not found' }),
            message: t('common.tryAgain', { defaultValue: 'Try again' }),
            onRetry: async () => {
              await refetch();
            },
          }}
        />
      </ThemedView>
    );
  }

  return (
    <>
      <SEO title={channel.title} description={channel.description} />
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />

        {activeTab === 'posts' ? (
          <Feed
            type="mixed"
            filters={{ channelId }}
            hideHeader
            listHeaderComponent={postsTabHeader}
          />
        ) : (
          <ChannelMembers
            members={membersQuery.data ?? []}
            isLoading={membersQuery.isPending}
            isOwner={isOwner}
            channelHandle={routeHandle}
            refreshing={isRefetching}
            onRefresh={onRefresh}
            header={postsTabHeader}
          />
        )}
      </ThemedView>
    </>
  );
}

/**
 * Who publishes here.
 *
 * A stranger sees accepted publishers only — the server decides that, not this
 * component: it returns pending and declined rows to the OWNER and to nobody
 * else, so the pending group below simply renders what arrived. Grouping rather
 * than a third tab for the same reason: one request already carries both, and an
 * owner chasing an invitation wants it next to the membership it belongs to.
 */
function ChannelMembers({
  members,
  isLoading,
  isOwner,
  channelHandle,
  refreshing,
  onRefresh,
  header,
}: {
  members: ChannelMemberSummary[];
  isLoading: boolean;
  isOwner: boolean;
  channelHandle: string;
  refreshing: boolean;
  onRefresh: () => void;
  header: React.ReactNode;
}) {
  const { t } = useTranslation();
  const theme = useTheme();

  const accepted = useMemo(() => members.filter((m) => m.status === 'accepted'), [members]);
  const pending = useMemo(() => members.filter((m) => m.status === 'pending'), [members]);

  const renderRow = useCallback(
    (member: ChannelMemberSummary) => (
      <ProfileCard
        key={`${member.user.id}-${member.status}`}
        profile={{
          id: member.user.id,
          username: member.user.username,
          name: member.user.name,
          avatar: member.user.avatar,
          verified: member.user.verified,
          isFederated: member.user.isFederated,
          instance: member.user.instance,
          federation: member.user.federation,
        }}
        meta={
          member.role === 'owner' ? (
            <Text className="text-muted-foreground text-[13px]">
              {t('channels.roleOwner', { defaultValue: 'Owner' })}
            </Text>
          ) : undefined
        }
      />
    ),
    [t],
  );

  return (
    <ScrollView
      className="flex-1"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.primary} />
      }
      contentContainerStyle={{ paddingBottom: 100 }}>
      {header}

      {isOwner ? (
        <TouchableOpacity
          className="flex-row items-center gap-3 px-4 py-3 border-b border-border"
          onPress={() => router.push(`/c/${channelHandle}/settings`)}
          activeOpacity={0.7}>
          <View className="w-10 h-10 rounded-full items-center justify-center bg-primary">
            <Ionicons name="person-add" size={20} color={theme.colors.primaryForeground} />
          </View>
          <Text className="text-primary text-[15px] font-semibold">
            {t('channels.invitePublisher', { defaultValue: 'Invite a publisher' })}
          </Text>
        </TouchableOpacity>
      ) : null}

      {isLoading ? (
        <View className="py-10 items-center">
          <SpinnerIcon size={24} className="text-primary" />
        </View>
      ) : accepted.length === 0 && pending.length === 0 ? (
        <EmptyState
          title={t('channels.emptyMembers', { defaultValue: 'No publishers yet' })}
          icon={{ name: 'people-outline', size: 48 }}
        />
      ) : (
        <View className="pt-2">
          {accepted.map(renderRow)}

          {pending.length > 0 ? (
            <>
              <Text className="text-muted-foreground text-sm mt-4 mb-2 px-4">
                {t('channels.pendingInvites', { defaultValue: 'Invitations sent' })}
              </Text>
              {pending.map(renderRow)}
            </>
          ) : null}
        </View>
      )}
    </ScrollView>
  );
}
