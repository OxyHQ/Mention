import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Image } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useThemeStore } from '@/lib/theme-store';
import { APP_COLOR_PRESETS, APP_COLOR_NAMES, type AppColorName } from '@/lib/app-color-presets';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { Loading } from '@/components/ui/Loading';
import { SPACING } from '@/styles/spacing';
import { FONT_SIZES, FONT_FAMILIES } from '@/styles/typography';
import { Divider } from '@/components/Divider';
import { useTranslation } from 'react-i18next';

type ThemeMode = 'system' | 'light' | 'dark' | 'adaptive';

interface ThemeOption {
  id: ThemeMode;
  label: string;
  icon: string;
  iconSet?: 'ionicons' | 'material-community';
  description: string;
  bgColor: string;
  fgColor: string;
  accentColor?: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'light',
    label: 'Light',
    icon: 'sunny-outline',
    description: 'Always light',
    bgColor: '#FFFFFF',
    fgColor: '#1A1A1A',
  },
  {
    id: 'dark',
    label: 'Dark',
    icon: 'moon-outline',
    description: 'Always dark',
    bgColor: '#1A1A1A',
    fgColor: '#EDEDED',
  },
  {
    id: 'system',
    label: 'System',
    icon: 'phone-portrait-outline',
    description: 'Match device',
    bgColor: '#6366F1',
    fgColor: '#FFFFFF',
  },
  {
    id: 'adaptive',
    label: 'Adaptive',
    icon: 'palette-outline',
    iconSet: 'material-community',
    description: 'Material You',
    bgColor: '#E8DEF8',
    fgColor: '#1D1B20',
    accentColor: '#6750A4',
  },
];

export default function AppearanceSettingsScreen() {
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loading = useAppearanceStore((state) => state.loading);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const appColor = useThemeStore((s) => s.appColor);
  const setAppColor = useThemeStore((s) => s.setAppColor);
  const setMode = useThemeStore((s) => s.setMode);
  const { showBottomSheet, oxyServices } = useAuth();
  const theme = useTheme();
  const { t } = useTranslation();

  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [headerImageId, setHeaderImageId] = useState<string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  useEffect(() => {
    if (mySettings) {
      setThemeMode(mySettings.appearance?.themeMode || 'system');
      setHeaderImageId(mySettings.profileHeaderImage || '');
    }
  }, [mySettings]);

  const activePrimaryColor = APP_COLOR_PRESETS[appColor].hex;

  // Auto-save helper
  const saveSettings = useCallback(async (updates: { themeMode?: ThemeMode; primaryColor?: string; headerImageId?: string }) => {
    setSaving(true);
    const mode = updates.themeMode ?? themeMode;
    const color = updates.primaryColor ?? activePrimaryColor;
    const header = updates.headerImageId ?? headerImageId;
    await updateMySettings({
      appearance: { themeMode: mode, primaryColor: color || undefined },
      profileHeaderImage: header || undefined,
    } as any);
    setSaving(false);
  }, [themeMode, activePrimaryColor, headerImageId, updateMySettings]);

  const onThemeModeChange = useCallback(async (mode: ThemeMode) => {
    setThemeMode(mode);
    setMode(mode);
    await saveSettings({ themeMode: mode });
  }, [saveSettings, setMode]);

  const onColorChange = useCallback(async (name: AppColorName) => {
    setAppColor(name);
    const hex = APP_COLOR_PRESETS[name].hex;
    await saveSettings({ primaryColor: hex });
  }, [saveSettings, setAppColor]);

  const openHeaderPicker = () => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        afterSelect: 'back',
        onSelect: async (file: any) => {
          if (!file?.contentType?.startsWith?.('image/')) return;
          setHeaderImageId(file.id);
          await saveSettings({ headerImageId: file.id });
        },
      },
    });
  };

  const removeHeaderImage = useCallback(async () => {
    setHeaderImageId('');
    await saveSettings({ headerImageId: '' });
  }, [saveSettings]);

  return (
    <ThemedView style={styles.container}>
      <Header
        options={{
          title: t('settings.appearance', 'Display'),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
          rightComponents: saving ? [
            <View key="saving" style={styles.savingIndicator}>
              <Loading variant="inline" size="small" />
            </View>,
          ] : [],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Theme Section */}
        <View style={styles.sectionContainer}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            {t('settings.theme', 'Theme')}
          </Text>
          <Text style={[styles.sectionDescription, { color: theme.colors.textSecondary }]}>
            {t('settings.themeDescription', 'Choose how Mention looks to you. Select a single theme, or sync with your system settings.')}
          </Text>

          <View style={styles.themeOptionsRow}>
            {THEME_OPTIONS.map((option) => {
              const isActive = themeMode === option.id;
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[
                    styles.themeCard,
                    {
                      borderColor: isActive ? activePrimaryColor : theme.colors.border,
                      backgroundColor: theme.colors.card,
                    },
                    isActive && styles.themeCardActive,
                    isActive && { borderColor: activePrimaryColor },
                  ]}
                  onPress={() => onThemeModeChange(option.id)}
                  activeOpacity={0.7}
                >
                  {/* Theme preview */}
                  <View style={[styles.themePreview, { backgroundColor: option.bgColor }]}>
                    {option.id === 'adaptive' ? (
                      <View style={styles.themePreviewContent}>
                        <View style={styles.adaptivePreviewRow}>
                          <View style={[styles.adaptivePreviewDot, { backgroundColor: '#6750A4' }]} />
                          <View style={[styles.previewLine, { backgroundColor: '#6750A4', width: '40%', opacity: 0.8 }]} />
                        </View>
                        <View style={[styles.previewLine, { backgroundColor: option.fgColor, width: '70%', opacity: 0.3 }]} />
                        <View style={styles.adaptivePreviewRow}>
                          <View style={[styles.adaptivePreviewChip, { backgroundColor: '#D0BCFF' }]} />
                          <View style={[styles.adaptivePreviewChip, { backgroundColor: '#CCC2DC' }]} />
                          <View style={[styles.adaptivePreviewChip, { backgroundColor: '#EFB8C8' }]} />
                        </View>
                      </View>
                    ) : (
                      <View style={styles.themePreviewContent}>
                        <View style={[styles.previewLine, { backgroundColor: option.fgColor, width: '60%', opacity: 0.8 }]} />
                        <View style={[styles.previewLine, { backgroundColor: option.fgColor, width: '80%', opacity: 0.4 }]} />
                        <View style={[styles.previewLine, { backgroundColor: option.fgColor, width: '45%', opacity: 0.25 }]} />
                      </View>
                    )}
                    {option.id === 'system' && (
                      <View style={styles.systemSplit}>
                        <View style={[styles.systemHalf, { backgroundColor: '#FFFFFF' }]}>
                          <View style={[styles.previewLineTiny, { backgroundColor: '#1A1A1A', opacity: 0.5 }]} />
                        </View>
                      </View>
                    )}
                  </View>

                  {/* Label area */}
                  <View style={styles.themeCardInfo}>
                    <View style={styles.themeCardLabelRow}>
                      {option.iconSet === 'material-community' ? (
                        <MaterialCommunityIcons
                          name={option.icon as keyof typeof MaterialCommunityIcons.glyphMap}
                          size={16}
                          color={isActive ? activePrimaryColor : theme.colors.textSecondary}
                        />
                      ) : (
                        <Ionicons
                          name={option.icon as keyof typeof Ionicons.glyphMap}
                          size={16}
                          color={isActive ? activePrimaryColor : theme.colors.textSecondary}
                        />
                      )}
                      <Text style={[
                        styles.themeCardLabel,
                        { color: isActive ? activePrimaryColor : theme.colors.text },
                      ]}>
                        {t(`settings.theme.${option.id}`, option.label)}
                      </Text>
                    </View>
                    <Text style={[styles.themeCardDesc, { color: theme.colors.textSecondary }]}>
                      {t(`settings.theme.${option.id}Desc`, option.description)}
                    </Text>
                  </View>

                  {/* Selection indicator */}
                  <View style={[
                    styles.radioOuter,
                    { borderColor: isActive ? activePrimaryColor : theme.colors.border },
                  ]}>
                    {isActive && (
                      <View style={[styles.radioInner, { backgroundColor: activePrimaryColor }]} />
                    )}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <Divider />

        {/* Color Section */}
        <View style={[styles.sectionContainer, themeMode === 'adaptive' && styles.sectionDisabled]}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            {t('settings.accentColor', 'Accent color')}
          </Text>
          {themeMode === 'adaptive' ? (
            <Text style={[styles.sectionDescription, { color: theme.colors.textSecondary }]}>
              {t('settings.accentColorAdaptiveNote', 'Colors are set by your device when using adaptive theme.')}
            </Text>
          ) : (
            <Text style={[styles.sectionDescription, { color: theme.colors.textSecondary }]}>
              {t('settings.accentColorDescription', 'Pick your favorite color. It will be used for links, buttons, and highlights throughout the app.')}
            </Text>
          )}

          {/* Color preview bar */}
          <View style={[styles.colorPreviewBar, { backgroundColor: activePrimaryColor }]}>
            <View style={styles.colorPreviewContent}>
              <View style={[styles.colorPreviewAvatar, { backgroundColor: 'rgba(255,255,255,0.3)' }]} />
              <View style={styles.colorPreviewTextGroup}>
                <View style={[styles.colorPreviewText, { backgroundColor: 'rgba(255,255,255,0.9)', width: 80 }]} />
                <View style={[styles.colorPreviewText, { backgroundColor: 'rgba(255,255,255,0.5)', width: 120 }]} />
              </View>
            </View>
            <View style={[styles.colorPreviewButton, { backgroundColor: 'rgba(255,255,255,0.2)' }]}>
              <Text style={styles.colorPreviewButtonText}>Follow</Text>
            </View>
          </View>

          {/* Color swatches */}
          <View style={styles.colorsGrid}>
            {APP_COLOR_NAMES.map((name) => {
              const preset = APP_COLOR_PRESETS[name];
              const isActive = appColor === name;
              return (
                <TouchableOpacity
                  key={name}
                  style={[
                    styles.colorSwatch,
                    { backgroundColor: preset.hex },
                    isActive && styles.colorSwatchActive,
                  ]}
                  onPress={() => onColorChange(name)}
                  activeOpacity={0.7}
                >
                  {isActive && (
                    <Ionicons name="checkmark" size={20} color="#FFFFFF" />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Reset to default */}
          {appColor !== 'teal' && (
            <TouchableOpacity
              style={[styles.resetButton, { borderColor: theme.colors.border }]}
              onPress={() => onColorChange('teal')}
            >
              <Ionicons name="refresh-outline" size={16} color={theme.colors.textSecondary} />
              <Text style={[styles.resetButtonText, { color: theme.colors.textSecondary }]}>
                {t('settings.resetToDefault', 'Reset to default')}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <Divider />

        {/* Profile Header Image */}
        <View style={styles.sectionContainer}>
          <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
            {t('settings.profileHeader', 'Profile header')}
          </Text>
          <Text style={[styles.sectionDescription, { color: theme.colors.textSecondary }]}>
            {t('settings.profileHeaderDescription', 'Customize the header image shown on your profile page.')}
          </Text>

          {headerImageId ? (
            <View style={[styles.headerImageContainer, { borderColor: theme.colors.border }]}>
              <Image
                source={{ uri: oxyServices.getFileDownloadUrl(headerImageId, 'full') }}
                style={[styles.headerImage, { backgroundColor: theme.colors.backgroundSecondary }]}
                resizeMode="cover"
              />
              <View style={styles.headerImageOverlay}>
                <TouchableOpacity
                  style={[styles.headerImageAction, { backgroundColor: 'rgba(0,0,0,0.6)' }]}
                  onPress={openHeaderPicker}
                >
                  <Ionicons name="camera-outline" size={18} color="#FFFFFF" />
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.headerImageAction, { backgroundColor: 'rgba(239,68,68,0.8)' }]}
                  onPress={removeHeaderImage}
                >
                  <Ionicons name="trash-outline" size={18} color="#FFFFFF" />
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.headerUploadArea, { borderColor: theme.colors.border, backgroundColor: theme.colors.backgroundSecondary }]}
              onPress={openHeaderPicker}
              activeOpacity={0.7}
            >
              <View style={[styles.headerUploadIcon, { backgroundColor: theme.colors.backgroundTertiary }]}>
                <Ionicons name="image-outline" size={24} color={theme.colors.textSecondary} />
              </View>
              <Text style={[styles.headerUploadText, { color: theme.colors.text }]}>
                {t('settings.uploadHeader', 'Upload header image')}
              </Text>
              <Text style={[styles.headerUploadHint, { color: theme.colors.textTertiary }]}>
                {t('settings.uploadHeaderHint', 'Recommended: 1500x500px')}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Bottom spacing */}
        <View style={styles.bottomSpacer} />
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
    paddingBottom: SPACING['3xl'],
  },
  savingIndicator: {
    paddingRight: SPACING.sm,
  },

  // Section
  sectionContainer: {
    paddingHorizontal: SPACING.base,
    paddingVertical: SPACING.lg,
  },
  sectionDisabled: {
    opacity: 0.4,
    pointerEvents: 'none' as const,
  },
  sectionTitle: {
    fontSize: FONT_SIZES.xl,
    fontWeight: '700',
    marginBottom: SPACING.xs,
    fontFamily: FONT_FAMILIES.primary,
  },
  sectionDescription: {
    fontSize: FONT_SIZES.base,
    lineHeight: FONT_SIZES.base * 1.5,
    marginBottom: SPACING.base,
    fontFamily: FONT_FAMILIES.primary,
  },

  // Theme Cards
  themeOptionsRow: {
    gap: SPACING.md,
  },
  themeCard: {
    borderWidth: 1.5,
    borderRadius: 16,
    overflow: 'hidden',
    position: 'relative',
  },
  themeCardActive: {
    borderWidth: 2,
  },
  themePreview: {
    height: 80,
    justifyContent: 'center',
    paddingHorizontal: SPACING.base,
    position: 'relative',
    overflow: 'hidden',
  },
  themePreviewContent: {
    gap: 6,
  },
  previewLine: {
    height: 8,
    borderRadius: 4,
  },
  adaptivePreviewRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 6,
  },
  adaptivePreviewDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  adaptivePreviewChip: {
    height: 10,
    width: 32,
    borderRadius: 5,
  },
  previewLineTiny: {
    height: 6,
    width: '50%',
    borderRadius: 3,
  },
  systemSplit: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: '50%',
    overflow: 'hidden',
  },
  systemHalf: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
  },
  themeCardInfo: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
  },
  themeCardLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginBottom: 2,
  },
  themeCardLabel: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    fontFamily: FONT_FAMILIES.primary,
  },
  themeCardDesc: {
    fontSize: FONT_SIZES.sm,
    marginLeft: 24,
    fontFamily: FONT_FAMILIES.primary,
  },
  radioOuter: {
    position: 'absolute',
    top: SPACING.md,
    right: SPACING.md,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },

  // Color Section
  colorPreviewBar: {
    borderRadius: 16,
    padding: SPACING.base,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.base,
  },
  colorPreviewContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  colorPreviewAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
  },
  colorPreviewTextGroup: {
    gap: 4,
  },
  colorPreviewText: {
    height: 8,
    borderRadius: 4,
  },
  colorPreviewButton: {
    paddingHorizontal: SPACING.base,
    paddingVertical: SPACING.sm,
    borderRadius: 20,
  },
  colorPreviewButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: FONT_SIZES.sm,
    fontFamily: FONT_FAMILIES.primary,
  },
  colorsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  colorSwatch: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorSwatchActive: {
    transform: [{ scale: 1.1 }],
  },
  resetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.base,
    paddingVertical: SPACING.sm,
    paddingHorizontal: SPACING.md,
    borderRadius: 20,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  resetButtonText: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '500',
    fontFamily: FONT_FAMILIES.primary,
  },

  // Header Image
  headerImageContainer: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    position: 'relative',
  },
  headerImage: {
    width: '100%',
    height: 160,
  },
  headerImageOverlay: {
    position: 'absolute',
    bottom: SPACING.md,
    right: SPACING.md,
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  headerImageAction: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerUploadArea: {
    borderRadius: 16,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    paddingVertical: SPACING['2xl'],
    alignItems: 'center',
    gap: SPACING.sm,
  },
  headerUploadIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: SPACING.xs,
  },
  headerUploadText: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    fontFamily: FONT_FAMILIES.primary,
  },
  headerUploadHint: {
    fontSize: FONT_SIZES.sm,
    fontFamily: FONT_FAMILIES.primary,
  },

  bottomSpacer: {
    height: SPACING['3xl'],
  },
});
