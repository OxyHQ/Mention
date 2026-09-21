import { type BloomIcon } from "@/components/settings/RowIcon";
import { useSettingsRouter } from "@/context/MentionSettingsContext";
import {
  createPrivacySettingsCacheLease,
  updatePrivacySettingsCache,
  type PrivacySettings,
  type UserSettingsResponse,
} from "@/hooks/usePrivacySettings";
import { queryClient } from "@/lib/queryClient";
import {
  DEFAULT_RECOMMENDATION_FILTERS,
  getRecommendationFilters,
  saveRecommendationFilters,
  type RecommendationFilters,
} from "@/lib/recommendationFilters";
import { viewerQueryKeys } from "@/lib/viewerQueryKeys";
import { invalidateSafetyFilters } from "@/stores/safetyInvalidation";
import { authenticatedClient } from "@/utils/api";
import { Button } from "@oxy.so/bloom/button";
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
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

const FILTER_TOGGLES: {
  icon: BloomIcon;
  titleKey: string;
  descKey: string;
  titleDefault: string;
  descDefault: string;
  filterKey: keyof RecommendationFilters;
}[] = [
  {
    icon: RiEarthLine,
    titleKey: "settings.privacy.showFediverse",
    descKey: "settings.privacy.showFediverseDesc",
    titleDefault: "Fediverse accounts in suggestions",
    descDefault: "Show accounts from Mastodon and other fediverse instances",
    filterKey: "showFederated",
  },
  {
    icon: RiSparklingLine,
    titleKey: "settings.privacy.showAgents",
    descKey: "settings.privacy.showAgentsDesc",
    titleDefault: "AI agents in suggestions",
    descDefault: "Show AI-powered bot accounts",
    filterKey: "showAgents",
  },
  {
    icon: RiRefreshLine,
    titleKey: "settings.privacy.showAutomated",
    descKey: "settings.privacy.showAutomatedDesc",
    titleDefault: "Automated accounts in suggestions",
    descDefault: "Show scheduled and feed-based accounts",
    filterKey: "showAutomated",
  },
];

export default function PrivacySettingsScreen() {
  const router = useSettingsRouter();
  const { t } = useTranslation();

  const {
    isAuthenticated,
    isAuthResolved,
    canUsePrivateApi,
    isPrivateApiPending,
    user,
  } = useAuth();
  const viewerId = user?.id;

  const [privacySettings, setPrivacySettings] = useState<PrivacySettings>({});
  const [recFilters, setRecFilters] = useState<RecommendationFilters>(
    DEFAULT_RECOMMENDATION_FILTERS,
  );
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isAuthResolved || isPrivateApiPending) {
      return;
    }
    if (!isAuthenticated || !viewerId) {
      setLoading(false);
      return;
    }
    loadPrivacySettings();
    getRecommendationFilters(viewerId).then(setRecFilters);
  }, [isAuthResolved, isPrivateApiPending, isAuthenticated, viewerId]);

  const loadPrivacySettings = async () => {
    try {
      const response = await authenticatedClient.get<UserSettingsResponse>(
        "/profile/settings/me",
      );
      const settings = response.data;
      setPrivacySettings(settings.privacy || { profileVisibility: "public" });
      setLoading(false);
    } catch (error) {
      logger.error("Error loading privacy settings", error);
      setPrivacySettings({ profileVisibility: "public" });
      setLoading(false);
    }
  };

  const updateRecFilter = (
    key: keyof RecommendationFilters,
    value: boolean,
  ) => {
    const updated = { ...recFilters, [key]: value };
    setRecFilters(updated);
    void saveRecommendationFilters(updated, viewerId);
    // Prime the shared filters query so `useRecommendations` re-derives its
    // `excludeTypes` cache key and refetches every recommendation surface
    // (explore tab, widget, suggestions) reactively — no manual invalidation.
    if (viewerId) {
      queryClient.setQueryData(
        viewerQueryKeys.recommendationFilters(viewerId),
        updated,
      );
    }
  };

  const updatePrivacyToggle = async (
    field: "showSensitiveContent",
    value: boolean,
  ) => {
    const cacheLease = createPrivacySettingsCacheLease(viewerId);
    const previous = privacySettings;
    const updated = { ...privacySettings, [field]: value };
    setPrivacySettings(updated);
    try {
      await authenticatedClient.put("/profile/settings", { privacy: updated });
      await updatePrivacySettingsCache(updated, cacheLease);
      // Sensitive content is excluded by the SERVER's feed/search queries,
      // so a cache filled under the previous answer is now showing (or
      // withholding) exactly what the viewer just decided about. One
      // authority tells both read caches: `stores/safetyInvalidation`.
      invalidateSafetyFilters();
    } catch (error) {
      logger.error("Error updating privacy setting", error, { field });
      setPrivacySettings(previous);
    }
  };

  const getProfileVisibilityText = () => {
    const visibility = privacySettings.profileVisibility || "public";
    if (visibility === "private") return t("settings.privacy.private");
    if (visibility === "followers_only")
      return t("settings.privacy.followersOnly");
    return t("settings.privacy.public");
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
          label={t("settings.privacy.signInRequired", {
            defaultValue: "Sign in to manage your privacy settings",
          })}
          description={t("settings.privacy.signInRequiredDesc", {
            defaultValue:
              "Control who can see your profile, mention you, and more.",
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
              label={t("settings.privacy.privateProfile")}
              description={t("settings.privacy.privateProfileDesc", {
                defaultValue: "Control who can see your profile",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() =>
                  router.push("/settings/privacy/profile-visibility")
                }
                accessibilityLabel={t("settings.privacy.privateProfile")}
              >
                {getProfileVisibilityText()}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t("settings.privacy.tagsAndMentions")}
              description={t("settings.privacy.tagsAndMentionsDesc", {
                defaultValue: "Choose who can tag or mention you",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() => router.push("/settings/privacy/tags-mentions")}
                accessibilityLabel={t("settings.privacy.tagsAndMentions")}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t("settings.privacy.onlineStatus")}
              description={t("settings.privacy.onlineStatusDesc", {
                defaultValue: "Show when you are active",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() => router.push("/settings/privacy/online-status")}
                accessibilityLabel={t("settings.privacy.onlineStatus")}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              label={t("settings.privacy.restrictedProfiles")}
              description={t("settings.privacy.restrictedProfilesDesc", {
                defaultValue: "Limit interactions from specific people",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() => router.push("/settings/privacy/restricted")}
                accessibilityLabel={t("settings.privacy.restrictedProfiles")}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t("settings.privacy.blockedProfiles")}
              description={t("settings.privacy.blockedProfilesDesc", {
                defaultValue: "People you have blocked",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() => router.push("/settings/privacy/blocked")}
                accessibilityLabel={t("settings.privacy.blockedProfiles")}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection>
          <SettingsCard>
            <SettingsRow
              label={t("settings.privacy.hiddenWords")}
              description={t("settings.privacy.hiddenWordsDesc", {
                defaultValue: "Filter posts containing specific words",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() => router.push("/settings/privacy/hidden-words")}
                accessibilityLabel={t("settings.privacy.hiddenWords")}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
            {/* Beside muted words because a reader looking for "stop
                        showing me this" looks in one place — but a separate
                        screen, because the two are different rules: a muted word
                        is a safety filter that reaches search and notifications,
                        a muted lane is a timeline preference that reaches feeds
                        only. */}
            <SettingsRow
              label={t("lanes.muted.title", { defaultValue: "Muted lanes" })}
              description={t("lanes.muted.settingsDesc", {
                defaultValue: "Hide one track of an account you follow",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() => router.push("/settings/privacy/muted-lanes")}
                accessibilityLabel={t("lanes.muted.title", {
                  defaultValue: "Muted lanes",
                })}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
            <SettingsRow
              label={t("settings.privacy.hideLikeShareCounts")}
              description={t("settings.privacy.hideLikeShareCountsDesc", {
                defaultValue: "Hide engagement counts on posts",
              })}
            >
              <Button
                size="small"
                appearance="subtle"
                tone="neutral"
                onPress={() => router.push("/settings/privacy/hide-counts")}
                accessibilityLabel={t("settings.privacy.hideLikeShareCounts")}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection label={t("settings.privacy.content")}>
          <SettingsCard>
            <SettingsRow
              label={t("settings.privacy.showSensitiveContent")}
              description={t("settings.privacy.showSensitiveContentDesc", {
                defaultValue:
                  "Sensitive and NSFW posts never appear in your feeds. They remain visible on the author's profile.",
              })}
            >
              {
                <Switch
                  value={privacySettings.showSensitiveContent ?? false}
                  onValueChange={(value) =>
                    updatePrivacyToggle("showSensitiveContent", value)
                  }
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection>
          <SettingsCard>
            {FILTER_TOGGLES.map(
              ({
                icon,
                titleKey,
                descKey,
                titleDefault,
                descDefault,
                filterKey,
              }) => (
                <SettingsRow
                  label={t(titleKey, { defaultValue: titleDefault })}
                  description={t(descKey, { defaultValue: descDefault })}
                  key={filterKey}
                >
                  {
                    <Switch
                      value={recFilters[filterKey]}
                      onValueChange={(v) => updateRecFilter(filterKey, v)}
                    />
                  }
                </SettingsRow>
              ),
            )}
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
