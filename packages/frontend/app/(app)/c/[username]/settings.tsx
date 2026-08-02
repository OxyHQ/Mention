import React, { useCallback, useMemo } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { Switch } from '@oxyhq/bloom/switch';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services/ui/client';
import { createLogger } from '@oxyhq/core/logger';
import { getNormalizedUserHandle, type AccountNode } from '@oxyhq/core';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { EmptyState } from '@/components/common/EmptyState';
import { channelAccountService, type ChannelAccountSettings } from '@/services/channelAccountService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getErrorMessage } from '@/utils/apiError';

const channelSettingsLogger = createLogger('ChannelAccountSettings');

/**
 * What an OPERATOR can change about a channel from inside Mention.
 *
 * Deliberately small, and small for a reason: a channel is an Oxy account, so
 * its handle, name, avatar, bio and membership are Oxy's and are managed where
 * every other account is. Re-implementing them here would be a second identity
 * surface for the same account, which is exactly the shape this whole model
 * replaced. What remains is the one thing Oxy has no concept of — whether a post
 * the channel publishes also names the person who wrote it.
 *
 * The screen refuses early rather than showing a form whose every write 403s:
 * the account list already says whether the caller operates this channel, so
 * asking is free.
 */
export default function ChannelAccountSettingsScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const routeHandle = String(username ?? '');
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { user, oxyServices, canUsePrivateApi, isAuthenticated, isAuthResolved, isPrivateApiPending } =
    useAuth();
  const viewerId = user?.id;

  const headerOptions = useMemo(
    () => ({
      title: t('channels.settings.title', { defaultValue: 'Channel settings' }),
      leftComponents: [
        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
          <BackArrowIcon size={20} className="text-foreground" />
        </IconButton>,
      ],
    }),
    [t, safeBack],
  );

  // Waits for the cold boot to settle rather than firing while the session is
  // still resolving: an anonymous answer would report "not an operator" for an
  // operator, with nothing to refetch it.
  const readsReady = routeHandle.length > 0 && isAuthResolved && !isPrivateApiPending;

  const { data: accounts = [], isPending: accountsPending } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(viewerId),
    queryFn: () => oxyServices.listAccounts(),
    enabled: readsReady && canUsePrivateApi,
  });

  // Matched on the canonical handle rather than on the raw segment, so the one
  // spelling rule the rest of the app uses decides here too.
  const channel = useMemo(
    () =>
      accounts.find(
        (account) =>
          account.kind === 'channel' && getNormalizedUserHandle(account.account) === routeHandle,
      ),
    [accounts, routeHandle],
  );

  if (!isAuthenticated) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <OxyAuthPrompt
          label={t('channels.signInRequired', { defaultValue: 'Sign in to manage your channels' })}
          description={t('channels.signInRequiredDesc', {
            defaultValue: 'A channel is an account people follow without following the people who write for it.',
          })}
        />
      </ThemedView>
    );
  }

  if (!readsReady || accountsPending) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <View className="flex-1 items-center justify-center">
          <SpinnerIcon size={28} className="text-primary" />
        </View>
      </ThemedView>
    );
  }

  if (!channel) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <EmptyState
          title={t('channels.settings.operatorOnly', {
            defaultValue: 'Only an operator can manage this channel',
          })}
          icon={{ name: 'lock-closed-outline', size: 48 }}
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header options={headerOptions} hideBottomBorder disableSticky />
      <ChannelAccountSettingsForm accountId={channel.accountId} />
    </ThemedView>
  );
}

function ChannelAccountSettingsForm({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const viewerId = user?.id;

  const settingsQueryKey = viewerQueryKeys.channelAccountSettings(viewerId, accountId);
  const { data: settings, isPending } = useQuery<ChannelAccountSettings>({
    queryKey: settingsQueryKey,
    queryFn: () => channelAccountService.getSettings(accountId),
  });

  const signPostsMutation = useMutation<ChannelAccountSettings, unknown, boolean>({
    mutationFn: (signPosts) => channelAccountService.setSignPosts(accountId, signPosts),
    // Written straight into this screen's own cache: the server already
    // answered, and a refetch would repaint the screen for one boolean.
    onSuccess: (applied) => queryClient.setQueryData(settingsQueryKey, applied),
    onError: (error) => {
      const fallback = t('channels.settings.saveFailed', {
        defaultValue: 'Failed to update the channel',
      });
      channelSettingsLogger.error(fallback, error, { accountId });
      toast(getErrorMessage(error, fallback), { type: 'error' });
    },
  });

  const handleSignPostsChange = useCallback(
    (value: boolean) => signPostsMutation.mutate(value),
    [signPostsMutation],
  );

  if (isPending) {
    return (
      <View className="flex-1 items-center justify-center">
        <SpinnerIcon size={28} className="text-primary" />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="py-2"
      showsVerticalScrollIndicator={false}>
      <SettingsListGroup
        title={t('channels.settings.byline', { defaultValue: 'Byline' })}
        footer={t('channels.settings.signPostsFooter', {
          defaultValue:
            'The channel signs its own posts. With this on, the person who wrote one is named alongside it — with it off, they never leave the server at all.',
        })}>
        <SettingsListItem
          icon={<Ionicons name="person-outline" size={20} color={colors.textSecondary} />}
          title={t('channels.settings.signPosts', { defaultValue: 'Name the writer' })}
          showChevron={false}
          rightElement={
            <Switch
              value={settings?.signPosts === true}
              onValueChange={handleSignPostsChange}
              disabled={signPostsMutation.isPending}
            />
          }
        />
      </SettingsListGroup>

      {/* Not a settings group: there is no row here to tap. It says where the
          rest of a channel lives, because a screen called "Channel settings"
          that holds one switch otherwise reads as if the rest went missing. */}
      <Text className="text-muted-foreground text-[13px] px-4 py-3">
        {t('channels.settings.identityFooter', {
          defaultValue:
            'The channel’s name, handle, picture and the people who may publish as it belong to the account itself — change them where you manage your Oxy accounts.',
        })}
      </Text>
    </ScrollView>
  );
}
