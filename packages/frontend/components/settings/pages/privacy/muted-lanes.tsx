import { EmptyState } from "@/components/common/EmptyState";
import { viewerQueryKeys } from "@/lib/viewerQueryKeys";
import { lanesService } from "@/services/lanesService";
import { noteLaneListsChanged } from "@/stores/laneInvalidation";
import { getErrorMessage } from "@/utils/apiError";
import type { MutedLane } from "@mention/shared-types";
import { Admonition } from "@oxy.so/bloom/admonition";
import { Button } from "@oxy.so/bloom/button";
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { toast } from "@oxy.so/bloom/toast";
import { getNormalizedUserHandle } from "@oxy.so/core";
import { createLogger } from "@oxy.so/core/logger";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

const mutedLanesLogger = createLogger("MutedLanes");

/**
 * The lanes this reader has silenced.
 *
 * Deliberately narrower than muted words, and the copy says so: a muted word is
 * a safety rule about content the reader must not be shown, so it applies in
 * search and notifications too. A muted lane is a TIMELINE preference — "don't
 * push me this track" — so it applies to feeds only, and opening the post or
 * searching for it still works. Suppressing a deliberate retrieval would just
 * make the product look broken.
 */
export default function MutedLanesScreen() {
  const { t } = useTranslation();

  const { isAuthenticated, user, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();

  const mutedQueryKey = viewerQueryKeys.mutedLanes(user?.id);
  const {
    data: muted = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<MutedLane[]>({
    queryKey: mutedQueryKey,
    queryFn: () => lanesService.listMuted(),
    enabled: canUsePrivateApi,
  });

  const unmuteMutation = useMutation<void, unknown, string>({
    mutationFn: (laneId: string) => lanesService.unmute(laneId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: mutedQueryKey });
      // Unmuting puts posts BACK into every feed this reader opens, which
      // is the same reach a mute had — so it is the same signal.
      noteLaneListsChanged("mute");
      toast(t("lanes.muted.unmuted", { defaultValue: "Lane unmuted" }), {
        type: "success",
      });
    },
    onError: (error) => {
      mutedLanesLogger.error("Failed to unmute lane", error);
      toast(
        getErrorMessage(
          error,
          t("lanes.muted.unmuteFailed", {
            defaultValue: "Failed to unmute lane",
          }),
        ),
        { type: "error" },
      );
    },
  });

  if (!isAuthenticated) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t("lanes.muted.signInRequired", {
            defaultValue: "Sign in to manage muted lanes",
          })}
          description={t("lanes.muted.description", {
            defaultValue:
              "A muted lane stops appearing in your feeds. You keep following its author, and everything else they post still reaches you.",
          })}
        />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <View className="mb-4">
          <Admonition type="info">
            {t("lanes.muted.description", {
              defaultValue:
                "A muted lane stops appearing in your feeds. You keep following its author, and everything else they post still reaches you.",
            })}
          </Admonition>
        </View>

        <SettingsSection
          label={t("lanes.muted.title", { defaultValue: "Muted lanes" })}
        >
          <SettingsCard>
            {isLoading ? (
              <View className="py-10 items-center">
                <Loading
                  className="text-primary"
                  size="large"
                  style={{ flex: undefined }}
                />
              </View>
            ) : isError ? (
              <View className="py-4">
                <EmptyState
                  title={t("lanes.muted.loadFailed", {
                    defaultValue: "Failed to load muted lanes",
                  })}
                  icon={{ name: "alert-circle-outline", size: 48 }}
                  error={{
                    title: t("lanes.muted.loadFailed", {
                      defaultValue: "Failed to load muted lanes",
                    }),
                    message: t("common.tryAgain", {
                      defaultValue: "Try again",
                    }),
                    onRetry: async () => {
                      await refetch();
                    },
                  }}
                />
              </View>
            ) : muted.length === 0 ? (
              <View className="py-4">
                <EmptyState
                  title={t("lanes.muted.empty", {
                    defaultValue: "No muted lanes",
                  })}
                  icon={{ name: "volume-mute-outline", size: 48 }}
                />
              </View>
            ) : (
              muted.map((entry) => {
                // The publisher's handle comes from the canonical Oxy
                // identity the server resolved; an owner that could not
                // be resolved is dropped there, never rendered blank.
                const handle = getNormalizedUserHandle(entry.owner) || "";
                return (
                  <SettingsRow
                    label={entry.lane.name}
                    description={handle ? `@${handle}` : undefined}
                    key={entry.lane.id}
                  >
                    {
                      <Button
                        size="small"
                        appearance="subtle"
                        tone="danger"
                        onPress={() => unmuteMutation.mutate(entry.lane.id)}
                        accessibilityLabel={t("lanes.muted.unmute", {
                          defaultValue: "Unmute",
                        })}
                      >
                        {t("lanes.muted.unmute", { defaultValue: "Unmute" })}
                      </Button>
                    }
                  </SettingsRow>
                );
              })
            )}
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
