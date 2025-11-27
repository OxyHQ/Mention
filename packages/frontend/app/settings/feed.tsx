import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { Toggle } from '@/components/Toggle';
import { Slider } from '@/components/Slider';
import { useFeedSettings, FeedSettings } from '@/hooks/useFeedSettings';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

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
  const theme = useTheme();
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
      <ThemedView style={styles.container}>
        <Header
          options={{
            title: t('settings.feed.title'),
            leftComponents: [
              <HeaderIconButton key="back" onPress={() => router.back()}>
                <BackArrowIcon size={20} color={theme.colors.text} />
              </HeaderIconButton>,
            ],
          }}
          hideBottomBorder={true}
          disableSticky={true}
        />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary} />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <Header
        options={{
          title: t('settings.feed.title'),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
          rightComponents: [
            saving ? (
              <View key="saving" style={styles.headerIconContainer}>
                <ActivityIndicator size="small" color={theme.colors.primary} />
              </View>
            ) : justSaved ? (
              <View key="saved" style={styles.headerIconContainer}>
                <IconComponent name="checkmark-circle" size={20} color={theme.colors.primary} />
              </View>
            ) : null,
          ].filter(Boolean),
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Presets Section */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            {t('settings.feed.presets.title')}
          </Text>
          <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            {(Object.keys(PRESETS) as Array<keyof typeof PRESETS>).map((key, index) => (
              <React.Fragment key={key}>
                {index > 0 && <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />}
                <TouchableOpacity
                  style={[styles.settingItem, index === 0 && styles.firstSettingItem, index === Object.keys(PRESETS).length - 1 && styles.lastSettingItem]}
                  onPress={() => applyPreset(key)}
                >
                  <View style={styles.settingInfo}>
                    <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                      {PRESETS[key].name}
                    </Text>
                    <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                      {t(`settings.feed.presets.${key}Desc`)}
                    </Text>
                  </View>
                  <IconComponent name="chevron-forward" size={16} color={theme.colors.textTertiary} />
                </TouchableOpacity>
              </React.Fragment>
            ))}
          </View>
        </View>

        {/* Diversity Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
              {t('settings.feed.diversity.title')}
            </Text>
            <TouchableOpacity onPress={() => showHelp('diversity')}>
              <IconComponent name="help-circle-outline" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            <View style={[styles.settingItem, styles.firstSettingItem]}>
              <View style={styles.settingInfo}>
                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                  {t('settings.feed.diversity.enabled')}
                </Text>
                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
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
                <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
                <View style={[styles.settingItem, styles.sliderItem]}>
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
                  <Text style={[styles.helpText, { color: theme.colors.textTertiary }]}>
                    {t('settings.feed.diversity.sameAuthorPenaltyDesc')}
                  </Text>
                </View>

                <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
                <View style={[styles.settingItem, styles.lastSettingItem, styles.sliderItem]}>
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
                  <Text style={[styles.helpText, { color: theme.colors.textTertiary }]}>
                    {t('settings.feed.diversity.sameTopicPenaltyDesc')}
                  </Text>
                </View>
              </>
            )}
          </View>
        </View>

        {/* Recency Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
              {t('settings.feed.recency.title')}
            </Text>
            <TouchableOpacity onPress={() => showHelp('recency')}>
              <IconComponent name="help-circle-outline" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            <View style={[styles.settingItem, styles.firstSettingItem, styles.sliderItem]}>
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
              <Text style={[styles.helpText, { color: theme.colors.textTertiary }]}>
                {t('settings.feed.recency.halfLifeHoursDesc')}
              </Text>
            </View>

            <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
            <View style={[styles.settingItem, styles.lastSettingItem, styles.sliderItem]}>
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
              <Text style={[styles.helpText, { color: theme.colors.textTertiary }]}>
                {t('settings.feed.recency.maxAgeHoursDesc')}
              </Text>
            </View>
          </View>
        </View>

        {/* Quality Section */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
              {t('settings.feed.quality.title')}
            </Text>
            <TouchableOpacity onPress={() => showHelp('quality')}>
              <IconComponent name="help-circle-outline" size={20} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            <View style={[styles.settingItem, styles.firstSettingItem, styles.lastSettingItem]}>
              <View style={styles.settingInfo}>
                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                  {t('settings.feed.quality.boostHighQuality')}
                </Text>
                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
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
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.resetBtn, { borderColor: theme.colors.border }]}
            onPress={resetToDefaults}
          >
            <IconComponent name="refresh-outline" size={18} color={theme.colors.textSecondary} />
            <Text style={[styles.resetText, { color: theme.colors.textSecondary }]}>
              {t('settings.feed.resetToDefaults')}
            </Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 24,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerIconContainer: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: {
    marginBottom: 32,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  settingsCard: {
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
  },
  settingItem: {
    backgroundColor: 'transparent',
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  firstSettingItem: {
    paddingTop: 18,
  },
  lastSettingItem: {
    paddingBottom: 18,
  },
  sliderItem: {
    flexDirection: 'column',
    alignItems: 'stretch',
    paddingVertical: 16,
  },
  settingInfo: {
    flex: 1,
    marginRight: 16,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '500',
    marginBottom: 2,
  },
  settingDescription: {
    fontSize: 14,
  },
  helpText: {
    fontSize: 12,
    marginTop: 8,
    lineHeight: 16,
  },
  divider: {
    height: 1,
    marginHorizontal: 16,
  },
  resetBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1,
  },
  resetText: {
    fontSize: 16,
    fontWeight: '500',
  },
});
