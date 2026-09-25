import { Slider } from "@oxy.so/bloom/slider";
import {
  DEFAULT_FEED_SETTINGS,
  useFeedSettings,
  type FeedSettings,
} from "@/hooks/useFeedSettings";
import { confirmDialog } from "@/utils/alerts";
import { Button } from "@oxy.so/bloom/button";
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

const PRESETS = {
  mostRecent: {
    name: "Most Recent",
    settings: {
      diversity: {
        enabled: false,
        sameAuthorPenalty: 1.0,
        sameTopicPenalty: 1.0,
      },
      recency: { halfLifeHours: 72, maxAgeHours: 336 },
      quality: { boostHighQuality: false },
    },
  },
  mostEngaged: {
    name: "Most Engaged",
    settings: {
      diversity: {
        enabled: true,
        sameAuthorPenalty: 0.98,
        sameTopicPenalty: 0.98,
      },
      recency: { halfLifeHours: 12, maxAgeHours: 168 },
      quality: { boostHighQuality: true },
    },
  },
  balanced: {
    name: "Balanced",
    settings: DEFAULT_FEED_SETTINGS,
  },
  diverse: {
    name: "Diverse",
    settings: {
      diversity: {
        enabled: true,
        sameAuthorPenalty: 0.85,
        sameTopicPenalty: 0.8,
      },
      recency: { halfLifeHours: 24, maxAgeHours: 168 },
      quality: { boostHighQuality: true },
    },
  },
};

export default function FeedSettingsScreen() {
  const { t } = useTranslation();

  const { isAuthenticated } = useAuth();
  // Server state is the only state — every control below writes straight
  // through, so there is no draft to reconcile and no save button.
  const { settings, isLoading, isSaving, preview, save } = useFeedSettings();

  /** Merge a partial change onto the current settings. */
  const merged = useCallback(
    (updates: Partial<FeedSettings>): FeedSettings => ({
      ...settings,
      ...updates,
      diversity: { ...settings.diversity, ...updates.diversity },
      recency: { ...settings.recency, ...updates.recency },
      quality: { ...settings.quality, ...updates.quality },
    }),
    [settings],
  );

  /** A discrete control (toggle, preset) — persist immediately. */
  const commit = useCallback(
    (updates: Partial<FeedSettings>) => {
      save(merged(updates));
    },
    [merged, save],
  );

  /**
   * A slider mid-drag. `onValueChange` fires every frame, so showing the value
   * and persisting it are separate: this only moves the displayed value, and the
   * matching `onSlidingComplete` persists once on release.
   */
  const previewChange = useCallback(
    (updates: Partial<FeedSettings>) => {
      preview(merged(updates));
    },
    [merged, preview],
  );

  const applyPreset = useCallback(
    (presetKey: keyof typeof PRESETS) => {
      const preset = PRESETS[presetKey];
      save({
        ...DEFAULT_FEED_SETTINGS,
        ...preset.settings,
        diversity: {
          ...DEFAULT_FEED_SETTINGS.diversity,
          ...preset.settings.diversity,
        },
        recency: {
          ...DEFAULT_FEED_SETTINGS.recency,
          ...preset.settings.recency,
        },
        quality: {
          ...DEFAULT_FEED_SETTINGS.quality,
          ...preset.settings.quality,
        },
      });
    },
    [save],
  );

  const resetToDefaults = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("settings.feed.resetToDefaults"),
      message: t("settings.feed.resetToDefaultsMessage"),
      okText: t("common.reset"),
      cancelText: t("common.cancel"),
      destructive: true,
    });
    if (confirmed) {
      save(DEFAULT_FEED_SETTINGS);
    }
  }, [save, t]);

  if (!isAuthenticated) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t("settings.feed.signInRequired", {
            defaultValue: "Sign in to customize your feed",
          })}
          description={t("settings.feed.signInRequiredDesc", {
            defaultValue:
              "Tune the algorithm, diversity, and recency to your taste.",
          })}
        />
      </View>
    );
  }

  if (isLoading) {
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
      {isSaving ? <Loading variant="inline" size="small" /> : null}
      <View className="gap-4">
        {/* Presets */}
        <SettingsSection label={t("settings.feed.presets.title")}>
          <SettingsCard>
            {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((key) => (
              <SettingsRow
                label={PRESETS[key].name}
                description={t(`settings.feed.presets.${key}Desc`)}
                key={key}
              >
                <Button
                  size="small"
                  appearance="subtle"
                  tone="neutral"
                  onPress={() => applyPreset(key)}
                  accessibilityLabel={PRESETS[key].name}
                >
                  {t("common.open", { defaultValue: "Open" })}
                </Button>
              </SettingsRow>
            ))}
          </SettingsCard>
        </SettingsSection>

        {/* Diversity */}
        <SettingsSection label={t("settings.feed.diversity.title")}>
          <SettingsCard>
            <SettingsRow
              label={t("settings.feed.diversity.enabled")}
              description={t("settings.feed.diversity.enabledDesc")}
            >
              {
                <Switch
                  checked={settings.diversity.enabled}
                  onCheckedChange={(value) =>
                    commit({
                      diversity: { ...settings.diversity, enabled: value },
                    })
                  }
                  accessibilityLabel={t("settings.feed.diversity.enabled")}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        {settings.diversity.enabled && (
          <View className="py-3 gap-4">
            <View>
              <Slider
                value={settings.diversity.sameAuthorPenalty}
                onValueChange={(value) =>
                  previewChange({
                    diversity: {
                      ...settings.diversity,
                      sameAuthorPenalty: value,
                    },
                  })
                }
                onSlidingComplete={(value) =>
                  commit({
                    diversity: {
                      ...settings.diversity,
                      sameAuthorPenalty: value,
                    },
                  })
                }
                min={0.5}
                max={1.0}
                step={0.01}
                label={t("settings.feed.diversity.sameAuthorPenalty")}
                formatValue={(v) => v.toFixed(2)}
              />
              <Text className="text-xs mt-1 text-muted-foreground">
                {t("settings.feed.diversity.sameAuthorPenaltyDesc")}
              </Text>
            </View>
            <View>
              <Slider
                value={settings.diversity.sameTopicPenalty}
                onValueChange={(value) =>
                  previewChange({
                    diversity: {
                      ...settings.diversity,
                      sameTopicPenalty: value,
                    },
                  })
                }
                onSlidingComplete={(value) =>
                  commit({
                    diversity: {
                      ...settings.diversity,
                      sameTopicPenalty: value,
                    },
                  })
                }
                min={0.5}
                max={1.0}
                step={0.01}
                label={t("settings.feed.diversity.sameTopicPenalty")}
                formatValue={(v) => v.toFixed(2)}
              />
              <Text className="text-xs mt-1 text-muted-foreground">
                {t("settings.feed.diversity.sameTopicPenaltyDesc")}
              </Text>
            </View>
          </View>
        )}

        {/* Recency */}
        <SettingsSection label={t("settings.feed.recency.title")}>
          <SettingsCard>
            <View className="py-3 gap-4">
              <View>
                <Slider
                  value={settings.recency.halfLifeHours}
                  onValueChange={(value) =>
                    previewChange({
                      recency: {
                        ...settings.recency,
                        halfLifeHours: Math.round(value),
                      },
                    })
                  }
                  onSlidingComplete={(value) =>
                    commit({
                      recency: {
                        ...settings.recency,
                        halfLifeHours: Math.round(value),
                      },
                    })
                  }
                  min={6}
                  max={72}
                  step={1}
                  label={t("settings.feed.recency.halfLifeHours")}
                  formatValue={(v) =>
                    `${Math.round(v)} ${t("settings.feed.recency.hours")}`
                  }
                />
                <Text className="text-xs mt-1 text-muted-foreground">
                  {t("settings.feed.recency.halfLifeHoursDesc")}
                </Text>
              </View>
              <View>
                <Slider
                  value={settings.recency.maxAgeHours}
                  onValueChange={(value) =>
                    previewChange({
                      recency: {
                        ...settings.recency,
                        maxAgeHours: Math.round(value),
                      },
                    })
                  }
                  onSlidingComplete={(value) =>
                    commit({
                      recency: {
                        ...settings.recency,
                        maxAgeHours: Math.round(value),
                      },
                    })
                  }
                  min={24}
                  max={336}
                  step={24}
                  label={t("settings.feed.recency.maxAgeHours")}
                  formatValue={(v) =>
                    `${Math.round(v / 24)} ${t("settings.feed.recency.days")}`
                  }
                />
                <Text className="text-xs mt-1 text-muted-foreground">
                  {t("settings.feed.recency.maxAgeHoursDesc")}
                </Text>
              </View>
            </View>
          </SettingsCard>
        </SettingsSection>

        {/* Quality */}
        <SettingsSection label={t("settings.feed.quality.title")}>
          <SettingsCard>
            <SettingsRow
              label={t("settings.feed.quality.boostHighQuality")}
              description={t("settings.feed.quality.boostHighQualityDesc")}
            >
              {
                <Switch
                  checked={settings.quality.boostHighQuality}
                  onCheckedChange={(value) =>
                    commit({
                      quality: { ...settings.quality, boostHighQuality: value },
                    })
                  }
                  accessibilityLabel={t(
                    "settings.feed.quality.boostHighQuality",
                  )}
                />
              }
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>

        {/* Reset */}
        <SettingsSection>
          <SettingsCard>
            <SettingsRow label={t("settings.feed.resetToDefaults")}>
              <Button
                size="small"
                appearance="subtle"
                tone="danger"
                onPress={resetToDefaults}
                accessibilityLabel={t("settings.feed.resetToDefaults")}
              >
                {t("common.open", { defaultValue: "Open" })}
              </Button>
            </SettingsRow>
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
