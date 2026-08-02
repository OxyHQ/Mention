import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Loading, SpinnerIcon } from '@oxyhq/bloom/loading';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup } from '@oxyhq/bloom/settings-list';
import { useAuth } from '@oxyhq/services/ui/client';
import { createLogger } from '@oxyhq/core/logger';
import {
  CHANNEL_HANDLE_MAX_LENGTH,
  MAX_CHANNEL_TITLE_LENGTH,
  normalizeChannelHandle,
  type Channel,
  type ChannelViewerState,
} from '@mention/shared-types';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ChannelCard } from '@/components/ChannelCard';
import { ChannelFollowButton } from '@/components/ChannelFollowButton';
import { EmptyState } from '@/components/common/EmptyState';
import { SEO } from '@/components/SEO';
import { channelsService, type ChannelDirectoryPage } from '@/services/channelsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getErrorMessage } from '@/utils/apiError';

const channelsLogger = createLogger('Channels');

/**
 * The channel directory: the ones you publish to, the ones inviting you, and the
 * rest of them.
 *
 * There is deliberately NO "channels you follow" section, because the API has no
 * endpoint that answers it — `GET /channels/mine` is publishing rights, not
 * readership, and the directory carries no per-item `viewerState`. A followed
 * channel is meant to be kept as a PINNED HOME TAB (the channel page's pin
 * control writes the `channel|<id>` descriptor the home screen already renders),
 * which is the design's own answer to "where do I find it again".
 *
 * For a signed-in reader the directory asks the server to leave out the channels
 * they already follow, so every discover row is followable by construction — the
 * list cannot show a live "Follow" button for something already followed.
 */
export default function ChannelsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();
  const { user, isAuthenticated, canUsePrivateApi, isAuthResolved, isPrivateApiPending } = useAuth();
  const viewerId = user?.id;

  const [handleInput, setHandleInput] = useState('');
  const [titleInput, setTitleInput] = useState('');
  // Channels followed during THIS visit. The directory excludes the ones already
  // followed when the page was fetched, so this set is the whole difference
  // between what the server said and what the reader has since done — no refetch,
  // and no row vanishing from under a scroll position.
  const [followedHere, setFollowedHere] = useState<ReadonlySet<string>>(new Set());
  const [pendingFollowId, setPendingFollowId] = useState<string | null>(null);
  const [pendingNotifyId, setPendingNotifyId] = useState<string | null>(null);

  const readsReady = isAuthResolved && !isPrivateApiPending;

  const headerOptions = useMemo(
    () => ({
      title: t('channels.title', { defaultValue: 'Channels' }),
      leftComponents: [
        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
          <BackArrowIcon size={20} className="text-foreground" />
        </IconButton>,
      ],
    }),
    [t, safeBack],
  );

  const reportFailure = useCallback((error: unknown, fallback: string) => {
    channelsLogger.error(fallback, error);
    toast(getErrorMessage(error, fallback), { type: 'error' });
  }, []);

  const mineQuery = useQuery<Channel[]>({
    queryKey: viewerQueryKeys.ownedChannels(viewerId),
    queryFn: () => channelsService.listMine(),
    enabled: canUsePrivateApi,
  });

  const invitesQuery = useQuery<Channel[]>({
    queryKey: viewerQueryKeys.channelInvites(viewerId),
    queryFn: () => channelsService.listInvites(),
    enabled: canUsePrivateApi,
  });

  const followingQuery = useInfiniteQuery<ChannelDirectoryPage>({
    queryKey: viewerQueryKeys.followedChannels(viewerId),
    enabled: canUsePrivateApi,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      channelsService.listFollowing({
        cursor: typeof pageParam === 'string' ? pageParam : undefined,
      }),
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
  });

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

  const createMutation = useMutation<Channel, unknown, { handle: string; title: string }>({
    mutationFn: (body) => channelsService.create(body),
    onSuccess: (created) => {
      setHandleInput('');
      setTitleInput('');
      queryClient.invalidateQueries({ queryKey: viewerQueryKeys.channelsRoot(viewerId) });
      router.push(`/c/${created.handle}`);
    },
    onError: (error) =>
      reportFailure(error, t('channels.createFailed', { defaultValue: 'Failed to create the channel' })),
  });

  const inviteMutation = useMutation<void, unknown, { channelId: string; answer: 'accept' | 'decline' }>({
    mutationFn: ({ channelId, answer }) =>
      answer === 'accept'
        ? channelsService.acceptInvite(channelId)
        : channelsService.declineInvite(channelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: viewerQueryKeys.channelsRoot(viewerId) });
    },
    onError: (error) =>
      reportFailure(error, t('channels.inviteFailed', { defaultValue: 'Failed to answer the invitation' })),
  });

  /**
   * Write a subscription row's own `viewerState` back into the page the server
   * sent, rather than tracking the change beside it.
   *
   * These rows CARRY a `viewerState`, so patching it is updating a field that
   * arrived from the server — the exact opposite of the discover rows below,
   * whose DTO has none to patch and which are unfollowed by construction (the
   * server excluded the followed ones). Two mechanisms because the two lists
   * genuinely differ, not because one of them was easier.
   */
  const patchFollowingRow = useCallback(
    (channelId: string, patch: (state: ChannelViewerState) => ChannelViewerState) => {
      queryClient.setQueryData<InfiniteData<ChannelDirectoryPage>>(
        viewerQueryKeys.followedChannels(viewerId),
        (previous) =>
          previous
            ? {
                ...previous,
                pages: previous.pages.map((page) => ({
                  ...page,
                  items: page.items.map((item) =>
                    item.id === channelId && item.viewerState
                      ? { ...item, viewerState: patch(item.viewerState) }
                      : item,
                  ),
                })),
              }
            : previous,
      );
    },
    [queryClient, viewerId],
  );

  const handleFollowingToggle = useCallback(
    async (channel: Channel) => {
      if (!canUsePrivateApi || pendingFollowId) return;
      const next = channel.viewerState?.isFollowing !== true;
      setPendingFollowId(channel.id);
      try {
        if (next) {
          await channelsService.follow(channel.id);
        } else {
          await channelsService.unfollow(channel.id);
        }
        // The row STAYS after an unfollow — it is how the reader undoes a mistap.
        // It leaves the list on the next read, which is when the server agrees.
        // A fresh follow is created notifying, matching `POST /:id/follow`.
        patchFollowingRow(channel.id, (state) => ({ ...state, isFollowing: next, notify: next }));
      } catch (error) {
        reportFailure(error, t('channels.followFailed', { defaultValue: 'Failed to update this channel' }));
      }
      setPendingFollowId(null);
    },
    [canUsePrivateApi, pendingFollowId, patchFollowingRow, reportFailure, t],
  );

  const handleNotifyToggle = useCallback(
    async (channel: Channel) => {
      if (!canUsePrivateApi || pendingNotifyId) return;
      setPendingNotifyId(channel.id);
      try {
        // The server's answer, not the value asked for — `PATCH /:id/follow`
        // returns the stored flag, and it is the only thing that knows.
        const applied = await channelsService.setNotify(
          channel.id,
          channel.viewerState?.notify !== true,
        );
        patchFollowingRow(channel.id, (state) => ({ ...state, notify: applied }));
      } catch (error) {
        reportFailure(error, t('channels.notifyFailed', { defaultValue: 'Failed to update notifications' }));
      }
      setPendingNotifyId(null);
    },
    [canUsePrivateApi, pendingNotifyId, patchFollowingRow, reportFailure, t],
  );

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
        // The subscription list above just changed, and it IS mounted here — so
        // this refetches it and the channel appears under "Following" straight
        // away. The discover row stays where it is: its own state is the set
        // above, so nothing moves under the reader's scroll position.
        queryClient.invalidateQueries({ queryKey: viewerQueryKeys.followedChannels(viewerId) });
      } catch (error) {
        reportFailure(error, t('channels.followFailed', { defaultValue: 'Failed to update this channel' }));
      }
      setPendingFollowId(null);
    },
    [canUsePrivateApi, pendingFollowId, followedHere, reportFailure, t, queryClient, viewerId],
  );

  const handleCreate = useCallback(() => {
    const handle = normalizeChannelHandle(handleInput);
    const title = titleInput.trim();
    if (!handle || !title || createMutation.isPending) return;
    createMutation.mutate({ handle, title });
  }, [handleInput, titleInput, createMutation]);

  const mine = mineQuery.data ?? [];
  const invites = invitesQuery.data ?? [];
  const following = useMemo(
    () => (followingQuery.data?.pages ?? []).flatMap((page) => page.items),
    [followingQuery.data],
  );
  const directory = useMemo(
    () => (directoryQuery.data?.pages ?? []).flatMap((page) => page.items),
    [directoryQuery.data],
  );

  const canCreate =
    normalizeChannelHandle(handleInput) !== null &&
    titleInput.trim().length > 0 &&
    !createMutation.isPending;

  return (
    <>
      <SEO
        title={t('channels.title', { defaultValue: 'Channels' })}
        description={t('channels.description', {
          defaultValue: 'Publications people follow without following their authors.',
        })}
      />
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />

        <ScrollView
          className="flex-1"
          contentContainerClassName="pb-24"
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled">
          {invites.length > 0 ? (
            <SettingsListGroup title={t('channels.invitations', { defaultValue: 'Invitations' })}>
              {invites.map((channel) => (
                <ChannelCard
                  key={channel.id}
                  channel={channel}
                  showDescription={false}
                  headerRight={
                    <View className="flex-row gap-2">
                      <TouchableOpacity
                        onPress={() => inviteMutation.mutate({ channelId: channel.id, answer: 'accept' })}
                        disabled={inviteMutation.isPending}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        className="rounded-full bg-primary px-3.5 py-[7px]">
                        <Text className="text-primary-foreground text-[13px] font-bold">
                          {t('channels.acceptInvite', { defaultValue: 'Accept' })}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => inviteMutation.mutate({ channelId: channel.id, answer: 'decline' })}
                        disabled={inviteMutation.isPending}
                        activeOpacity={0.8}
                        accessibilityRole="button"
                        className="rounded-full border border-border px-3.5 py-[7px]">
                        <Text className="text-foreground text-[13px] font-bold">
                          {t('channels.declineInvite', { defaultValue: 'Decline' })}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  }
                />
              ))}
            </SettingsListGroup>
          ) : null}

          {isAuthenticated ? (
            <SettingsListGroup
              title={t('channels.yourChannels', { defaultValue: 'Your channels' })}
              footer={t('channels.yourChannelsFooter', {
                defaultValue: 'The channels you may publish to — the ones you own, and the ones you were invited to.',
              })}>
              {mineQuery.isPending ? (
                <View className="py-8 items-center">
                  <SpinnerIcon size={20} className="text-primary" />
                </View>
              ) : mine.length === 0 ? (
                <View className="py-4">
                  <EmptyState
                    title={t('channels.emptyMine', { defaultValue: 'You publish to no channels yet' })}
                    icon={{ name: 'megaphone-outline', size: 48 }}
                  />
                </View>
              ) : (
                mine.map((channel) => <ChannelCard key={channel.id} channel={channel} />)
              )}
            </SettingsListGroup>
          ) : null}

          {/* What the reader SUBSCRIBES to — a different question from the one
              above, and a different model behind it (`ChannelFollow`, not
              `ChannelMember`). Every row here carries its own `viewerState`, so
              the mute switch costs no extra request. */}
          {canUsePrivateApi ? (
            <SettingsListGroup title={t('channels.followingSection', { defaultValue: 'Following' })}>
              {followingQuery.isPending ? (
                <View className="py-8 items-center">
                  <SpinnerIcon size={20} className="text-primary" />
                </View>
              ) : following.length === 0 ? (
                <View className="py-4">
                  <EmptyState
                    title={t('channels.emptyFollowing', {
                      defaultValue: 'You follow no channels yet',
                    })}
                    icon={{ name: 'megaphone-outline', size: 48 }}
                  />
                </View>
              ) : (
                <>
                  {following.map((channel) => (
                    <ChannelCard
                      key={channel.id}
                      channel={channel}
                      showDescription={false}
                      headerRight={
                        <View className="flex-row items-center gap-2">
                          {channel.viewerState?.isFollowing ? (
                            <TouchableOpacity
                              onPress={() => handleNotifyToggle(channel)}
                              disabled={pendingNotifyId === channel.id}
                              activeOpacity={0.7}
                              accessibilityRole="button"
                              accessibilityState={{ selected: channel.viewerState.notify }}
                              accessibilityLabel={t('channels.notifyToggle', {
                                defaultValue: 'Notify me about new posts',
                              })}
                              className="h-9 w-9 items-center justify-center rounded-full border border-border">
                              <Ionicons
                                name={
                                  channel.viewerState.notify
                                    ? 'notifications'
                                    : 'notifications-off-outline'
                                }
                                size={18}
                                color={
                                  channel.viewerState.notify
                                    ? colors.primary
                                    : colors.textSecondary
                                }
                              />
                            </TouchableOpacity>
                          ) : null}
                          <ChannelFollowButton
                            isFollowing={channel.viewerState?.isFollowing === true}
                            isPending={pendingFollowId === channel.id}
                            onPress={() => handleFollowingToggle(channel)}
                          />
                        </View>
                      }
                    />
                  ))}
                  {followingQuery.hasNextPage ? (
                    <TouchableOpacity
                      onPress={() => followingQuery.fetchNextPage()}
                      disabled={followingQuery.isFetchingNextPage}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      className="items-center justify-center py-4">
                      {followingQuery.isFetchingNextPage ? (
                        <SpinnerIcon size={18} className="text-primary" />
                      ) : (
                        <Text className="text-primary text-sm font-semibold">
                          {t('common.loadMore', { defaultValue: 'Load more' })}
                        </Text>
                      )}
                    </TouchableOpacity>
                  ) : null}
                </>
              )}
            </SettingsListGroup>
          ) : null}

          {isAuthenticated ? (
            <SettingsListGroup
              title={t('channels.newChannel', { defaultValue: 'New channel' })}
              footer={t('channels.newChannelFooter', {
                defaultValue: 'The handle is permanent enough to matter — it is the /c/ address people share. Everything else can be edited afterwards.',
              })}>
              <View className="px-4 py-3 gap-2">
                <TextInput
                  className="text-[15px] text-foreground border border-border rounded-xl px-3 py-2.5"
                  value={handleInput}
                  onChangeText={setHandleInput}
                  maxLength={CHANNEL_HANDLE_MAX_LENGTH}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={t('channels.handlePlaceholder', { defaultValue: 'handle' })}
                  placeholderTextColor={colors.textSecondary}
                  editable={!createMutation.isPending}
                />
                <TextInput
                  className="text-[15px] text-foreground border border-border rounded-xl px-3 py-2.5"
                  value={titleInput}
                  onChangeText={setTitleInput}
                  maxLength={MAX_CHANNEL_TITLE_LENGTH}
                  placeholder={t('channels.titlePlaceholder', { defaultValue: 'Channel name' })}
                  placeholderTextColor={colors.textSecondary}
                  onSubmitEditing={handleCreate}
                  returnKeyType="done"
                  editable={!createMutation.isPending}
                />
                <TouchableOpacity
                  onPress={handleCreate}
                  disabled={!canCreate}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  className={`items-center justify-center rounded-full py-2.5 ${canCreate ? 'bg-primary' : 'bg-border'}`}>
                  {createMutation.isPending ? (
                    <SpinnerIcon size={16} className="text-primary-foreground" />
                  ) : (
                    <Text className="text-primary-foreground text-[13px] font-bold">
                      {t('channels.create', { defaultValue: 'Create channel' })}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </SettingsListGroup>
          ) : null}

          <SettingsListGroup title={t('channels.discover', { defaultValue: 'Discover' })}>
            {directoryQuery.isPending ? (
              <View className="py-10 items-center">
                <Loading className="text-primary" size="large" style={{ flex: undefined }} />
              </View>
            ) : directoryQuery.isError ? (
              <View className="py-4">
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
            ) : directory.length === 0 ? (
              <View className="py-4">
                <EmptyState
                  title={t('channels.emptyDirectory', { defaultValue: 'No channels to discover yet' })}
                  icon={{ name: 'megaphone-outline', size: 48 }}
                />
              </View>
            ) : (
              <>
                {directory.map((channel) => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    headerRight={
                      canUsePrivateApi ? (
                        <ChannelFollowButton
                          isFollowing={followedHere.has(channel.id)}
                          isPending={pendingFollowId === channel.id}
                          onPress={() => handleFollowToggle(channel)}
                        />
                      ) : undefined
                    }
                  />
                ))}
                {directoryQuery.hasNextPage ? (
                  <TouchableOpacity
                    onPress={() => directoryQuery.fetchNextPage()}
                    disabled={directoryQuery.isFetchingNextPage}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    className="items-center justify-center py-4">
                    {directoryQuery.isFetchingNextPage ? (
                      <SpinnerIcon size={18} className="text-primary" />
                    ) : (
                      <Text className="text-primary text-sm font-semibold">
                        {t('common.loadMore', { defaultValue: 'Load more' })}
                      </Text>
                    )}
                  </TouchableOpacity>
                ) : null}
              </>
            )}
          </SettingsListGroup>
        </ScrollView>
      </ThemedView>
    </>
  );
}
