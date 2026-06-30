import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TextInput } from 'react-native';
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
    disconnect,
    isDisconnecting,
    canSelfHostSign,
  } = useMentionNode();

  const [showConnectForm, setShowConnectForm] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [nodePublicKey, setNodePublicKey] = useState('');

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
          </>
        ) : (
          <>
            {/* No node — explain + offer create/connect */}
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
                    'A node is your own copy of your signed posts. Create a managed vault in one tap, or connect a node you run yourself.',
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

            <SettingsListGroup title={t('settings.node.connect.title', { defaultValue: 'Advanced' })}>
              <SettingsListItem
                icon={<RowIcon name="server-outline" />}
                title={t('settings.node.connect.ownTitle', { defaultValue: 'Connect your own node' })}
                description={t('settings.node.connect.ownDesc', {
                  defaultValue: 'Register a node you self-host (endpoint + public key)',
                })}
                onPress={() => setShowConnectForm((prev) => !prev)}
                showChevron={false}
                rightElement={
                  <Icon
                    name={showConnectForm ? 'chevron-up' : 'chevron-down'}
                    size={20}
                    color={colors.textSecondary}
                  />
                }
              />
            </SettingsListGroup>

            {showConnectForm && (
              <View className="px-5 pb-4 gap-3">
                <View className="gap-1.5">
                  <Text className="text-xs text-muted-foreground">
                    {t('settings.node.connect.endpointLabel', { defaultValue: 'Node endpoint (HTTPS URL)' })}
                  </Text>
                  <TextInput
                    className="px-3.5 py-2.5 rounded-xl border border-border text-[15px] text-foreground bg-card"
                    placeholder="https://node.example.com"
                    placeholderTextColor={colors.textSecondary}
                    value={endpoint}
                    onChangeText={setEndpoint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                  />
                </View>

                <View className="gap-1.5">
                  <Text className="text-xs text-muted-foreground">
                    {t('settings.node.connect.publicKeyLabel', { defaultValue: 'Node public key (hex)' })}
                  </Text>
                  <TextInput
                    className="px-3.5 py-2.5 rounded-xl border border-border text-[15px] text-foreground bg-card"
                    placeholder="04a1b2c3…"
                    placeholderTextColor={colors.textSecondary}
                    value={nodePublicKey}
                    onChangeText={setNodePublicKey}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                {/*
                  Self-host registration publishes a signed `app.mention.node`
                  record on the user's hash chain with the on-device identity key.
                  That signing is native-only (web KeyManager has no key) and is
                  not yet exposed on this screen — so we never fake-sign or call a
                  non-existent endpoint. We steer the user to the managed vault,
                  mirroring how the SDK splits self-signed vs custodial.
                */}
                <View
                  className="flex-row gap-2.5 p-3.5 rounded-xl"
                  style={{ backgroundColor: colors.info + '14' }}
                >
                  <Icon name="information-circle" size={18} color={colors.info} />
                  <Text className="flex-1 text-[13px] text-foreground">
                    {canSelfHostSign
                      ? t('settings.node.connect.nativeNotice', {
                          defaultValue:
                            'Self-hosted registration signs a record with your device identity key. This is coming to the app soon — for now, create a managed vault to get started.',
                        })
                      : t('settings.node.connect.webNotice', {
                          defaultValue:
                            'Connecting a node you host requires signing with your device identity key, which is only available in the Mention mobile app. Create a managed vault here instead.',
                        })}
                  </Text>
                </View>

                <Button
                  variant="primary"
                  onPress={() => createManagedVault()}
                  disabled={isCreatingVault}
                  icon={isCreatingVault ? undefined : 'shield-checkmark-outline'}
                >
                  {isCreatingVault
                    ? t('settings.node.create.creating', { defaultValue: 'Creating…' })
                    : t('settings.node.create.managedCta', { defaultValue: 'Create a managed vault' })}
                </Button>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </ThemedView>
  );
}
