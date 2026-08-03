import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxyhq/bloom/toast';
import { Item } from '@oxyhq/bloom/item';
import { Loading } from '@oxyhq/bloom/loading';
import { useAuth } from '@oxyhq/services/ui/client';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { AccountNode } from '@oxyhq/core';
import { logger } from '@oxyhq/core/logger';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';
import { cn } from '@/lib/utils';

/**
 * The channels you operate, and the one place to create another.
 *
 * A channel is an Oxy ACCOUNT (`kind: 'channel'`), so this reads the account
 * graph rather than a Mention-local table, and creating one is
 * `POST /accounts` with the caller's OWN bearer — the same call that mints an
 * organization or a project. There is no privileged scope and no server-side
 * provisioning step: a signed-in person has already proven who they are, and a
 * channel is a child account under their own tree.
 *
 * What makes a channel different is enforced elsewhere and does not depend on
 * who created it: `createChildAccount` writes no auth method, so it is born with
 * no login, and `POST /accounts/:id/switch` refuses the kind — no session can
 * ever have a channel as its subject. That is why a channel is never in the
 * account switcher, and why publishing as one goes through the composer's
 * `publishAsOxyUserId` rather than by becoming it.
 */

/** Mirrors the server's `username` rule so the error arrives before the request. */
const HANDLE_REGEX = /^[a-zA-Z0-9_-]{3,30}$/;
const MAX_TITLE_LENGTH = 100;

export default function ChannelsScreen() {
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();

  const [handle, setHandle] = useState('');
  const [title, setTitle] = useState('');

  const { data: accounts = [], isLoading } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.listAccounts(),
    enabled: canUsePrivateApi,
  });

  const channels = useMemo(
    () => accounts.filter((account) => account.kind === 'channel'),
    [accounts],
  );

  const trimmedHandle = handle.trim();
  const trimmedTitle = title.trim();
  const handleError = trimmedHandle.length > 0 && !HANDLE_REGEX.test(trimmedHandle);
  const canCreate = HANDLE_REGEX.test(trimmedHandle) && trimmedTitle.length > 0;

  const createMutation = useMutation({
    mutationFn: () =>
      oxyServices.createAccount({
        kind: 'channel',
        username: trimmedHandle,
        // A channel has a TITLE, not a given-and-family name, so it sets the
        // explicit display name rather than having one composed from `first`.
        name: { displayName: trimmedTitle },
      }),
    onSuccess: async (account) => {
      setHandle('');
      setTitle('');
      // The picker in the composer reads the same key, so it must not keep
      // serving a list this screen just added to.
      await queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.operatedAccounts(user?.id),
      });
      toast.success(t('channels.created', { defaultValue: 'Channel created' }));
      const created = getNormalizedUserHandle(account.account) ?? trimmedHandle;
      router.push(`/c/${created}`);
    },
    onError: (error) => {
      logger.error('[Channels] Failed to create a channel', error);
      toast.error(
        t('channels.createFailed', { defaultValue: 'Failed to create the channel' }),
      );
    },
  });

  const openChannel = useCallback((account: AccountNode) => {
    const target = getNormalizedUserHandle(account.account);
    if (!target) return;
    router.push(`/c/${target}`);
  }, []);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('channels.title', { defaultValue: 'Channels' }),
          leftComponents: [
            <IconButton key="back" variant="icon" onPress={safeBack}>
              <BackArrowIcon size={22} className="text-foreground" />
            </IconButton>,
          ],
        }}
      />

      <ScrollView className="flex-1" contentContainerClassName="pb-10">
        <View className="px-4 pt-4 pb-2">
          <Text className="text-foreground text-lg font-bold">
            {t('channels.createTitle', { defaultValue: 'Create a channel' })}
          </Text>
          <Text className="text-muted-foreground text-[13px] mt-1">
            {t('channels.createSubtitle', {
              defaultValue:
                'A channel posts under its own name. People follow it without following you.',
            })}
          </Text>
        </View>

        <View className="px-4 gap-3">
          <View>
            <TextInput
              value={handle}
              onChangeText={setHandle}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t('channels.handlePlaceholder', { defaultValue: 'handle' })}
              accessibilityLabel={t('channels.handleLabel', { defaultValue: 'Channel handle' })}
              className={cn(
                'bg-secondary text-foreground rounded-2xl px-4 py-3 text-[15px]',
                handleError && 'border border-destructive',
              )}
            />
            {handleError && (
              <Text className="text-destructive text-[12px] mt-1 px-1">
                {t('channels.handleInvalid', {
                  defaultValue: '3–30 characters: letters, numbers, _ or -',
                })}
              </Text>
            )}
          </View>

          <TextInput
            value={title}
            onChangeText={setTitle}
            maxLength={MAX_TITLE_LENGTH}
            placeholder={t('channels.titlePlaceholder', { defaultValue: 'Channel name' })}
            accessibilityLabel={t('channels.titleLabel', { defaultValue: 'Channel name' })}
            className="bg-secondary text-foreground rounded-2xl px-4 py-3 text-[15px]"
          />

          <Item
            onPress={canCreate && !createMutation.isPending ? createMutation.mutate : undefined}
            disabled={!canCreate || createMutation.isPending}
            title={
              createMutation.isPending
                ? t('channels.creating', { defaultValue: 'Creating…' })
                : t('channels.create', { defaultValue: 'Create channel' })
            }
          />
        </View>

        <View className="px-4 pt-8 pb-2">
          <Text className="text-foreground text-lg font-bold">
            {t('channels.yours', { defaultValue: 'Your channels' })}
          </Text>
        </View>

        {isLoading ? (
          <View className="py-8">
            <Loading />
          </View>
        ) : channels.length === 0 ? (
          <Text className="text-muted-foreground text-[14px] px-4 py-3">
            {t('channels.none', { defaultValue: 'You do not operate any channel yet.' })}
          </Text>
        ) : (
          channels.map((account) => {
            const accountHandle = getNormalizedUserHandle(account.account) ?? '';
            return (
              <Item
                key={account.accountId}
                onPress={() => openChannel(account)}
                title={displayNameOrHandle(
                  account.account.name?.displayName,
                  accountHandle ? `@${accountHandle}` : '',
                )}
                subtitle={accountHandle ? `@${accountHandle}` : undefined}
              />
            );
          })
        )}
      </ScrollView>
    </ThemedView>
  );
}
