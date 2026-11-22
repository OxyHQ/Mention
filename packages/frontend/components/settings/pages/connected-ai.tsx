import { ListSkeleton, SettingsSkeleton } from '@/components/loading/ContentSkeleton';
import { EmptyState } from '@/components/common/EmptyState';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { confirmDialog } from '@/utils/alerts';
import { MCP_RESOURCE_URL } from '@/config';
import { getErrorMessage } from '@/utils/apiError';
import { formatRelativeTime, useBloomLocale } from '@oxy.so/bloom/locale';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';

import { toast } from '@oxy.so/bloom/toast';
import { createLogger } from '@oxy.so/core/logger';
import type { ConnectedMcpClient } from '@oxy.so/core';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import {
  Button as LButton,
  Embed,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  IconCircle as LIconCircle,
  Loading,
  RawText,
  SettingsSection as LSettingsSection,
  Text as LText,
  VStack,
  defineTokens,
  toElement,
} from '@oxy.so/bloom-language';

const logger = createLogger('ConnectedAiSettings');

/** The empty state's explanation keeps to a readable measure. */
const appTokens = defineTokens({ space: { emptyText: 340 } });

const KNOWN_MCP_CLIENTS: Record<string, string> = {
  claude: 'Claude',
  'claude-desktop': 'Claude',
  'claude-code': 'Claude Code',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
};

function connectionLabel(connection: ConnectedMcpClient): string {
  if (connection.clientName) return connection.clientName;
  return KNOWN_MCP_CLIENTS[connection.clientId?.toLowerCase()] ?? connection.clientId;
}

export default function ConnectedAiScreen() {
  const { t } = useTranslation();
  const locale = useBloomLocale();

  const { user, oxyServices, isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const queryClient = useQueryClient();

  const {
    data: connections = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<ConnectedMcpClient[]>({
    queryKey: viewerQueryKeys.connectedAi(user?.id),
    // Oxy authorizes every MCP connector, for every app; the ones bound to
    // this deployment's MCP server are the ones that can act on Mention.
    queryFn: async () => {
      const clients = await oxyServices.apps.connected.mcpClients();
      return clients.filter((client) => client.resource.replace(/\/+$/, '') === MCP_RESOURCE_URL);
    },
    enabled: canUsePrivateApi,
  });

  const revokeMutation = useMutation<void, unknown, string>({
    mutationFn: async (connectionId: string) => {
      await oxyServices.apps.connected.revokeMcpClient(connectionId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.connectedAi(user?.id),
      });
      toast(t('mcp.connections.revoked', { defaultValue: 'Access revoked' }), {
        type: 'success',
      });
    },
    onError: (error) => {
      logger.error('Failed to revoke MCP connection', error);
      toast(
        getErrorMessage(
          error,
          t('mcp.connections.revokeError', {
            defaultValue: "Couldn't revoke access. Please try again.",
          }),
        ),
        { type: 'error' },
      );
    },
  });

  const handleRevoke = useCallback(
    async (connection: ConnectedMcpClient) => {
      const confirmed = await confirmDialog({
        title: t('mcp.connections.revokeConfirm.title', {
          defaultValue: 'Revoke access?',
        }),
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
    return toElement(VStack(Embed(<SettingsSkeleton />)).spacing('lg'));
  }

  if (!canUsePrivateApi) {
    return toElement(
      VStack(
        Embed(
          <OxyAuthPrompt
            label={t('mcp.connections.signInRequired', {
              defaultValue: 'Sign in to manage connected apps',
            })}
            description={t('mcp.connections.signInRequiredDesc', {
              defaultValue:
                'Sign in to review and revoke AI apps connected to your Mention account.',
            })}
          />,
        ),
      ).spacing('lg'),
    );
  }

  return toElement(
    VStack(
      VStack(
        Embed(
          isLoading ? (
            <ListSkeleton />
          ) : isError ? (
            <EmptyState
              sticker="offline"
              error={{
                title: t('mcp.connections.loadError', {
                  defaultValue: "Couldn't load connected apps",
                }),
                message: t('common.tryAgain', { defaultValue: 'Try again' }),
                onRetry: async () => {
                  await refetch();
                },
              }}
            />
          ) : connections.length === 0 ? (
            toElement(
              VStack(
                LIconCircle(RiSparklingLine),
                RawText(
                  t('mcp.connections.empty.title', {
                    defaultValue: 'No connected apps',
                  }),
                )
                  .font('xl')
                  .leading('28px')
                  .weight('bold')
                  .foreground('foreground')
                  .textAlign('center'),
                RawText(
                  t('mcp.connections.empty.description', {
                    defaultValue:
                      'AI apps you authorize to access your Mention account will appear here. You can revoke access anytime.',
                  }),
                )
                  .font('md')
                  .foreground('muted')
                  .textAlign('center')
                  .frame({ maxWidth: appTokens.space.emptyText }),
              )
                .padding('horizontal', '2xl')
                .padding('vertical', '4xl')
                .align('center')
                .spacing('md'),
            )
          ) : (
            toElement(
              LSettingsSection(
                undefined,
                LGroupedSection(
                  Embed(
                    connections.map((connection) => {
                      const revoking =
                        revokeMutation.isPending && revokeMutation.variables === connection.id;
                      const timeLine = connection.lastUsedAt
                        ? t('mcp.connections.lastUsed', {
                            defaultValue: 'Last used {{time}}',
                            time: formatRelativeTime(new Date(connection.lastUsedAt), locale, {
                              style: 'short',
                            }),
                          })
                        : connection.createdAt
                          ? t('mcp.connections.connected', {
                              defaultValue: 'Connected {{time}}',
                              time: formatRelativeTime(new Date(connection.createdAt), locale, {
                                style: 'short',
                              }),
                            })
                          : undefined;
                      const row = LGroupedSectionItem(connectionLabel(connection)).wrapControl();
                      return toElement(
                        (timeLine === undefined ? row : row.description(timeLine)).trailing(
                          revoking
                            ? Loading().style('inline').size('sm')
                            : LButton(
                                LText(t('mcp.connections.revoke', { defaultValue: 'Revoke' })),
                              )
                                .style('subtle')
                                .tint('neutral')
                                .size('sm')
                                .onPress(() => handleRevoke(connection))
                                .disabled(revokeMutation.isPending),
                        ),

                        connection.id,
                      );
                    }),
                  ),
                ),
              ).description(
                t('mcp.connections.footer', {
                  defaultValue:
                    'These apps can access your Mention account on your behalf. Revoke any you no longer use.',
                }),
              ),
            )
          ),
        ),
      ).spacing('lg'),
    ).spacing('lg'),
  );
}
