import React, { useCallback } from 'react';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, Text, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxy.so/bloom/loading';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth, OxyAuthPrompt } from '@oxy.so/services/ui/client';
import { RowIcon } from '@/components/settings/RowIcon';
import { RiBox3Line, RiCheckboxCircleFill, RiCloseCircleLine, RiErrorWarningFill, RiShieldCheckLine } from '@oxy.so/bloom/icons';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { confirmDialog } from '@/utils/alerts';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';
import { getErrorMessage } from '@/utils/apiError';
import { useMentionNode, type MentionNode } from '@/hooks/useMentionNode';
import { EmptyState } from '@/components/common/EmptyState';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { Admonition } from '@oxy.so/bloom/admonition';

/** Inline notice shown when a node mutation (create vault / disconnect) fails. */
function ActionError({ message }: { message: string }) {
  return (
    <View className="mt-3">
      <Admonition type="error">{message}</Admonition>
    </View>
  );
}

/** Visual treatment for each liveness status — reuses theme status colors. */
function useStatusVisual(status: MentionNode['status']): {
  label: string;
  color: string;
  icon: BloomIcon;
} {
  const { t } = useTranslation();
  const { colors } = useTheme();
  switch (status) {
    case 'active':
      return {
        label: t('settings.node.status.active', { defaultValue: 'Active' }),
        color: colors.success,
        icon: RiCheckboxCircleFill,
      };
    case 'unreachable':
      return {
        label: t('settings.node.status.unreachable', { defaultValue: 'Unreachable' }),
        color: colors.warning,
        icon: RiErrorWarningFill,
      };
    case 'revoked':
    default:
      return {
        label: t('settings.node.status.revoked', { defaultValue: 'Revoked' }),
        color: colors.textSecondary,
        icon: RiCloseCircleLine,
      };
  }
}

function StatusBadge({ status }: { status: MentionNode['status'] }) {
  const { label, color, icon: StatusIcon } = useStatusVisual(status);
  return (
    <View
      className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full"
      style={{ backgroundColor: color + '20' }}
    >
      <StatusIcon width={14} height={14} fill={color} />
      <Text className="text-[13px] font-semibold" style={{ color }}>
        {label}
      </Text>
    </View>
  );
}

/** A read-only labelled detail row used inside the active-node card. */
function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <View className="px-5 py-3 border-t border-border">
      <Text className="text-xs text-muted-foreground mb-0.5">{label}</Text>
      <Text className="text-[15px] text-foreground" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

export default function MentionNodeScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { isAuthenticated, isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const {
    node,
    isLoading,
    isError,
    refetch,
    createManagedVault,
    isCreatingVault,
    createVaultError,
    disconnect,
    isDisconnecting,
    disconnectError,
  } = useMentionNode();

  const header = (
    <PageHeader title={t('settings.node.title', { defaultValue: 'Your Mention node' })} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />
  );

  const handleDisconnect = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t('settings.node.disconnect.confirmTitle', { defaultValue: 'Disconnect node?' }),
      message: t('settings.node.disconnect.confirmMessage', {
        defaultValue:
          'Your signed posts stay on your hash chain, but Mention will stop syncing with this node until you reconnect.',
      }),
      okText: t('settings.node.disconnect.action', { defaultValue: 'Disconnect' }),
      cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
      destructive: true,
    });
    if (confirmed) {
      disconnect();
    }
  }, [disconnect, t]);

  // Loading the SDK auth/private-API readiness, or the first node fetch.
  if (!isAuthResolved || isPrivateApiPending) {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      </View>
    );
  }

  if (!isAuthenticated || !canUsePrivateApi) {
    return (
      <View className="flex-1">
        {header}
        <OxyAuthPrompt
          label={t('settings.node.signInRequired', { defaultValue: 'Sign in to manage your node' })}
          description={t('settings.node.signInRequiredDesc', {
            defaultValue: 'A node is your own copy of your signed posts. Sign in to create or connect one.',
          })}
        />
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      {header}
      <ScrollView className="flex-1" contentContainerClassName="px-screen-margin py-2" showsVerticalScrollIndicator={false}>
        {isError ? (
          <EmptyState
            icon={{ name: 'cloud-offline-outline' }}
            error={{
              title: t('settings.node.loadError', { defaultValue: "Couldn't load your node" }),
              message: t('common.tryAgain', { defaultValue: 'Try again' }),
              onRetry: async () => {
                await refetch();
              },
            }}
          />
        ) : node && node.status !== 'revoked' ? (
          <>
            {/* Active / managed node card */}
            <SettingsListGroup variant="filled" title={t('settings.node.yourNode', { defaultValue: 'Your node' })}>
              <View className="px-5 py-4 flex-row items-center justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-[15px] font-semibold text-foreground">
                    {node.managed
                      ? t('settings.node.managedVault', { defaultValue: 'Managed vault' })
                      : t('settings.node.selfHosted', { defaultValue: 'Self-hosted node' })}
                  </Text>
                  <Text className="text-xs text-muted-foreground mt-0.5">
                    {node.managed
                      ? t('settings.node.managedVaultDesc', { defaultValue: 'Operated by Mention on your behalf' })
                      : t('settings.node.selfHostedDesc', { defaultValue: 'Operated by you' })}
                  </Text>
                </View>
                <StatusBadge status={node.status} />
              </View>

              <DetailRow
                label={t('settings.node.endpoint', { defaultValue: 'Endpoint' })}
                value={node.endpoint}
              />
              <DetailRow
                label={t('settings.node.mode', { defaultValue: 'Sync mode' })}
                value={
                  node.mode === 'push'
                    ? t('settings.node.modePush', { defaultValue: 'Mention pushes records' })
                    : t('settings.node.modePull', { defaultValue: 'Node pulls records' })
                }
              />
              <DetailRow
                label={t('settings.node.lastSync', { defaultValue: 'Last sync' })}
                value={
                  node.lastSyncedAt
                    ? formatRelativeTimeLocalized(node.lastSyncedAt, t)
                    : t('settings.node.neverSynced', { defaultValue: 'Not synced yet' })
                }
              />
              {typeof node.cursor === 'number' && (
                <DetailRow
                  label={t('settings.node.cursor', { defaultValue: 'Synced up to record' })}
                  value={`#${node.cursor}`}
                />
              )}
              {node.status === 'unreachable' && node.lastError ? (
                <DetailRow
                  label={t('settings.node.lastError', { defaultValue: 'Last error' })}
                  value={node.lastError}
                />
              ) : null}
            </SettingsListGroup>

            <SettingsListGroup variant="filled">
              <SettingsListItem
                icon={<RowIcon icon={RiCloseCircleLine} destructive />}
                title={t('settings.node.disconnect.action', { defaultValue: 'Disconnect' })}
                description={t('settings.node.disconnect.rowDesc', {
                  defaultValue: 'Stop syncing with this node',
                })}
                onPress={handleDisconnect}
                disabled={isDisconnecting}
                destructive
                showChevron={false}
                rightElement={
                  isDisconnecting ? (
                    <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
                  ) : undefined
                }
              />
            </SettingsListGroup>

            {disconnectError ? (
              <ActionError
                message={getErrorMessage(
                  disconnectError,
                  t('settings.node.disconnect.error', {
                    defaultValue: "Couldn't disconnect your node. Please try again.",
                  }),
                )}
              />
            ) : null}
          </>
        ) : (
          <>
            {/* No node — explain + offer the one working action (managed vault). */}
            <View className="px-6 pt-4 pb-2 items-center gap-3">
              <IconCircle icon={RiBox3Line} />
              <Text className="text-xl font-bold text-foreground text-center">
                {t('settings.node.empty.title', { defaultValue: 'Own your posts' })}
              </Text>
              <Text className="text-[15px] text-muted-foreground text-center max-w-[340px]">
                {t('settings.node.empty.description', {
                  defaultValue:
                    'A node is your own copy of your signed posts. Create a managed vault in one tap — Mention runs it for you, with nothing to host.',
                })}
              </Text>
            </View>

            <SettingsListGroup variant="filled" title={t('settings.node.create.title', { defaultValue: 'Recommended' })}>
              <SettingsListItem
                icon={<RowIcon icon={RiShieldCheckLine} />}
                title={t('settings.node.create.managedTitle', { defaultValue: 'Create a managed vault' })}
                description={t('settings.node.create.managedDesc', {
                  defaultValue: 'Mention runs it for you — one tap, nothing to host',
                })}
                onPress={() => createManagedVault()}
                disabled={isCreatingVault}
                showChevron={!isCreatingVault}
                rightElement={
                  isCreatingVault ? (
                    <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
                  ) : undefined
                }
              />
            </SettingsListGroup>

            {createVaultError ? (
              <ActionError
                message={getErrorMessage(
                  createVaultError,
                  t('settings.node.create.error', {
                    defaultValue: "Couldn't create your managed vault. Please try again.",
                  }),
                )}
              />
            ) : null}

            {/*
              Self-hosting your own node is registered by publishing a signed
              `app.mention.node` record onto your hash chain with your on-device
              identity key — there is no server-side BYO-endpoint registration to
              wire a form to. Until that signing flow ships in the mobile app, this
              screen exposes only the working managed-vault action and states the
              self-host path honestly rather than presenting a form that does nothing.
            */}
            <View className="mt-3">
              <Admonition type="info">
                {t('settings.node.selfHostNotice', {
                  defaultValue:
                    'Prefer to run your own node? Self-hosting is registered by signing a record with your device identity key — a flow coming to the Mention mobile app. For now, a managed vault gets you the same signed copy of your posts.',
                })}
              </Admonition>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
