import { useSettingsRouter as useRouter } from "@/context/MentionSettingsContext";
import type { UserSettingsResponse } from "@/hooks/usePrivacySettings";
import { authenticatedClient } from "@/utils/api";
import { Button } from "@oxy.so/bloom/button";
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { toast } from "@oxy.so/bloom/toast";
import { logger } from "@oxy.so/core/logger";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

interface NotificationPreferences {
  pushEnabled: boolean;
  emailEnabled: boolean;
  likes: boolean;
  boosts: boolean;
  follows: boolean;
  mentions: boolean;
  replies: boolean;
  quotes: boolean;
}

const DEFAULT_PREFS: NotificationPreferences = {
  pushEnabled: true,
  emailEnabled: false,
  likes: true,
  boosts: true,
  follows: true,
  mentions: true,
  replies: true,
  quotes: true,
};

export default function NotificationSettingsScreen() {
  const { t } = useTranslation();
  const router = useRouter();

  const { canUsePrivateApi, isPrivateApiPending } = useAuth();

  const [prefs, setPrefs] = useState<NotificationPreferences>(DEFAULT_PREFS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isPrivateApiPending) {
      return;
    }
    if (!canUsePrivateApi) {
      setLoading(false);
      return;
    }
    loadPreferences();
  }, [canUsePrivateApi, isPrivateApiPending]);

  const loadPreferences = async () => {
    try {
      const response = await authenticatedClient.get<UserSettingsResponse>(
        "/profile/settings/me",
      );
      const settings = response.data;
      if (settings.notificationPreferences) {
        setPrefs({ ...DEFAULT_PREFS, ...settings.notificationPreferences });
      }
    } catch (error) {
      logger.error("Error loading notification preferences", error);
    } finally {
      setLoading(false);
    }
  };

  const updatePreference = useCallback(
    async (key: keyof NotificationPreferences, value: boolean) => {
      const previous = prefs;
      const updated = { ...prefs, [key]: value };
      setPrefs(updated);

      try {
        setSaving(true);
        await authenticatedClient.put("/profile/settings", {
          notificationPreferences: { [key]: value },
        });
      } catch (error) {
        logger.error("Error updating notification preferences", error);
        setPrefs(previous);
        toast(
          t("settings.notifications.saveError", {
            defaultValue: "Failed to save notification preference",
          }),
          { type: "error" },
        );
      } finally {
        setSaving(false);
      }
    },
    [prefs, t],
  );

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
          label={t("settings.notifications.signInRequired", {
            defaultValue: "Sign in to manage notifications",
          })}
          description={t("settings.notifications.signInRequiredDesc", {
            defaultValue: "Choose what alerts you receive and how.",
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
      {saving ? <Loading variant="inline" size="small" /> : null}
      <View className="gap-4">
        <SettingsSection
          label={t("settings.notifications.sections.general", {
            defaultValue: "General",
          })}
        >
          <SettingsCard>
            <SettingsRow
              label={t("settings.notifications.push", {
                defaultValue: "Push notifications",
              })}
              description={t("settings.notifications.pushDesc", {
                defaultValue: "Receive push notifications on your device",
              })}
            >
              {
                <Switch
                  checked={prefs.pushEnabled}
                  onCheckedChange={(v) => updatePreference("pushEnabled", v)}
                  accessibilityLabel={t("settings.notifications.push", {
                    defaultValue: "Push notifications",
                  })}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.notifications.email", {
                defaultValue: "Email notifications",
              })}
              description={t("settings.notifications.emailDesc", {
                defaultValue: "Receive email summaries of your notifications",
              })}
            >
              {
                <Switch
                  checked={prefs.emailEnabled}
                  onCheckedChange={(v) => updatePreference("emailEnabled", v)}
                  accessibilityLabel={t("settings.notifications.email", {
                    defaultValue: "Email notifications",
                  })}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          label={t("settings.notifications.sections.activity", {
            defaultValue: "Activity from others",
          })}
        >
          <SettingsCard>
            <SettingsRow
              label={t("subscription.list.title", {
                defaultValue: "Activity notifications",
              })}
              description={t("subscription.list.entryDesc", {
                defaultValue: "Accounts that notify you when they post",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() =>
                  router.push("/settings/notifications/subscriptions")
                }
                accessibilityLabel={t("subscription.list.title", {
                  defaultValue: "Activity notifications",
                })}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          label={t("settings.notifications.sections.types", {
            defaultValue: "Notification types",
          })}
        >
          <SettingsCard>
            <SettingsRow
              label={t("settings.notifications.likes", {
                defaultValue: "Likes",
              })}
              description={t("settings.notifications.likesDesc", {
                defaultValue: "When someone likes your post",
              })}
            >
              {
                <Switch
                  checked={prefs.likes}
                  onCheckedChange={(v) => updatePreference("likes", v)}
                  accessibilityLabel={t("settings.notifications.likes", {
                    defaultValue: "Likes",
                  })}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.notifications.boosts", {
                defaultValue: "Boosts",
              })}
              description={t("settings.notifications.boostsDesc", {
                defaultValue: "When someone boosts your post",
              })}
            >
              {
                <Switch
                  checked={prefs.boosts}
                  onCheckedChange={(v) => updatePreference("boosts", v)}
                  accessibilityLabel={t("settings.notifications.boosts", {
                    defaultValue: "Boosts",
                  })}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.notifications.follows", {
                defaultValue: "New followers",
              })}
              description={t("settings.notifications.followsDesc", {
                defaultValue: "When someone follows you",
              })}
            >
              {
                <Switch
                  checked={prefs.follows}
                  onCheckedChange={(v) => updatePreference("follows", v)}
                  accessibilityLabel={t("settings.notifications.follows", {
                    defaultValue: "New followers",
                  })}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.notifications.mentions", {
                defaultValue: "Mentions",
              })}
              description={t("settings.notifications.mentionsDesc", {
                defaultValue: "When someone mentions you in a post",
              })}
            >
              {
                <Switch
                  checked={prefs.mentions}
                  onCheckedChange={(v) => updatePreference("mentions", v)}
                  accessibilityLabel={t("settings.notifications.mentions", {
                    defaultValue: "Mentions",
                  })}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.notifications.replies", {
                defaultValue: "Replies",
              })}
              description={t("settings.notifications.repliesDesc", {
                defaultValue: "When someone replies to your post",
              })}
            >
              {
                <Switch
                  checked={prefs.replies}
                  onCheckedChange={(v) => updatePreference("replies", v)}
                  accessibilityLabel={t("settings.notifications.replies", {
                    defaultValue: "Replies",
                  })}
                />
              }
            </SettingsRow>
            <SettingsRow
              label={t("settings.notifications.quotes", {
                defaultValue: "Quote posts",
              })}
              description={t("settings.notifications.quotesDesc", {
                defaultValue: "When someone quotes your post",
              })}
            >
              {
                <Switch
                  checked={prefs.quotes}
                  onCheckedChange={(v) => updatePreference("quotes", v)}
                  accessibilityLabel={t("settings.notifications.quotes", {
                    defaultValue: "Quote posts",
                  })}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
