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
import { Divider } from '@/components/Divider';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

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
  const { colors } = useTheme();
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
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.appearance', 'Display'),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: saving ? [
            <View key="saving" className="pr-2">
              <Loading variant="inline" size="small" />
            </View>,
          ] : [],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-8"
        showsVerticalScrollIndicator={false}
      >
        {/* Theme Section */}
        <View className="px-4 py-5">
          <Text className="text-xl font-bold mb-1 text-foreground">
            {t('settings.theme', 'Theme')}
          </Text>
          <Text className="text-base leading-6 mb-4 text-muted-foreground">
            {t('settings.themeDescription', 'Choose how Mention looks to you. Select a single theme, or sync with your system settings.')}
          </Text>

          <View className="gap-3">
            {THEME_OPTIONS.map((option) => {
              const isActive = themeMode === option.id;
              return (
                <TouchableOpacity
                  key={option.id}
                  style={[
                    styles.themeCard,
                    {
                      borderColor: isActive ? activePrimaryColor : colors.border,
                      backgroundColor: colors.card,
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
                  <View className="px-3 py-3">
                    <View className="flex-row items-center gap-2 mb-0.5">
                      {option.iconSet === 'material-community' ? (
                        <MaterialCommunityIcons
                          name={option.icon as keyof typeof MaterialCommunityIcons.glyphMap}
                          size={16}
                          color={isActive ? activePrimaryColor : colors.textSecondary}
                        />
                      ) : (
                        <Ionicons
                          name={option.icon as keyof typeof Ionicons.glyphMap}
                          size={16}
                          color={isActive ? activePrimaryColor : colors.textSecondary}
                        />
                      )}
                      <Text style={{ color: isActive ? activePrimaryColor : colors.text }} className="text-[15px] font-semibold">
                        {t(`settings.theme.${option.id}`, option.label)}
                      </Text>
                    </View>
                    <Text className="text-sm ml-6 text-muted-foreground">
                      {t(`settings.theme.${option.id}Desc`, option.description)}
                    </Text>
                  </View>

                  {/* Selection indicator */}
                  <View style={[
                    styles.radioOuter,
                    { borderColor: isActive ? activePrimaryColor : colors.border },
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
        <View className={cn("px-4 py-5", themeMode === 'adaptive' && "opacity-40 pointer-events-none")}>
          <Text className="text-xl font-bold mb-1 text-foreground">
            {t('settings.accentColor', 'Accent color')}
          </Text>
          {themeMode === 'adaptive' ? (
            <Text className="text-base leading-6 mb-4 text-muted-foreground">
              {t('settings.accentColorAdaptiveNote', 'Colors are set by your device when using adaptive theme.')}
            </Text>
          ) : (
            <Text className="text-base leading-6 mb-4 text-muted-foreground">
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
          <View className="flex-row flex-wrap gap-3">
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
              className="flex-row items-center gap-2 mt-4 py-2 px-3 rounded-full border border-border self-start"
              onPress={() => onColorChange('teal')}
            >
              <Ionicons name="refresh-outline" size={16} color={colors.textSecondary} />
              <Text className="text-sm font-medium text-muted-foreground">
                {t('settings.resetToDefault', 'Reset to default')}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        <Divider />

        {/* Profile Header Image */}
        <View className="px-4 py-5">
          <Text className="text-xl font-bold mb-1 text-foreground">
            {t('settings.profileHeader', 'Profile header')}
          </Text>
          <Text className="text-base leading-6 mb-4 text-muted-foreground">
            {t('settings.profileHeaderDescription', 'Customize the header image shown on your profile page.')}
          </Text>

          {headerImageId ? (
            <View className="rounded-2xl overflow-hidden border border-border relative">
              <Image
                source={{ uri: oxyServices.getFileDownloadUrl(headerImageId, 'full') }}
                style={[styles.headerImage, { backgroundColor: colors.backgroundSecondary }]}
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
              className="rounded-2xl border-[1.5px] border-dashed border-border bg-secondary py-8 items-center gap-2"
              onPress={openHeaderPicker}
              activeOpacity={0.7}
            >
              <View
                className="w-14 h-14 rounded-full items-center justify-center mb-1"
                style={{ backgroundColor: colors.backgroundTertiary }}
              >
                <Ionicons name="image-outline" size={24} color={colors.textSecondary} />
              </View>
              <Text className="text-[15px] font-semibold text-foreground">
                {t('settings.uploadHeader', 'Upload header image')}
              </Text>
              <Text className="text-sm text-muted-foreground">
                {t('settings.uploadHeaderHint', 'Recommended: 1500x500px')}
              </Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Bottom spacing */}
        <View className="h-8" />
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  // Theme Cards - keeping pixel-specific styles that need precise control
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
    paddingHorizontal: 16,
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
    flexDirection: 'row',
    alignItems: 'center',
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
    paddingHorizontal: 12,
  },
  radioOuter: {
    position: 'absolute',
    top: 12,
    right: 12,
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
    padding: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  colorPreviewContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
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
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  colorPreviewButtonText: {
    color: '#FFFFFF',
    fontWeight: '700',
    fontSize: 14,
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

  // Header Image
  headerImage: {
    width: '100%',
    height: 160,
  },
  headerImageOverlay: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    flexDirection: 'row',
    gap: 8,
  },
  headerImageAction: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
