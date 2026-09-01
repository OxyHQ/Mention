import React, { useMemo } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services/ui/client';
import { getNormalizedUserHandle, type AccountNode } from '@oxyhq/core';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { EmptyState } from '@/components/common/EmptyState';
import { InsightsView } from '@/components/insights/InsightsView';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/**
 * A CHANNEL's insights — the same dashboard a person gets at `/insights`, about
 * an account instead of about a login.
 *
 * ## Why a channel needed its own door
 *
 * `/insights` reports on the SESSION, and a channel can never be a session:
 * `isDelegatedActAsEligibleKind` refuses `channel`, so no token's subject is ever one.
 * Its numbers were computable the whole time — a channel post's `authorship`
 * owner IS the channel, which is what the account-level aggregation matches on —
 * and simply unaskable. This route asks, by naming the account.
 *
 * ## The gate is the RESOLUTION, not a check beside it
 *
 * The channel is looked up in the accounts the viewer operates, so a viewer who
 * does not operate it finds nothing and gets the refusal below. There is no
 * second predicate that could answer differently from the lookup, and no request
 * is made for a channel the viewer has no claim on.
 *
 * That is the affordance's half of the rule; the server enforces its own,
 * against the same authority that decides who may publish as the account
 * (`viewerOperatesAccount` → `assertCanPublishAsAccount`). So the set of people
 * offered this screen and the set the API answers for are derived from one
 * membership model rather than kept in step by hand — and the affordance is the
 * narrower of the two, never the wider.
 *
 * Modelled on `/c/<handle>/settings`, deliberately: it is the same question
 * ("does this viewer run this channel"), so it gets the same shape, the same
 * shared `operatedAccounts` cache and the same refusal.
 */
export default function ChannelInsightsScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const routeHandle = String(username ?? '');
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { user, oxyServices, canUsePrivateApi, isAuthenticated, isAuthResolved, isPrivateApiPending } =
    useAuth();
  const viewerId = user?.id;

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

  const headerOptions = useMemo(
    () => ({
      title: t('insights.title'),
      // Whose numbers these are. The display name comes straight off the account
      // DTO; a channel with none falls back to the handle the reader navigated
      // by, never to a raw id.
      subtitle: channel?.account.name?.displayName?.trim() || `@${routeHandle}`,
      leftComponents: [
        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
          <BackArrowIcon size={20} className="text-foreground" />
        </IconButton>,
      ],
    }),
    [t, safeBack, channel, routeHandle],
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
          title={t('channels.insights.operatorOnly', {
            defaultValue: 'Only an operator can see this channel’s insights',
          })}
          icon={{ name: 'lock-closed-outline', size: 48 }}
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header options={headerOptions} hideBottomBorder disableSticky />
      <InsightsView accountId={channel.accountId} />
    </ThemedView>
  );
}
