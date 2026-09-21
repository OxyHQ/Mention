import { EmptyState } from "@/components/common/EmptyState";
import { viewerQueryKeys } from "@/lib/viewerQueryKeys";
import { confirmDialog } from "@/utils/alerts";
import { api } from "@/utils/api";
import { getErrorMessage } from "@/utils/apiError";
import { formatRelativeTimeLocalized } from "@/utils/dateUtils";
import { Button } from "@oxy.so/bloom/button";
import { IconCircle } from "@oxy.so/bloom/icon-circle";
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { toast } from "@oxy.so/bloom/toast";
import { createLogger } from "@oxy.so/core/logger";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

const logger = createLogger("ConnectedAiSettings");

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
  claude: "Claude",
  "claude-desktop": "Claude",
  "claude-code": "Claude Code",
  chatgpt: "ChatGPT",
  cursor: "Cursor",
};

function connectionLabel(connection: McpConnection): string {
  if (connection.clientLabel) return connection.clientLabel;
  if (connection.clientName) return connection.clientName;
  return (
    KNOWN_MCP_CLIENTS[connection.clientId?.toLowerCase()] ?? connection.clientId
  );
}

function connectionTitle(connection: McpConnection): string {
  const label = connectionLabel(connection);
  const handle = connection.handle
    ? `@${connection.handle.replace(/^@+/, "")}`
    : undefined;
  if (handle) {
    return `${label} — ${handle}`;
  }
  return label;
}

function bundleSummary(handles: string[] | undefined): string | undefined {
  if (!handles || handles.length <= 1) return undefined;
  return handles.map((h) => `@${h.replace(/^@+/, "")}`).join(", ");
}

export default function ConnectedAiScreen() {
  const { t } = useTranslation();

  const { user, isAuthResolved, canUsePrivateApi, isPrivateApiPending } =
    useAuth();
  const queryClient = useQueryClient();

  const {
    data: connections = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<McpConnection[]>({
    queryKey: viewerQueryKeys.connectedAi(user?.id),
    queryFn: async () => {
      const response =
        await api.get<McpConnectionsResponse>("/mcp/connections");
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
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.connectedAi(user?.id),
      });
      toast(t("mcp.connections.revoked", { defaultValue: "Access revoked" }), {
        type: "success",
      });
    },
    onError: (error) => {
      logger.error("Failed to revoke MCP connection", error);
      toast(
        getErrorMessage(
          error,
          t("mcp.connections.revokeError", {
            defaultValue: "Couldn't revoke access. Please try again.",
          }),
        ),
        { type: "error" },
      );
    },
  });

  const handleRevoke = useCallback(
    async (connection: McpConnection) => {
      const confirmed = await confirmDialog({
        title: t("mcp.connections.revokeConfirm.title", {
          defaultValue: "Revoke access?",
        }),
        message: t("mcp.connections.revokeConfirm.message", {
          defaultValue:
            "{{client}} will no longer be able to access your Mention account until you authorize it again.",
          client: connectionLabel(connection),
        }),
        okText: t("mcp.connections.revoke", { defaultValue: "Revoke" }),
        cancelText: t("common.cancel", { defaultValue: "Cancel" }),
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
      <View className="gap-4">
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t("mcp.connections.signInRequired", {
            defaultValue: "Sign in to manage connected apps",
          })}
          description={t("mcp.connections.signInRequiredDesc", {
            defaultValue:
              "Sign in to review and revoke AI apps connected to your Mention account.",
          })}
        />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        {isLoading ? (
          <View className="py-10 items-center">
            <Loading />
          </View>
        ) : isError ? (
          <EmptyState
            icon={{ name: "cloud-offline-outline" }}
            error={{
              title: t("mcp.connections.loadError", {
                defaultValue: "Couldn't load connected apps",
              }),
              message: t("common.tryAgain", { defaultValue: "Try again" }),
              onRetry: async () => {
                await refetch();
              },
            }}
          />
        ) : connections.length === 0 ? (
          <View className="px-6 py-10 items-center gap-3">
            <IconCircle icon={RiSparklingLine} />
            <Text className="text-xl font-bold text-foreground text-center">
              {t("mcp.connections.empty.title", {
                defaultValue: "No connected apps",
              })}
            </Text>
            <Text className="text-[15px] text-muted-foreground text-center max-w-[340px]">
              {t("mcp.connections.empty.description", {
                defaultValue:
                  "AI apps you authorize to access your Mention account will appear here. You can revoke access anytime.",
              })}
            </Text>
          </View>
        ) : (
          <SettingsSection
            description={t("mcp.connections.footer", {
              defaultValue:
                "These apps can access your Mention account on your behalf. Revoke any you no longer use.",
            })}
          >
            <SettingsCard>
              {connections.map((connection) => {
                const revoking =
                  revokeMutation.isPending &&
                  revokeMutation.variables === connection.id;
                const bundleLine = bundleSummary(connection.bundleHandles);
                const timeLine = connection.lastUsedAt
                  ? t("mcp.connections.lastUsed", {
                      defaultValue: "Last used {{time}}",
                      time: formatRelativeTimeLocalized(
                        connection.lastUsedAt,
                        t,
                      ),
                    })
                  : connection.createdAt
                    ? t("mcp.connections.connected", {
                        defaultValue: "Connected {{time}}",
                        time: formatRelativeTimeLocalized(
                          connection.createdAt,
                          t,
                        ),
                      })
                    : undefined;
                const description =
                  [bundleLine, timeLine].filter(Boolean).join(" · ") ||
                  undefined;
                return (
                  <SettingsRow
                    label={connectionTitle(connection)}
                    description={description}
                    key={connection.id}
                  >
                    {revoking ? (
                      <Loading
                        className="text-primary"
                        variant="inline"
                        size="small"
                        style={{ flex: undefined }}
                      />
                    ) : (
                      <Button
                        appearance="subtle"
                        tone="neutral"
                        size="small"
                        onPress={() => handleRevoke(connection)}
                        disabled={revokeMutation.isPending}
                      >
                        {t("mcp.connections.revoke", {
                          defaultValue: "Revoke",
                        })}
                      </Button>
                    )}
                  </SettingsRow>
                );
              })}
            </SettingsCard>
          </SettingsSection>
        )}
      </View>
    </View>
  );
}
