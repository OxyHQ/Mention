import { useExternalEmbedsStore } from "@/stores/externalEmbedsStore";
import {
  EXTERNAL_EMBED_SOURCES,
  externalEmbedLabels,
} from "@mention/shared-types/externalEmbeds";
import { Admonition } from "@oxy.so/bloom/admonition";
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

export default function ExternalMediaSettingsScreen() {
  const { t } = useTranslation();

  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const prefs = useExternalEmbedsStore((state) => state.prefs);
  const setPref = useExternalEmbedsStore((state) => state.setPref);

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
          label={t("settings.externalMedia.signInRequired", {
            defaultValue: "Sign in to manage external media",
          })}
          description={t("settings.externalMedia.signInRequiredDesc", {
            defaultValue:
              "Choose which third-party media players can load inline.",
          })}
        />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <View className="pb-1 pt-2">
          <Admonition type="info">
            {t("settings.externalMedia.banner", {
              defaultValue:
                'External media may allow websites to collect information about you and your device. No information is sent or requested until you press the "play" button.',
            })}
          </Admonition>
        </View>

        <SettingsSection
          label={t("settings.externalMedia.enableFor", {
            defaultValue: "Enable media players for",
          })}
        >
          <SettingsCard>
            {EXTERNAL_EMBED_SOURCES.map((source) => (
              <SettingsRow label={externalEmbedLabels[source]} key={source}>
                {
                  <Switch
                    value={prefs[source] === "show"}
                    onValueChange={() =>
                      setPref(
                        source,
                        prefs[source] === "show" ? "hide" : "show",
                      )
                    }
                  />
                }
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
