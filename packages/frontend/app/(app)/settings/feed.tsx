import React, { useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { confirmDialog } from '@/utils/alerts';
import { Loading } from '@oxyhq/bloom/loading';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { Toggle } from '@/components/Toggle';
import { Slider } from '@/components/Slider';
import { useFeedSettings, DEFAULT_FEED_SETTINGS, type FeedSettings } from '@/hooks/useFeedSettings';
import { useTranslation } from 'react-i18next';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services/ui/client';

const PRESETS = {
  mostRecent: {
    name: 'Most Recent',
    settings: {
      diversity: { enabled: false, sameAuthorPenalty: 1.0, sameTopicPenalty: 1.0 },
      recency: { halfLifeHours: 72, maxAgeHours: 336 },
      quality: { boostHighQuality: false },
    },
  },
  mostEngaged: {
    name: 'Most Engaged',
    settings: {
      diversity: { enabled: true, sameAuthorPenalty: 0.98, sameTopicPenalty: 0.98 },
      recency: { halfLifeHours: 12, maxAgeHours: 168 },
      quality: { boostHighQuality: true },
    },
  },
  balanced: {
    name: 'Balanced',
    settings: DEFAULT_FEED_SETTINGS,
  },
  diverse: {
    name: 'Diverse',
    settings: {
      diversity: { enabled: true, sameAuthorPenalty: 0.85, sameTopicPenalty: 0.80 },
      recency: { halfLifeHours: 24, maxAgeHours: 168 },
      quality: { boostHighQuality: true },
    },
  },
};

export default function FeedSettingsScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { isAuthenticated } = useAuth();
  // Server state is the only state — every control below writes straight
  // through, so there is no draft to reconcile and no save button.
  const { settings, isLoading, isSaving, preview, save } = useFeedSettings();

  /** Merge a partial change onto the current settings. */
  const merged = useCallback((updates: Partial<FeedSettings>): FeedSettings => ({
    ...settings,
    ...updates,
    diversity: { ...settings.diversity, ...updates.diversity },
    recency: { ...settings.recency, ...updates.recency },
    quality: { ...settings.quality, ...updates.quality },
  }), [settings]);

  /** A discrete control (toggle, preset) — persist immediately. */
  const commit = useCallback((updates: Partial<FeedSettings>) => {
    save(merged(updates));
  }, [merged, save]);

  /**
   * A slider mid-drag. `onValueChange` fires every frame, so showing the value
   * and persisting it are separate: this only moves the displayed value, and the
   * matching `onSlidingComplete` persists once on release.
   */
  const previewChange = useCallback((updates: Partial<FeedSettings>) => {
    preview(merged(updates));
  }, [merged, preview]);

  const applyPreset = useCallback((presetKey: keyof typeof PRESETS) => {
    const preset = PRESETS[presetKey];
    save({
      ...DEFAULT_FEED_SETTINGS,
      ...preset.settings,
      diversity: { ...DEFAULT_FEED_SETTINGS.diversity, ...preset.settings.diversity },
      recency: { ...DEFAULT_FEED_SETTINGS.recency, ...preset.settings.recency },
      quality: { ...DEFAULT_FEED_SETTINGS.quality, ...preset.settings.quality },
    });
  }, [save]);

  const resetToDefaults = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t('settings.feed.resetToDefaults'),
      message: t('settings.feed.resetToDefaultsMessage'),
      okText: t('common.reset'),
      cancelText: t('common.cancel'),
      destructive: true,
    });
    if (confirmed) {
      save(DEFAULT_FEED_SETTINGS);
    }
  }, [save, t]);

  if (!isAuthenticated) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('settings.feed.title'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <OxyAuthPrompt
          label={t('settings.feed.signInRequired', { defaultValue: 'Sign in to customize your feed' })}
          description={t('settings.feed.signInRequiredDesc', { defaultValue: 'Tune the algorithm, diversity, and recency to your taste.' })}
        />
      </ThemedView>
    );
  }

  if (isLoading) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('settings.feed.title'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View className="flex-1 justify-center items-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.feed.title'),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: [
            isSaving ? (
              <View key="saving" className="pr-2">
                <Loading className="text-primary" variant="inline" size="small" />
              </View>
            ) : null,
          ].filter(Boolean),
        }}
        hideBottomBorder
        disableSticky
      />

      <ScrollView
        className="flex-1"
        contentContainerClassName="py-2"
        showsVerticalScrollIndicator={false}
      >
        {/* Presets */}
        <SettingsListGroup title={t('settings.feed.presets.title')}>
          {(Object.keys(PRESETS) as (keyof typeof PRESETS)[]).map((key) => (
            <SettingsListItem
              key={key}
              title={PRESETS[key].name}
              description={t(`settings.feed.presets.${key}Desc`)}
              onPress={() => applyPreset(key)}
            />
          ))}
        </SettingsListGroup>

        {/* Diversity */}
        <SettingsListGroup title={t('settings.feed.diversity.title')}>
          <SettingsListItem
            title={t('settings.feed.diversity.enabled')}
            description={t('settings.feed.diversity.enabledDesc')}
            showChevron={false}
            rightElement={
              <Toggle
                value={settings.diversity.enabled}
                onValueChange={(value) => commit({
                  diversity: { ...settings.diversity, enabled: value },
                })}
              />
            }
          />
        </SettingsListGroup>

        {settings.diversity.enabled && (
          <View className="px-5 py-3 gap-4">
            <View>
              <Slider
                value={settings.diversity.sameAuthorPenalty}
                onValueChange={(value) => previewChange({
                  diversity: { ...settings.diversity, sameAuthorPenalty: value },
                })}
                onSlidingComplete={(value) => commit({
                  diversity: { ...settings.diversity, sameAuthorPenalty: value },
                })}
                minimumValue={0.5}
                maximumValue={1.0}
                step={0.01}
                label={t('settings.feed.diversity.sameAuthorPenalty')}
                formatValue={(v) => v.toFixed(2)}
              />
              <Text className="text-xs mt-1 text-muted-foreground">
                {t('settings.feed.diversity.sameAuthorPenaltyDesc')}
              </Text>
            </View>
            <View>
              <Slider
                value={settings.diversity.sameTopicPenalty}
                onValueChange={(value) => previewChange({
                  diversity: { ...settings.diversity, sameTopicPenalty: value },
                })}
                onSlidingComplete={(value) => commit({
                  diversity: { ...settings.diversity, sameTopicPenalty: value },
                })}
                minimumValue={0.5}
                maximumValue={1.0}
                step={0.01}
                label={t('settings.feed.diversity.sameTopicPenalty')}
                formatValue={(v) => v.toFixed(2)}
              />
              <Text className="text-xs mt-1 text-muted-foreground">
                {t('settings.feed.diversity.sameTopicPenaltyDesc')}
              </Text>
            </View>
          </View>
        )}

        {/* Recency */}
        <SettingsListGroup title={t('settings.feed.recency.title')}>
          <View className="px-5 py-3 gap-4">
            <View>
              <Slider
                value={settings.recency.halfLifeHours}
                onValueChange={(value) => previewChange({
                  recency: { ...settings.recency, halfLifeHours: Math.round(value) },
                })}
                onSlidingComplete={(value) => commit({
                  recency: { ...settings.recency, halfLifeHours: Math.round(value) },
                })}
                minimumValue={6}
                maximumValue={72}
                step={1}
                label={t('settings.feed.recency.halfLifeHours')}
                formatValue={(v) => `${Math.round(v)} ${t('settings.feed.recency.hours')}`}
              />
              <Text className="text-xs mt-1 text-muted-foreground">
                {t('settings.feed.recency.halfLifeHoursDesc')}
              </Text>
            </View>
            <View>
              <Slider
                value={settings.recency.maxAgeHours}
                onValueChange={(value) => previewChange({
                  recency: { ...settings.recency, maxAgeHours: Math.round(value) },
                })}
                onSlidingComplete={(value) => commit({
                  recency: { ...settings.recency, maxAgeHours: Math.round(value) },
                })}
                minimumValue={24}
                maximumValue={336}
                step={24}
                label={t('settings.feed.recency.maxAgeHours')}
                formatValue={(v) => `${Math.round(v / 24)} ${t('settings.feed.recency.days')}`}
              />
              <Text className="text-xs mt-1 text-muted-foreground">
                {t('settings.feed.recency.maxAgeHoursDesc')}
              </Text>
            </View>
          </View>
        </SettingsListGroup>

        {/* Quality */}
        <SettingsListGroup title={t('settings.feed.quality.title')}>
          <SettingsListItem
            title={t('settings.feed.quality.boostHighQuality')}
            description={t('settings.feed.quality.boostHighQualityDesc')}
            showChevron={false}
            rightElement={
              <Toggle
                value={settings.quality.boostHighQuality}
                onValueChange={(value) => commit({
                  quality: { ...settings.quality, boostHighQuality: value },
                })}
              />
            }
          />
        </SettingsListGroup>

        {/* Reset */}
        <SettingsListGroup>
          <SettingsListItem
            icon={<RowIcon name="refresh" destructive />}
            title={t('settings.feed.resetToDefaults')}
            onPress={resetToDefaults}
            destructive
          />
        </SettingsListGroup>
      </ScrollView>
    </ThemedView>
  );
}
