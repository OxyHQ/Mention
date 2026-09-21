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

export default function OnlineStatusScreen() {
  const { t } = useTranslation();

  const { canUsePrivateApi, isPrivateApiPending } = useAuth();
  const [showOnlineStatus, setShowOnlineStatus] = useState(true);
  const [loading, setLoading] = useState(true);

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
      setShowOnlineStatus(settings.privacy?.showOnlineStatus !== false);
      setLoading(false);
    } catch (error) {
      logger.error("Error loading settings", error);
      setLoading(false);
    }
  };

  const updateSetting = async (value: boolean) => {
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
        showOnlineStatus: value,
      };
      await authenticatedClient.put("/profile/settings", {
        privacy: updatedPrivacy,
      });
    } catch (error) {
      logger.error("Error updating setting", error);
      setShowOnlineStatus(!value);
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
          label={t("settings.privacy.onlineStatus.signInRequired", {
            defaultValue: "Sign in to manage your online status",
          })}
          description={t("settings.privacy.onlineStatus.signInRequiredDesc", {
            defaultValue: "Decide whether others see when you are online.",
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
              label={t("settings.privacy.showOnlineStatus")}
              description={t("settings.privacy.showOnlineStatusDesc")}
            >
              {
                <Switch
                  checked={showOnlineStatus}
                  onCheckedChange={(value) => {
                    setShowOnlineStatus(value);
                    updateSetting(value);
                  }}
                  accessibilityLabel={t("settings.privacy.showOnlineStatus")}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
