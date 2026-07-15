import React, { useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxyhq/bloom/loading';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton, Button } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { RowIcon } from '@/components/settings/RowIcon';
import { Icon, type IconName } from '@/lib/icons';
import { useSafeBack } from '@/hooks/useSafeBack';
import { confirmDialog } from '@/utils/alerts';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';
import { useMentionNode, type MentionNode } from '@/hooks/useMentionNode';

/** Pull a human-readable message off an axios-style mutation error without `as any`. */
function getNodeErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { error?: string; message?: string } } }).response;
    return response?.data?.error || response?.data?.message || fallback;
  }
  return fallback;
}

/** Inline notice shown when a node mutation (create vault / disconnect) fails. */
function ActionError({ message }: { message: string }) {
  const { colors } = useTheme();
  return (
    <View className="flex-row gap-2.5 mx-5 mt-3 p-3.5 rounded-xl" style={{ backgroundColor: colors.error + '14' }}>
      <Icon name="alert-circle" size={18} color={colors.error} />
      <Text className="flex-1 text-[13px] text-foreground">{message}</Text>
    </View>
  );
}

/** Visual treatment for each liveness status — reuses theme status colors. */
function useStatusVisual(status: MentionNode['status']): {
  label: string;
  color: string;
  icon: IconName;
} {
  const { t } = useTranslation();
  const { colors } = useTheme();
  switch (status) {
    case 'active':
      return {
        label: t('settings.node.status.active', { defaultValue: 'Active' }),
        color: colors.success,
        icon: 'checkmark-circle',
      };
    case 'unreachable':
      return {
        label: t('settings.node.status.unreachable', { defaultValue: 'Unreachable' }),
        color: colors.warning,
        icon: 'alert-circle',
      };
    case 'revoked':
    default:
      return {
        label: t('settings.node.status.revoked', { defaultValue: 'Revoked' }),
        color: colors.textSecondary,
        icon: 'close-circle',
      };
  }
}

function StatusBadge({ status }: { status: MentionNode['status'] }) {
  const { label, color, icon } = useStatusVisual(status);
  return (
    <View
      className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full"
      style={{ backgroundColor: color + '20' }}
    >
      <Icon name={icon} size={14} color={color} />
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
  const { colors } = useTheme();
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
    <Header
      options={{
        title: t('settings.node.title', { defaultValue: 'Your Mention node' }),
        leftComponents: [
          <IconButton variant="icon" key="back" onPress={() => safeBack()}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
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
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      </ThemedView>
    );
  }

  if (!isAuthenticated || !canUsePrivateApi) {
    return (
      <ThemedView className="flex-1">
        {header}
        <OxyAuthPrompt
          label={t('settings.node.signInRequired', { defaultValue: 'Sign in to manage your node' })}
          description={t('settings.node.signInRequiredDesc', {
            defaultValue: 'A node is your own copy of your signed posts. Sign in to create or connect one.',
          })}
        />
      </ThemedView>
    );
  }

  if (isLoading) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      <ScrollView className="flex-1" contentContainerClassName="py-2" showsVerticalScrollIndicator={false}>
        {isError ? (
          <View className="px-6 py-10 items-center gap-3">
            <Icon name="cloud-offline-outline" size={44} color={colors.textSecondary} />
            <Text className="text-base text-foreground text-center">
              {t('settings.node.loadError', { defaultValue: "Couldn't load your node" })}
            </Text>
            <Button variant="secondary" size="small" onPress={() => refetch()}>
              {t('common.retry', { defaultValue: 'Retry' })}
            </Button>
          </View>
        ) : node && node.status !== 'revoked' ? (
          <>
            {/* Active / managed node card */}
            <SettingsListGroup title={t('settings.node.yourNode', { defaultValue: 'Your node' })}>
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

            <SettingsListGroup>
              <SettingsListItem
                icon={<RowIcon name="unlink-outline" destructive />}
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
                message={getNodeErrorMessage(
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
              <View
                className="w-16 h-16 rounded-full items-center justify-center"
                style={{ backgroundColor: colors.primary + '1A' }}
              >
                <Icon name="cube-outline" size={32} color={colors.primary} />
              </View>
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

            <SettingsListGroup title={t('settings.node.create.title', { defaultValue: 'Recommended' })}>
              <SettingsListItem
                icon={<RowIcon name="shield-checkmark-outline" />}
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
                message={getNodeErrorMessage(
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
            <View className="flex-row gap-2.5 mx-5 mt-3 p-3.5 rounded-xl" style={{ backgroundColor: colors.info + '14' }}>
              <Icon name="information-circle" size={18} color={colors.info} />
              <Text className="flex-1 text-[13px] text-foreground">
                {t('settings.node.selfHostNotice', {
                  defaultValue:
                    'Prefer to run your own node? Self-hosting is registered by signing a record with your device identity key — a flow coming to the Mention mobile app. For now, a managed vault gets you the same signed copy of your posts.',
                })}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}
