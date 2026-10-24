import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { Field } from '@oxy.so/bloom/field';
import { InputGroup, InputGroupAddon } from '@oxy.so/bloom/input-group';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Item } from '@oxy.so/bloom/item';
import { useAuth } from '@oxy.so/services/ui/client';
import { accountNameMaxLength, getNormalizedUserHandle } from '@oxy.so/core';
import type { AccountNode } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { useRefreshJoinedCommunitiesAfterCreate } from '@/hooks/useCommunities';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';
import { ScreenReselect } from '@/components/common/ScreenReselect';
import { SignInRequired } from '@/components/common/SignInRequired';
import { profileBasePath, profileRouteFamily } from '@/components/Profile/profileRoute';
import type { OperatedAccountKind } from './OperatedAccountSettingsScreen';

/**
 * The accounts of one member-operated kind you operate, and the one place to
 * create another — the CHANNELS screen and the COMMUNITIES screen are this, with
 * their own words.
 *
 * Both are Oxy ACCOUNTS (`kind: 'channel' | 'community'`, `isMemberOperatedKind`),
 * so this reads the account graph rather than a Mention-local table, and
 * creating one is `POST /accounts` with the caller's OWN bearer — the same call
 * that mints an organization or a project. There is no privileged scope and no
 * server-side provisioning step: a signed-in person has already proven who they
 * are, and the account is a child under their own tree, with them as its owner.
 *
 * What makes these kinds different is enforced elsewhere and does not depend on
 * who created one: `createChildAccount` writes no auth method, so it is born with
 * no login, and `POST /accounts/:id/switch` refuses the kind — no session can
 * ever have one as its subject. A channel is published AS through the composer's
 * `publishAsOxyUserId`; a community is posted IN, through `communityOxyUserId`,
 * and its members are its moderators.
 */

/** Mirrors the server's `username` rule so the error arrives before the request. */
const HANDLE_REGEX = /^[a-zA-Z0-9_-]{3,30}$/;

/** The words one kind's screen speaks in. */
export interface OperatedAccountsCopy {
  title: string;
  signInRequired: string;
  signInRequiredDesc: string;
  createTitle: string;
  createSubtitle: string;
  handleLabel: string;
  titleLabel: string;
  create: string;
  yours: string;
  none: string;
  created: string;
  createFailed: string;
}

interface OperatedAccountsScreenProps {
  kind: OperatedAccountKind;
  copy: OperatedAccountsCopy;
}

export function OperatedAccountsScreen({ kind, copy }: OperatedAccountsScreenProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();
  const refreshJoinedCommunities = useRefreshJoinedCommunitiesAfterCreate();

  const [handle, setHandle] = useState('');
  const [title, setTitle] = useState('');

  const {
    data: accounts = [],
    isLoading,
    refetch,
  } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.accounts.list(),
    enabled: canUsePrivateApi,
  });
  const ofKind = useMemo(
    () => accounts.filter((account) => account.kind === kind),
    [accounts, kind],
  );

  const trimmedHandle = handle.trim();
  const trimmedTitle = title.trim();
  const handleError = trimmedHandle.length > 0 && !HANDLE_REGEX.test(trimmedHandle);
  const canCreate = HANDLE_REGEX.test(trimmedHandle) && trimmedTitle.length > 0;

  const createMutation = useMutation({
    mutationFn: () =>
      oxyServices.accounts.create({
        kind,
        username: trimmedHandle,
        // A channel or a community has a TITLE, not a given-and-family name, so
        // it sets the explicit display name rather than having one composed from
        // `first`.
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
      await refreshJoinedCommunities(kind);
      toast.success(copy.created);
      const created = getNormalizedUserHandle(account.account) ?? trimmedHandle;
      router.push(profileBasePath(profileRouteFamily(account.account), created));
    },
    onError: (error) => {
      logger.error(`[OperatedAccounts] Failed to create a ${kind}`, error);
      toast.error(copy.createFailed);
    },
  });

  const openAccount = useCallback(
    (account: AccountNode) => {
      const target = getNormalizedUserHandle(account.account);
      if (!target) return;
      router.push(profileBasePath(profileRouteFamily(account.account), target));
    },
    [router],
  );

  return (
    <Screen
      header={
        <PageHeader title={copy.title} backLabel={t('common.back', { defaultValue: 'Back' })} />
      }
    >
      <ScreenReselect refresh={refetch} />
      <SignInRequired label={copy.signInRequired} description={copy.signInRequiredDesc}>
        <ScreenScrollView contentContainerClassName="pb-10">
          <View className="px-4 pt-4 pb-2">
            <Text className="text-foreground text-lg font-bold">{copy.createTitle}</Text>
            <Text className="text-muted-foreground text-[13px] mt-1">{copy.createSubtitle}</Text>
          </View>

          <View className="px-4 gap-3">
            <Field
              error={
                handleError
                  ? t('channels.handleInvalid', {
                      defaultValue: '3–30 characters: letters, numbers, _ or -',
                    })
                  : null
              }
            >
              <InputGroup>
                <InputGroupAddon>@</InputGroupAddon>
                <TextFieldInput
                  label={copy.handleLabel}
                  placeholder={t('channels.handlePlaceholder', { defaultValue: 'handle' })}
                  value={handle}
                  onChangeText={setHandle}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
              </InputGroup>
            </Field>

            <TextFieldInput
              label={copy.titleLabel}
              placeholder={copy.titleLabel}
              value={title}
              onChangeText={setTitle}
              maxLength={accountNameMaxLength(kind)}
            />

            <Item
              onPress={canCreate && !createMutation.isPending ? createMutation.mutate : undefined}
              disabled={!canCreate || createMutation.isPending}
              title={
                createMutation.isPending
                  ? t('channels.creating', { defaultValue: 'Creating…' })
                  : copy.create
              }
            />
          </View>

          <View className="px-4 pt-8 pb-2">
            <Text className="text-foreground text-lg font-bold">{copy.yours}</Text>
          </View>

          {isLoading ? (
            <View className="py-8">
              <ListSkeleton />
            </View>
          ) : ofKind.length === 0 ? (
            <Text className="text-muted-foreground text-[14px] px-4 py-3">{copy.none}</Text>
          ) : (
            ofKind.map((account) => {
              const accountHandle = getNormalizedUserHandle(account.account) ?? '';
              return (
                <Item
                  key={account.accountId}
                  onPress={() => openAccount(account)}
                  title={displayNameOrHandle(
                    account.account.name?.displayName,
                    accountHandle ? `@${accountHandle}` : '',
                  )}
                  subtitle={accountHandle ? `@${accountHandle}` : undefined}
                />
              );
            })
          )}
        </ScreenScrollView>
      </SignInRequired>
    </Screen>
  );
}
