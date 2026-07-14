import React, { useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loading } from '@oxyhq/bloom/loading';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton, Button } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { RowIcon } from '@/components/settings/RowIcon';
import { Icon } from '@/lib/icons';
import { useSafeBack } from '@/hooks/useSafeBack';
import { confirmDialog } from '@/utils/alerts';
import { formatRelativeTimeLocalized } from '@/utils/dateUtils';
import { api } from '@/utils/api';
import { getErrorMessage } from '@/utils/apiError';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('ConnectedAiSettings');

const MCP_CONNECTIONS_QUERY_KEY = ['mcp-connections'] as const;

interface McpConnection {
  id: string;
  clientId: string;
  clientLabel?: string;
  clientName?: string;
  scopes?: string[];
  bundleId?: string | null;
  isBundlePrimary?: boolean;
  handle?: string;
  displayName?: string;
  bundleHandles?: string[];
  createdAt?: string;
  lastUsedAt?: string;
}

interface McpConnectionsResponse {
  connections: McpConnection[];
  count?: number;
}

const KNOWN_MCP_CLIENTS: Record<string, string> = {
  claude: 'Claude',
  'claude-desktop': 'Claude',
  'claude-code': 'Claude Code',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
};

function connectionLabel(connection: McpConnection): string {
  if (connection.clientLabel) return connection.clientLabel;
  if (connection.clientName) return connection.clientName;
  return KNOWN_MCP_CLIENTS[connection.clientId?.toLowerCase()] ?? connection.clientId;
}

function connectionTitle(connection: McpConnection): string {
  const label = connectionLabel(connection);
  const handle = connection.handle ? `@${connection.handle.replace(/^@+/, '')}` : undefined;
  if (handle) {
    return `${label} — ${handle}`;
  }
  return label;
}

function bundleSummary(handles: string[] | undefined): string | undefined {
  if (!handles || handles.length <= 1) return undefined;
  return handles.map((h) => `@${h.replace(/^@+/, '')}`).join(', ');
}

export default function ConnectedAiScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const safeBack = useSafeBack();
  const { user, isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const queryClient = useQueryClient();

  const header = (
    <Header
      options={{
        title: t('mcp.connections.title', { defaultValue: 'Connected AI' }),
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

  const {
    data: connections = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<McpConnection[]>({
    queryKey: [...MCP_CONNECTIONS_QUERY_KEY, user?.id],
    queryFn: async () => {
      const response = await api.get<McpConnectionsResponse>('/mcp/connections');
      const rows = response.data?.connections;
      return Array.isArray(rows) ? rows : [];
    },
    enabled: canUsePrivateApi,
  });

  const revokeMutation = useMutation<void, unknown, string>({
    mutationFn: async (connectionId: string) => {
      await api.delete(`/mcp/connections/${connectionId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MCP_CONNECTIONS_QUERY_KEY });
      toast(t('mcp.connections.revoked', { defaultValue: 'Access revoked' }), { type: 'success' });
    },
    onError: (error) => {
      logger.error('Failed to revoke MCP connection', { error });
      toast(
        getErrorMessage(
          error,
          t('mcp.connections.revokeError', { defaultValue: "Couldn't revoke access. Please try again." }),
        ),
        { type: 'error' },
      );
    },
  });

  const handleRevoke = useCallback(
    async (connection: McpConnection) => {
      const confirmed = await confirmDialog({
        title: t('mcp.connections.revokeConfirm.title', { defaultValue: 'Revoke access?' }),
        message: t('mcp.connections.revokeConfirm.message', {
          defaultValue:
            '{{client}} will no longer be able to access your Mention account until you authorize it again.',
          client: connectionLabel(connection),
        }),
        okText: t('mcp.connections.revoke', { defaultValue: 'Revoke' }),
        cancelText: t('common.cancel', { defaultValue: 'Cancel' }),
        destructive: true,
      });
      if (confirmed) {
        revokeMutation.mutate(connection.id);
      }
    },
    [revokeMutation, t],
  );

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

  if (!canUsePrivateApi) {
    return (
      <ThemedView className="flex-1">
        {header}
        <OxyAuthPrompt
          label={t('mcp.connections.signInRequired', { defaultValue: 'Sign in to manage connected apps' })}
          description={t('mcp.connections.signInRequiredDesc', {
            defaultValue: 'Sign in to review and revoke AI apps connected to your Mention account.',
          })}
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      <ScrollView className="flex-1" contentContainerClassName="py-2" showsVerticalScrollIndicator={false}>
        {isLoading ? (
          <View className="py-10 items-center">
            <Loading />
          </View>
        ) : isError ? (
          <View className="px-6 py-10 items-center gap-3">
            <Icon name="cloud-offline-outline" size={44} color={colors.textSecondary} />
            <Text className="text-base text-foreground text-center">
              {t('mcp.connections.loadError', { defaultValue: "Couldn't load connected apps" })}
            </Text>
            <Button variant="secondary" size="small" onPress={() => refetch()}>
              {t('common.retry', { defaultValue: 'Retry' })}
            </Button>
          </View>
        ) : connections.length === 0 ? (
          <View className="px-6 py-10 items-center gap-3">
            <View
              className="w-16 h-16 rounded-full items-center justify-center"
              style={{ backgroundColor: colors.primary + '1A' }}
            >
              <Icon name="sparkles-outline" size={32} color={colors.primary} />
            </View>
            <Text className="text-xl font-bold text-foreground text-center">
              {t('mcp.connections.empty.title', { defaultValue: 'No connected apps' })}
            </Text>
            <Text className="text-[15px] text-muted-foreground text-center max-w-[340px]">
              {t('mcp.connections.empty.description', {
                defaultValue:
                  'AI apps you authorize to access your Mention account will appear here. You can revoke access anytime.',
              })}
            </Text>
          </View>
        ) : (
          <SettingsListGroup
            footer={t('mcp.connections.footer', {
              defaultValue: 'These apps can access your Mention account on your behalf. Revoke any you no longer use.',
            })}
          >
            {connections.map((connection) => {
              const revoking = revokeMutation.isPending && revokeMutation.variables === connection.id;
              const bundleLine = bundleSummary(connection.bundleHandles);
              const timeLine = connection.lastUsedAt
                ? t('mcp.connections.lastUsed', {
                    defaultValue: 'Last used {{time}}',
                    time: formatRelativeTimeLocalized(connection.lastUsedAt, t),
                  })
                : connection.createdAt
                  ? t('mcp.connections.connected', {
                      defaultValue: 'Connected {{time}}',
                      time: formatRelativeTimeLocalized(connection.createdAt, t),
                    })
                  : undefined;
              const description = [bundleLine, timeLine].filter(Boolean).join(' · ') || undefined;
              return (
                <SettingsListItem
                  key={connection.id}
                  icon={<RowIcon name="sparkles-outline" />}
                  title={connectionTitle(connection)}
                  description={description}
                  showChevron={false}
                  rightElement={
                    revoking ? (
                      <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
                    ) : (
                      <Button
                        variant="secondary"
                        size="small"
                        onPress={() => handleRevoke(connection)}
                        disabled={revokeMutation.isPending}
                      >
                        {t('mcp.connections.revoke', { defaultValue: 'Revoke' })}
                      </Button>
                    )
                  }
                />
              );
            })}
          </SettingsListGroup>
        )}
      </ScrollView>
    </ThemedView>
  );
}
