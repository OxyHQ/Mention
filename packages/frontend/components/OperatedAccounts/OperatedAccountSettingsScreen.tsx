import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { type ReactNode, useCallback, useMemo } from 'react';
import { ScrollView, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { AccountSettings, type AccountSettingsProps } from '@oxy.so/services/screens';
import { getNormalizedUserHandle, type AccountNode } from '@oxy.so/core';

import { useSafeBack } from '@/hooks/useSafeBack';
import { EmptyState } from '@/components/common/EmptyState';
import { noteIdentityChanged } from '@/lib/actorCache';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { ChannelBylineSettings } from './ChannelBylineSettings';
import { CommunityModerationSettings } from './CommunityModerationSettings';
import { useOperatedAccountArchive } from './useOperatedAccountArchive';

/** The member-operated account kinds (`isMemberOperatedKind`) Mention manages. */
export type OperatedAccountKind = 'channel' | 'community';

interface OperatedAccountSettingsScreenProps {
  kind: OperatedAccountKind;
  /** The account's handle, read by the route from its own segment. */
  handle: string;
}

/**
 * The settings of a member-operated account — a channel at
 * `/c/<handle>/settings`, a community at `/@<handle>/settings`.
 *
 * Everything an Oxy account has — its picture, name, description, categories,
 * members and archive — is Oxy's own `AccountSettings`, embedded; Oxy alone
 * decides who may change what. Mention adds only what is Mention's:
 *
 * - a channel's byline (Oxy has no concept of it), and the posts a channel
 *   takes with it when it is deleted;
 * - a community's bans;
 * - its own caches of the identity, told of every profile write so a post
 *   already on screen shows the new name and picture.
 *
 * It refuses early rather than showing a form whose every write 403s: the
 * account list already says whether the caller operates this account.
 */
export function OperatedAccountSettingsScreen({
  kind,
  handle,
}: OperatedAccountSettingsScreenProps) {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const {
    user,
    oxyServices,
    canUsePrivateApi,
    isAuthenticated,
    isAuthResolved,
    isPrivateApiPending,
  } = useAuth();

  // Static keys per kind rather than a `${kind}` template, so every key stays
  // visible to `scripts/validate-i18n.mjs` and to a translator's search.
  const copy =
    kind === 'channel'
      ? {
          title: t('channels.settings.title'),
          signInRequired: t('channels.signInRequired'),
          signInRequiredDesc: t('channels.signInRequiredDesc'),
          operatorOnly: t('channels.settings.operatorOnly'),
        }
      : {
          title: t('communities.settings.title'),
          signInRequired: t('communities.signInRequired'),
          signInRequiredDesc: t('communities.signInRequiredDesc'),
          operatorOnly: t('communities.settings.operatorOnly'),
        };

  // Waits for the cold boot to settle rather than firing while the session is
  // still resolving: an anonymous answer would report "not an operator" for an
  // operator, with nothing to refetch it.
  const readsReady = handle.length > 0 && isAuthResolved && !isPrivateApiPending;

  const { data: accounts = [], isPending: accountsPending } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.accounts.list(),
    enabled: readsReady && canUsePrivateApi,
  });

  // Matched on the canonical handle rather than on the raw segment, so the one
  // spelling rule the rest of the app uses decides here too.
  const node = useMemo(
    () =>
      accounts.find(
        (account) => account.kind === kind && getNormalizedUserHandle(account.account) === handle,
      ),
    [accounts, kind, handle],
  );

  let body: ReactNode;
  if (!isAuthenticated) {
    body = <OxyAuthPrompt label={copy.signInRequired} description={copy.signInRequiredDesc} />;
  } else if (!readsReady || accountsPending) {
    body = <FormSkeleton />;
  } else if (!node) {
    body = <EmptyState title={copy.operatorOnly} sticker="operatorOnly" />;
  } else {
    body = <OperatedAccountSettings accountId={node.accountId} kind={kind} />;
  }

  return (
    <View className="flex-1">
      <PageHeader title={copy.title} onBack={() => safeBack()} backLabel={t('common.back')} />
      {body}
    </View>
  );
}

function OperatedAccountSettings({
  accountId,
  kind,
}: {
  accountId: string;
  kind: OperatedAccountKind;
}) {
  const { user } = useAuth();
  const viewerId = user?.id;
  const archive = useOperatedAccountArchive(kind);

  // The SDK's user cache already holds the write; `noteIdentityChanged` reaches
  // Mention's own copies — the identity overlay every post row reads, and the
  // operated-accounts list — which the SDK cannot see.
  const handleUpdated = useCallback<NonNullable<AccountSettingsProps['onUpdated']>>(
    (account, { cleared }) => noteIdentityChanged(account, viewerId, { cleared }),
    [viewerId],
  );

  return (
    <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
      <AccountSettings
        accountId={accountId}
        onUpdated={handleUpdated}
        archive={archive}
        extraSections={
          kind === 'channel' ? (
            <ChannelBylineSettings accountId={accountId} />
          ) : (
            <CommunityModerationSettings accountId={accountId} />
          )
        }
      />
    </ScrollView>
  );
}
