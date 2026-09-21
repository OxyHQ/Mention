import type { BloomIcon } from "@/components/settings/RowIcon";
import { SettingsSelect } from "@/components/settings/SettingsSelect";
import { useSettingsBack as useSafeBack } from "@/context/MentionSettingsContext";
import {
  createPrivacySettingsCacheLease,
  updatePrivacySettingsCache,
  type UserSettingsResponse,
} from "@/hooks/usePrivacySettings";
import { alertDialog } from "@/utils/alerts";
import { authenticatedClient } from "@/utils/api";
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { Loading } from "@oxy.so/bloom/loading";
import { SettingsGeneralPage } from "@oxy.so/bloom/settings-modal";
import { logger } from "@oxy.so/core/logger";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

type VisibilityOption = "public" | "private" | "followers_only";

interface VisibilityOptionConfig {
  value: VisibilityOption;
  label: string;
  description: string;
  icon: BloomIcon;
}

export default function ProfileVisibilityScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const {
    isAuthenticated,
    isAuthResolved,
    canUsePrivateApi,
    isPrivateApiPending,
    user,
  } = useAuth();

  const [profileVisibility, setProfileVisibility] =
    useState<VisibilityOption>("public");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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
      setProfileVisibility(settings.privacy?.profileVisibility || "public");
      setLoading(false);
    } catch (error) {
      logger.error("Error loading settings", error);
      setLoading(false);
    }
  };

  const handleSave = async (newVisibility: VisibilityOption) => {
    if (newVisibility === profileVisibility) {
      safeBack();
      return;
    }

    setSaving(true);
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
        logger.debug("Could not load current privacy settings", { error: e });
      }

      const updatedPrivacy = {
        ...currentPrivacy,
        profileVisibility: newVisibility,
      };
      await authenticatedClient.put("/profile/settings", {
        privacy: updatedPrivacy,
      });

      await updatePrivacySettingsCache(updatedPrivacy, cacheLease);

      setProfileVisibility(newVisibility);
      await alertDialog({
        title: t("common.success"),
        message: t("settings.privacy.profileVisibilityUpdated"),
      });
      setTimeout(() => {
        safeBack();
      }, 300);
    } catch (error) {
      const err = error as { response?: { data?: { error?: string } } };
      logger.error("Error updating profile visibility", error);
      await alertDialog({
        title: t("common.error"),
        message:
          err?.response?.data?.error || t("settings.privacy.updateError"),
      });
    } finally {
      setSaving(false);
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
          label={t("settings.privacy.profileVisibility.signInRequired", {
            defaultValue: "Sign in to set profile visibility",
          })}
          description={t(
            "settings.privacy.profileVisibility.signInRequiredDesc",
            { defaultValue: "Choose who can see your profile and posts." },
          )}
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

  const options: VisibilityOptionConfig[] = [
    {
      value: "public",
      label: t("settings.privacy.public"),
      description: t("settings.privacy.publicDescription"),
      icon: RiEarthLine,
    },
    {
      value: "followers_only",
      label: t("settings.privacy.followersOnly"),
      description: t("settings.privacy.followersOnlyDescription"),
      icon: RiGroupLine,
    },
    {
      value: "private",
      label: t("settings.privacy.private"),
      description: t("settings.privacy.privateDescription"),
      icon: RiLockLine,
    },
  ];

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: "privacy",
          rows: [
            {
              key: "visibility",
              label: t("settings.privacy.privateProfile"),
              description: options.find(
                (option) => option.value === profileVisibility,
              )?.description,
              control: (
                <SettingsSelect
                  label={t("settings.privacy.privateProfile")}
                  value={profileVisibility}
                  onChange={(value) => {
                    if (!saving) void handleSave(value);
                  }}
                  items={options.map((option) => ({
                    value: option.value,
                    label: option.label,
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
