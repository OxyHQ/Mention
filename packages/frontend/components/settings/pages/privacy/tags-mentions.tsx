import type { UserSettingsResponse } from "@/hooks/usePrivacySettings";
import { authenticatedClient } from "@/utils/api";
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { logger } from "@oxy.so/core/logger";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

export default function TagsMentionsScreen() {
  const { t } = useTranslation();

  const {
    isAuthenticated,
    isAuthResolved,
    canUsePrivateApi,
    isPrivateApiPending,
  } = useAuth();
  const [allowTags, setAllowTags] = useState(true);
  const [allowMentions, setAllowMentions] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthResolved || isPrivateApiPending) {
      return;
    }
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    loadSettings();
  }, [isAuthResolved, isPrivateApiPending, isAuthenticated]);

  const loadSettings = async () => {
    try {
      const response = await authenticatedClient.get<UserSettingsResponse>(
        "/profile/settings/me",
      );
      const settings = response.data;
      setAllowTags(settings.privacy?.allowTags !== false);
      setAllowMentions(settings.privacy?.allowMentions !== false);
      setLoading(false);
    } catch (error) {
      logger.error("Error loading settings", error);
      setLoading(false);
    }
  };

  const updateSetting = async (
    field: "allowTags" | "allowMentions",
    value: boolean,
  ) => {
    try {
      let currentPrivacy = {};
      try {
        const currentResponse =
          await authenticatedClient.get<UserSettingsResponse>(
            "/profile/settings/me",
          );
        currentPrivacy = currentResponse.data?.privacy || {};
      } catch (e) {
        logger.debug("Could not load current privacy settings", { error: e });
      }

      const updatedPrivacy = {
        ...currentPrivacy,
        [field]: value,
      };
      await authenticatedClient.put("/profile/settings", {
        privacy: updatedPrivacy,
      });
    } catch (error) {
      logger.error("Error updating setting", error);
      if (field === "allowTags") setAllowTags(!value);
      if (field === "allowMentions") setAllowMentions(!value);
    }
  };

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
          label={t("settings.privacy.tagsMentions.signInRequired", {
            defaultValue: "Sign in to manage tags and mentions",
          })}
          description={t("settings.privacy.tagsMentions.signInRequiredDesc", {
            defaultValue: "Control who can tag or mention you in posts.",
          })}
        />
      </View>
    );
  }

  if (loading) {
    return (
      <View className="gap-4">
        <View className="flex-1 justify-center items-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              label={t("settings.privacy.allowTags")}
              description={t("settings.privacy.allowTagsDesc")}
            >
              {
                <Switch
                  checked={allowTags}
                  onCheckedChange={(value) => {
                    setAllowTags(value);
                    updateSetting("allowTags", value);
                  }}
                  accessibilityLabel={t("settings.privacy.allowTags")}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.privacy.allowMentions")}
              description={t("settings.privacy.allowMentionsDesc")}
            >
              {
                <Switch
                  checked={allowMentions}
                  onCheckedChange={(value) => {
                    setAllowMentions(value);
                    updateSetting("allowMentions", value);
                  }}
                  accessibilityLabel={t("settings.privacy.allowMentions")}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
