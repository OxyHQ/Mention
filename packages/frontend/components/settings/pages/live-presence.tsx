import type { BloomIcon } from "@/components/settings/RowIcon";
import { SettingsSelect } from "@/components/settings/SettingsSelect";
import {
  getLivePresencePreference,
  updateLivePresencePreference,
  type LiveVisibility,
} from "@/lib/syraApi";
import { viewerQueryKeys } from "@/lib/viewerQueryKeys";
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { Loading } from "@oxy.so/bloom/loading";
import { SettingsGeneralPage } from "@oxy.so/bloom/settings-modal";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

interface PresenceOption {
  value: LiveVisibility;
  labelKey: string;
  labelDefault: string;
  descKey: string;
  descDefault: string;
  icon: BloomIcon;
}

const OPTIONS: PresenceOption[] = [
  {
    value: "active",
    labelKey: "settings.livePresence.active",
    labelDefault: "When I'm in a live room",
    descKey: "settings.livePresence.activeDesc",
    descDefault:
      "Your avatar shows a live badge to others whenever you join a live room.",
    icon: RiBroadcastLine,
  },
  {
    value: "speaking",
    labelKey: "settings.livePresence.speaking",
    labelDefault: "Only when I'm speaking",
    descKey: "settings.livePresence.speakingDesc",
    descDefault: "Your avatar shows a live badge only while you hold the mic.",
    icon: RiMic2Line,
  },
];

export default function LivePresenceScreen() {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const { canUsePrivateApi, isPrivateApiPending, user } = useAuth();
  const viewerId = user?.id;
  const livePresenceQueryKey = viewerQueryKeys.livePresence(viewerId);

  const { data: preference, isLoading } = useQuery({
    queryKey: livePresenceQueryKey,
    queryFn: getLivePresencePreference,
    enabled: canUsePrivateApi && Boolean(viewerId),
    staleTime: 60_000,
  });

  const mutation = useMutation({
    mutationFn: updateLivePresencePreference,
    onMutate: async (next: LiveVisibility) => {
      await queryClient.cancelQueries({ queryKey: livePresenceQueryKey });
      const previous =
        queryClient.getQueryData<LiveVisibility>(livePresenceQueryKey);
      queryClient.setQueryData<LiveVisibility>(livePresenceQueryKey, next);
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context) {
        queryClient.setQueryData(livePresenceQueryKey, context.previous);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: livePresenceQueryKey });
    },
  });

  const selected: LiveVisibility = preference ?? "active";

  if (isPrivateApiPending) {
    return (
      <View className="gap-4">
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t("settings.livePresence.signInRequired", {
            defaultValue: "Sign in to manage your live presence",
          })}
          description={t("settings.livePresence.signInRequiredDesc", {
            defaultValue: "Choose when others see you live in a room.",
          })}
        />
      </View>
    );
  }

  if (isLoading) {
    return (
      <View className="gap-4">
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: "presence",
          rows: [
            {
              key: "visibility",
              label: t("settings.livePresence.title", {
                defaultValue: "Live presence",
              }),
              description: t("settings.livePresence.footer", {
                defaultValue:
                  "This controls when your avatar shows a live badge across Mention.",
              }),
              control: (
                <SettingsSelect
                  label={t("settings.livePresence.title", {
                    defaultValue: "Live presence",
                  })}
                  value={selected}
                  onChange={(value) => {
                    if (!mutation.isPending) mutation.mutate(value);
                  }}
                  items={OPTIONS.map((option) => ({
                    value: option.value,
                    label: t(option.labelKey, {
                      defaultValue: option.labelDefault,
                    }),
                  }))}
                />
              ),
            },
          ],
        },
      ]}
    />
  );
}
