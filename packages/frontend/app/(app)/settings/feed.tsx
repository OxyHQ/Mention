import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, Pressable, ScrollView, Alert } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { Toggle } from '@/components/Toggle';
import { Slider } from '@/components/Slider';
import { useFeedSettings, FeedSettings } from '@/hooks/useFeedSettings';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { SettingsItem, SettingsGroup, SettingsDivider } from '@/components/settings/SettingsItem';

const IconComponent = Ionicons as React.ComponentType<React.ComponentProps<typeof Ionicons>>;

const DEFAULT_FEED_SETTINGS: FeedSettings = {
  diversity: {
    enabled: true,
    sameAuthorPenalty: 0.95,
    sameTopicPenalty: 0.92,
  },
  recency: {
    halfLifeHours: 24,
    maxAgeHours: 168,
  },
  quality: {
    boostHighQuality: true,
  },
};

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
  const { colors } = useTheme();
  const { settings, loading, updateSettings } = useFeedSettings();

  const [localSettings, setLocalSettings] = useState<FeedSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const saveRequestRef = useRef<{ id: number; cancelled: boolean } | null>(null);
  const requestIdRef = useRef(0);
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
    };
  }, []);

  const saveSettings = useCallback(async (newSettings: FeedSettings) => {
    if (saveRequestRef.current) {
      saveRequestRef.current.cancelled = true;
    }

    const requestId = ++requestIdRef.current;
    const request = { id: requestId, cancelled: false };
    saveRequestRef.current = request;

    setSaving(true);
    setJustSaved(false);

    try {
      await updateSettings(newSettings);

      if (!request.cancelled && request.id === requestIdRef.current) {
        setJustSaved(true);
        setSaving(false);

        if (justSavedTimeoutRef.current) {
          clearTimeout(justSavedTimeoutRef.current);
        }

        justSavedTimeoutRef.current = setTimeout(() => {
          setJustSaved(false);
        }, 1500);
      }
    } catch (error) {
      if (!request.cancelled && request.id === requestIdRef.current) {
        console.error('Error saving feed settings:', error);
        setSaving(false);
        setJustSaved(false);
      }
    }
  }, [updateSettings]);

  const updateLocalSettings = useCallback((updates: Partial<FeedSettings>) => {
    setLocalSettings(prev => {
      const newSettings = {
        ...prev,
        ...updates,
        diversity: { ...prev.diversity, ...updates.diversity },
        recency: { ...prev.recency, ...updates.recency },
        quality: { ...prev.quality, ...updates.quality },
      };

      saveSettings(newSettings);
      return newSettings;
    });
  }, [saveSettings]);

  const applyPreset = useCallback((presetKey: keyof typeof PRESETS) => {
    const preset = PRESETS[presetKey];
    const newSettings = {
      ...DEFAULT_FEED_SETTINGS,
      ...preset.settings,
      diversity: { ...DEFAULT_FEED_SETTINGS.diversity, ...preset.settings.diversity },
      recency: { ...DEFAULT_FEED_SETTINGS.recency, ...preset.settings.recency },
      quality: { ...DEFAULT_FEED_SETTINGS.quality, ...preset.settings.quality },
    };
    setLocalSettings(newSettings);
    saveSettings(newSettings);
  }, [saveSettings]);

  const resetToDefaults = useCallback(() => {
    Alert.alert(
      t('settings.feed.resetToDefaults'),
      t('settings.feed.resetToDefaultsMessage'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.reset'),
          style: 'destructive',
          onPress: () => {
            setLocalSettings(DEFAULT_FEED_SETTINGS);
            saveSettings(DEFAULT_FEED_SETTINGS);
          },
        },
      ]
    );
  }, [saveSettings, t]);

  if (loading) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('settings.feed.title'),
            leftComponents: [
              <IconButton variant="icon" key="back" onPress={() => router.back()}>
                <BackArrowIcon size={20} className="text-foreground" />
              </IconButton>,
            ],
          }}
          hideBottomBorder
          disableSticky
        />
        <View className="flex-1 justify-center items-center">
          <Loading size="large" />
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
            <IconButton variant="icon" key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: [
            saving ? (
              <View key="saving" className="pr-2">
                <Loading variant="inline" size="small" />
              </View>
            ) : justSaved ? (
              <View key="saved" className="pr-2">
                <IconComponent name="checkmark-circle" size={20} color={colors.primary} />
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
        <SettingsGroup title={t('settings.feed.presets.title')}>
          {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((key) => (
            <SettingsItem
              key={key}
              title={PRESETS[key].name}
              description={t(`settings.feed.presets.${key}Desc`)}
              onPress={() => applyPreset(key)}
            />
          ))}
        </SettingsGroup>

        {/* Diversity */}
        <SettingsGroup title={t('settings.feed.diversity.title')}>
          <SettingsItem
            title={t('settings.feed.diversity.enabled')}
            description={t('settings.feed.diversity.enabledDesc')}
            showChevron={false}
            rightElement={
              <Toggle
                value={localSettings.diversity.enabled}
                onValueChange={(value) => updateLocalSettings({
                  diversity: { ...localSettings.diversity, enabled: value },
                })}
              />
            }
          />
        </SettingsGroup>

        {localSettings.diversity.enabled && (
          <View className="px-5 py-3 gap-4">
            <View>
              <Slider
                value={localSettings.diversity.sameAuthorPenalty}
                onValueChange={(value) => updateLocalSettings({
                  diversity: { ...localSettings.diversity, sameAuthorPenalty: value },
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
                value={localSettings.diversity.sameTopicPenalty}
                onValueChange={(value) => updateLocalSettings({
                  diversity: { ...localSettings.diversity, sameTopicPenalty: value },
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
        <SettingsGroup title={t('settings.feed.recency.title')}>
          <View className="px-5 py-3 gap-4">
            <View>
              <Slider
                value={localSettings.recency.halfLifeHours}
                onValueChange={(value) => updateLocalSettings({
                  recency: { ...localSettings.recency, halfLifeHours: Math.round(value) },
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
                value={localSettings.recency.maxAgeHours}
                onValueChange={(value) => updateLocalSettings({
                  recency: { ...localSettings.recency, maxAgeHours: Math.round(value) },
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
        </SettingsGroup>

        {/* Quality */}
        <SettingsGroup title={t('settings.feed.quality.title')}>
          <SettingsItem
            title={t('settings.feed.quality.boostHighQuality')}
            description={t('settings.feed.quality.boostHighQualityDesc')}
            showChevron={false}
            rightElement={
              <Toggle
                value={localSettings.quality.boostHighQuality}
                onValueChange={(value) => updateLocalSettings({
                  quality: { ...localSettings.quality, boostHighQuality: value },
                })}
              />
            }
          />
        </SettingsGroup>

        <SettingsDivider />

        {/* Reset */}
        <SettingsItem
          icon="refresh"
          title={t('settings.feed.resetToDefaults')}
          onPress={resetToDefaults}
          destructive
        />
      </ScrollView>
    </ThemedView>
  );
}
