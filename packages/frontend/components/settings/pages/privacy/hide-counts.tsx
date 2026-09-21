import {
  createPrivacySettingsCacheLease,
  updatePrivacySettingsCache,
  type UserSettingsResponse,
} from "@/hooks/usePrivacySettings";
import { authenticatedClient } from "@/utils/api";
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { createLogger } from "@oxy.so/core/logger";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

const hideCountsLogger = createLogger("HideCounts");

export default function HideCountsScreen() {
  const { t } = useTranslation();

  const { canUsePrivateApi, isPrivateApiPending, user } = useAuth();
  const [hideLikeCounts, setHideLikeCounts] = useState(false);
  const [hideShareCounts, setHideShareCounts] = useState(false);
  const [hideReplyCounts, setHideReplyCounts] = useState(false);
  const [hideSaveCounts, setHideSaveCounts] = useState(false);
  const [loading, setLoading] = useState(true);

  const allHidden =
    hideLikeCounts && hideShareCounts && hideReplyCounts && hideSaveCounts;

  useEffect(() => {
    if (isPrivateApiPending) {
      return;
    }
    if (!canUsePrivateApi) {
      setLoading(false);
      return;
    }
    loadSettings();
  }, [canUsePrivateApi, isPrivateApiPending]);

  const loadSettings = async () => {
    try {
      const response = await authenticatedClient.get<UserSettingsResponse>(
        "/profile/settings/me",
      );
      const settings = response.data;
      setHideLikeCounts(settings.privacy?.hideLikeCounts || false);
      setHideShareCounts(settings.privacy?.hideShareCounts || false);
      setHideReplyCounts(settings.privacy?.hideReplyCounts || false);
      setHideSaveCounts(settings.privacy?.hideSaveCounts || false);
      setLoading(false);
    } catch (error) {
      hideCountsLogger.error("Error loading settings", error);
      setLoading(false);
    }
  };

  const updateSetting = async (
    field:
      | "hideLikeCounts"
      | "hideShareCounts"
      | "hideReplyCounts"
      | "hideSaveCounts",
    value: boolean,
  ) => {
    const cacheLease = createPrivacySettingsCacheLease(user?.id);
    try {
      let currentPrivacy = {};
      try {
        const currentResponse =
          await authenticatedClient.get<UserSettingsResponse>(
            "/profile/settings/me",
          );
        currentPrivacy = currentResponse.data?.privacy || {};
      } catch (e) {
        hideCountsLogger.debug("Could not load current privacy settings", {
          error: e,
        });
      }

      const updatedPrivacy = {
        ...currentPrivacy,
        [field]: value,
      };
      await authenticatedClient.put("/profile/settings", {
        privacy: updatedPrivacy,
      });

      await updatePrivacySettingsCache(updatedPrivacy, cacheLease);
    } catch (error) {
      hideCountsLogger.error("Error updating setting", error);
      if (field === "hideLikeCounts") setHideLikeCounts(!value);
      if (field === "hideShareCounts") setHideShareCounts(!value);
      if (field === "hideReplyCounts") setHideReplyCounts(!value);
      if (field === "hideSaveCounts") setHideSaveCounts(!value);
    }
  };

  const updateAllSettings = async (value: boolean) => {
    const cacheLease = createPrivacySettingsCacheLease(user?.id);
    try {
      let currentPrivacy = {};
      try {
        const currentResponse =
          await authenticatedClient.get<UserSettingsResponse>(
            "/profile/settings/me",
          );
        currentPrivacy = currentResponse.data?.privacy || {};
      } catch (e) {
        hideCountsLogger.debug("Could not load current privacy settings", {
          error: e,
        });
      }

      const updatedPrivacy = {
        ...currentPrivacy,
        hideLikeCounts: value,
        hideShareCounts: value,
        hideReplyCounts: value,
        hideSaveCounts: value,
      };
      await authenticatedClient.put("/profile/settings", {
        privacy: updatedPrivacy,
      });

      setHideLikeCounts(value);
      setHideShareCounts(value);
      setHideReplyCounts(value);
      setHideSaveCounts(value);

      await updatePrivacySettingsCache(updatedPrivacy, cacheLease);
    } catch (error) {
      hideCountsLogger.error("Error updating all settings", error);
    }
  };

  if (isPrivateApiPending) {
    return (
      <View className="gap-4">
        <View className="flex-1 justify-center items-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t("settings.privacy.hideCounts.signInRequired", {
            defaultValue: "Sign in to hide engagement counts",
          })}
          description={t("settings.privacy.hideCounts.signInRequiredDesc", {
            defaultValue:
              "Hide likes, boosts, replies, and saves on your posts.",
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
              label={t("settings.privacy.hideAllCounts")}
              description={t("settings.privacy.hideAllCountsDesc")}
            >
              {
                <Switch
                  checked={allHidden}
                  onCheckedChange={(value) => updateAllSettings(value)}
                  accessibilityLabel={t("settings.privacy.hideAllCounts")}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection label={t("settings.privacy.individualSettings")}>
          <SettingsCard>
            <SettingsRow
              label={t("settings.privacy.hideLikeCounts")}
              description={t("settings.privacy.hideLikeCountsDesc")}
            >
              {
                <Switch
                  checked={hideLikeCounts}
                  onCheckedChange={(value) => {
                    setHideLikeCounts(value);
                    updateSetting("hideLikeCounts", value);
                  }}
                  accessibilityLabel={t("settings.privacy.hideLikeCounts")}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.privacy.hideShareCounts")}
              description={t("settings.privacy.hideShareCountsDesc")}
            >
              {
                <Switch
                  checked={hideShareCounts}
                  onCheckedChange={(value) => {
                    setHideShareCounts(value);
                    updateSetting("hideShareCounts", value);
                  }}
                  accessibilityLabel={t("settings.privacy.hideShareCounts")}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.privacy.hideReplyCounts")}
              description={t("settings.privacy.hideReplyCountsDesc")}
            >
              {
                <Switch
                  checked={hideReplyCounts}
                  onCheckedChange={(value) => {
                    setHideReplyCounts(value);
                    updateSetting("hideReplyCounts", value);
                  }}
                  accessibilityLabel={t("settings.privacy.hideReplyCounts")}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.privacy.hideSaveCounts")}
              description={t("settings.privacy.hideSaveCountsDesc")}
            >
              {
                <Switch
                  checked={hideSaveCounts}
                  onCheckedChange={(value) => {
                    setHideSaveCounts(value);
                    updateSetting("hideSaveCounts", value);
                  }}
                  accessibilityLabel={t("settings.privacy.hideSaveCounts")}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
