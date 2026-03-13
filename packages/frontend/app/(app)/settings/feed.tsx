import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert } from 'react-native';
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
import { cn } from '@/lib/utils';

const IconComponent = Ionicons as any;

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

  // Track the latest save request to cancel previous ones
  const saveRequestRef = useRef<{ id: number; cancelled: boolean } | null>(null);
  const requestIdRef = useRef(0);
  const justSavedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (justSavedTimeoutRef.current) {
        clearTimeout(justSavedTimeoutRef.current);
      }
    };
  }, []);

  const saveSettings = useCallback(async (newSettings: FeedSettings) => {
    // Cancel previous save request
    if (saveRequestRef.current) {
      saveRequestRef.current.cancelled = true;
    }

    // Create new request
    const requestId = ++requestIdRef.current;
    const request = { id: requestId, cancelled: false };
    saveRequestRef.current = request;

    setSaving(true);
    setJustSaved(false);

    try {
      await updateSettings(newSettings);

      // Only update state if this is still the latest request
      if (!request.cancelled && request.id === requestIdRef.current) {
        setJustSaved(true);
        setSaving(false);

        // Clear previous timeout
        if (justSavedTimeoutRef.current) {
          clearTimeout(justSavedTimeoutRef.current);
        }

        // Hide checkmark after 1.5 seconds
        justSavedTimeoutRef.current = setTimeout(() => {
          setJustSaved(false);
        }, 1500);
      }
    } catch (error) {
      // Only update state if this is still the latest request
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

      // Save immediately, previous saves will be cancelled
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

  const showHelp = useCallback((helpKey: string) => {
    Alert.alert(
      t(`settings.feed.help.${helpKey}.title`),
      t(`settings.feed.help.${helpKey}.message`),
      [{ text: t('common.ok') }]
    );
  }, [t]);

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
          hideBottomBorder={true}
          disableSticky={true}
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
              <View key="saving" className="w-8 h-8 items-center justify-center">
                <Loading variant="inline" size="small" style={{ flex: undefined }} />
              </View>
            ) : justSaved ? (
              <View key="saved" className="w-8 h-8 items-center justify-center">
                <IconComponent name="checkmark-circle" size={20} color={colors.primary} />
              </View>
            ) : null,
          ].filter(Boolean),
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-5 pb-6"
        showsVerticalScrollIndicator={false}
      >
        {/* Presets Section */}
        <View className="mb-8">
          <Text className="text-[13px] font-semibold uppercase tracking-wide mb-3 px-1 text-foreground">
            {t('settings.feed.presets.title')}
          </Text>
          <View className="rounded-2xl border border-border bg-card overflow-hidden">
            {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((key, index) => (
              <React.Fragment key={key}>
                {index > 0 && <View className="h-px mx-4 bg-border" />}
                <TouchableOpacity
                  className={cn(
                    "px-4 py-4 flex-row items-center justify-between",
                    index === 0 && "pt-[18px]",
                    index === Object.keys(PRESETS).length - 1 && "pb-[18px]"
                  )}
                  onPress={() => applyPreset(key)}
                >
                  <View className="flex-1 mr-4">
                    <Text className="text-base font-medium mb-0.5 text-foreground">
                      {PRESETS[key].name}
                    </Text>
                    <Text className="text-sm text-muted-foreground">
                      {t(`settings.feed.presets.${key}Desc`)}
                    </Text>
                  </View>
                  <IconComponent name="chevron-forward" size={16} color={colors.textTertiary} />
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </View>
        </View>

        {/* Diversity Section */}
        <View className="mb-8">
          <View className="flex-row items-center justify-between mb-3 px-1">
            <Text className="text-[13px] font-semibold uppercase tracking-wide text-foreground">
              {t('settings.feed.diversity.title')}
            </Text>
            <TouchableOpacity onPress={() => showHelp('diversity')}>
              <IconComponent name="help-circle-outline" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <View className="rounded-2xl border border-border bg-card overflow-hidden">
            <View className="px-4 py-4 pt-[18px] flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-base font-medium mb-0.5 text-foreground">
                  {t('settings.feed.diversity.enabled')}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {t('settings.feed.diversity.enabledDesc')}
                </Text>
              </View>
              <Toggle
                value={localSettings.diversity.enabled}
                onValueChange={(value) => updateLocalSettings({
                  diversity: {
                    ...localSettings.diversity,
                    enabled: value
                  }
                })}
              />
            </View>

            {localSettings.diversity.enabled && (
              <>
                <View className="h-px mx-4 bg-border" />
                <View className="px-4 py-4">
                  <Slider
                    value={localSettings.diversity.sameAuthorPenalty}
                    onValueChange={(value) => updateLocalSettings({
                      diversity: {
                        ...localSettings.diversity,
                        sameAuthorPenalty: value
                      }
                    })}
                    minimumValue={0.5}
                    maximumValue={1.0}
                    step={0.01}
                    label={t('settings.feed.diversity.sameAuthorPenalty')}
                    formatValue={(v) => v.toFixed(2)}
                  />
                  <Text className="text-xs mt-2 leading-4 text-muted-foreground">
                    {t('settings.feed.diversity.sameAuthorPenaltyDesc')}
                  </Text>
                </View>

                <View className="h-px mx-4 bg-border" />
                <View className="px-4 py-4 pb-[18px]">
                  <Slider
                    value={localSettings.diversity.sameTopicPenalty}
                    onValueChange={(value) => updateLocalSettings({
                      diversity: {
                        ...localSettings.diversity,
                        sameTopicPenalty: value
                      }
                    })}
                    minimumValue={0.5}
                    maximumValue={1.0}
                    step={0.01}
                    label={t('settings.feed.diversity.sameTopicPenalty')}
                    formatValue={(v) => v.toFixed(2)}
                  />
                  <Text className="text-xs mt-2 leading-4 text-muted-foreground">
                    {t('settings.feed.diversity.sameTopicPenaltyDesc')}
                  </Text>
                </View>
              </>
            )}
          </View>
        </View>

        {/* Recency Section */}
        <View className="mb-8">
          <View className="flex-row items-center justify-between mb-3 px-1">
            <Text className="text-[13px] font-semibold uppercase tracking-wide text-foreground">
              {t('settings.feed.recency.title')}
            </Text>
            <TouchableOpacity onPress={() => showHelp('recency')}>
              <IconComponent name="help-circle-outline" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <View className="rounded-2xl border border-border bg-card overflow-hidden">
            <View className="px-4 py-4 pt-[18px]">
              <Slider
                value={localSettings.recency.halfLifeHours}
                onValueChange={(value) => updateLocalSettings({
                  recency: {
                    ...localSettings.recency,
                    halfLifeHours: Math.round(value)
                  }
                })}
                minimumValue={6}
                maximumValue={72}
                step={1}
                label={t('settings.feed.recency.halfLifeHours')}
                formatValue={(v) => `${Math.round(v)} ${t('settings.feed.recency.hours')}`}
              />
              <Text className="text-xs mt-2 leading-4 text-muted-foreground">
                {t('settings.feed.recency.halfLifeHoursDesc')}
              </Text>
            </View>

            <View className="h-px mx-4 bg-border" />
            <View className="px-4 py-4 pb-[18px]">
              <Slider
                value={localSettings.recency.maxAgeHours}
                onValueChange={(value) => updateLocalSettings({
                  recency: {
                    ...localSettings.recency,
                    maxAgeHours: Math.round(value)
                  }
                })}
                minimumValue={24}
                maximumValue={336}
                step={24}
                label={t('settings.feed.recency.maxAgeHours')}
                formatValue={(v) => `${Math.round(v / 24)} ${t('settings.feed.recency.days')}`}
              />
              <Text className="text-xs mt-2 leading-4 text-muted-foreground">
                {t('settings.feed.recency.maxAgeHoursDesc')}
              </Text>
            </View>
          </View>
        </View>

        {/* Quality Section */}
        <View className="mb-8">
          <View className="flex-row items-center justify-between mb-3 px-1">
            <Text className="text-[13px] font-semibold uppercase tracking-wide text-foreground">
              {t('settings.feed.quality.title')}
            </Text>
            <TouchableOpacity onPress={() => showHelp('quality')}>
              <IconComponent name="help-circle-outline" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <View className="rounded-2xl border border-border bg-card overflow-hidden">
            <View className="px-4 pt-[18px] pb-[18px] flex-row items-center justify-between">
              <View className="flex-1 mr-4">
                <Text className="text-base font-medium mb-0.5 text-foreground">
                  {t('settings.feed.quality.boostHighQuality')}
                </Text>
                <Text className="text-sm text-muted-foreground">
                  {t('settings.feed.quality.boostHighQualityDesc')}
                </Text>
              </View>
              <Toggle
                value={localSettings.quality.boostHighQuality}
                onValueChange={(value) => updateLocalSettings({
                  quality: {
                    ...localSettings.quality,
                    boostHighQuality: value
                  }
                })}
              />
            </View>
          </View>
        </View>

        {/* Reset Button */}
        <View className="mb-8">
          <TouchableOpacity
            className="flex-row items-center justify-center gap-2 py-3.5 rounded-2xl border border-border"
            onPress={resetToDefaults}
          >
            <IconComponent name="refresh-outline" size={18} color={colors.textSecondary} />
            <Text className="text-base font-medium text-muted-foreground">
              {t('settings.feed.resetToDefaults')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </ThemedView>
  );
}
