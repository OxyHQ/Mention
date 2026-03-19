import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, ScrollView, Image, Pressable } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useThemeStore } from '@/lib/theme-store';
import { APP_COLOR_PRESETS } from '@oxyhq/bloom/theme';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useAuth } from '@oxyhq/services';
import { PREMIUM_COLOR_NAMES } from '@oxyhq/bloom/theme';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import * as SegmentedControl from '@oxyhq/bloom/segmented-control';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';
import { SettingsDivider } from '@/components/settings/SettingsItem';
import { Icon } from '@/lib/icons';
import { useAppColorSave } from '@/hooks/useAppColorSave';

type ThemeMode = 'system' | 'light' | 'dark';

export default function AppearanceSettingsScreen() {
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const appColor = useThemeStore((s) => s.appColor);
  const setMode = useThemeStore((s) => s.setMode);
  const { showBottomSheet, oxyServices, user: authUser } = useAuth();
  const { saveColor, saving: colorSaving } = useAppColorSave();
  const safeBack = useSafeBack();
  const { colors } = useTheme();
  const { t } = useTranslation();

  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [headerImageId, setHeaderImageId] = useState<string>('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const saving = settingsSaving || colorSaving;

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  useEffect(() => {
    if (mySettings) {
      const mode = mySettings.appearance?.themeMode || 'system';
      setThemeMode(mode === 'adaptive' ? 'system' : mode);
      setHeaderImageId(mySettings.profileHeaderImage || '');
    }
  }, [mySettings]);

  const isOxyUser = authUser?.username?.toLowerCase() === 'oxy';
  const authUserRecord = authUser as { premium?: { isPremium?: boolean } } | null;
  const isPremium = authUserRecord?.premium?.isPremium ?? false;
  const extraColors = isOxyUser || isPremium ? PREMIUM_COLOR_NAMES : undefined;

  const preset = APP_COLOR_PRESETS[appColor];

  const saveSettings = useCallback(async (updates: { themeMode?: ThemeMode; primaryColor?: string; headerImageId?: string }) => {
    setSettingsSaving(true);
    const mode = updates.themeMode ?? themeMode;
    const color = updates.primaryColor ?? preset.hex;
    const header = updates.headerImageId ?? headerImageId;
    await updateMySettings({
      appearance: { themeMode: mode, primaryColor: color || undefined },
      profileHeaderImage: header || undefined,
    } as Record<string, unknown>);
    setSettingsSaving(false);
  }, [themeMode, preset.hex, headerImageId, updateMySettings]);

  const onThemeModeChange = useCallback(async (mode: ThemeMode) => {
    setThemeMode(mode);
    setMode(mode);
    await saveSettings({ themeMode: mode });
  }, [saveSettings, setMode]);

  const onColorChange = saveColor;

  const openHeaderPicker = () => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        afterSelect: 'back',
        onSelect: async (file: { id: string; contentType?: string }) => {
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
          title: t('settings.appearance', 'Appearance'),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: saving ? [
            <View key="saving" className="pr-2">
              <Loading variant="inline" size="small" />
            </View>,
          ] : [],
        }}
        hideBottomBorder
        disableSticky
      />

      <ScrollView
        className="flex-1"
        contentContainerClassName="py-4"
        showsVerticalScrollIndicator={false}
      >
        {/* Color mode */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="phone-portrait" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.theme', 'Color mode')}
            </Text>
          </View>
          <SegmentedControl.Root
            label={t('settings.theme', 'Color mode')}
            type="radio"
            value={themeMode}
            onChange={onThemeModeChange}>
            <SegmentedControl.Item value="system" label={t('settings.theme.system', 'System')}>
              <SegmentedControl.ItemText>{t('settings.theme.system', 'System')}</SegmentedControl.ItemText>
            </SegmentedControl.Item>
            <SegmentedControl.Item value="light" label={t('settings.theme.light', 'Light')}>
              <SegmentedControl.ItemText>{t('settings.theme.light', 'Light')}</SegmentedControl.ItemText>
            </SegmentedControl.Item>
            <SegmentedControl.Item value="dark" label={t('settings.theme.dark', 'Dark')}>
              <SegmentedControl.ItemText>{t('settings.theme.dark', 'Dark')}</SegmentedControl.ItemText>
            </SegmentedControl.Item>
          </SegmentedControl.Root>
        </View>

        <SettingsDivider />

        {/* Accent color */}
        <View className="px-5 py-4 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="color-palette" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.accentColor', 'Accent color')}
            </Text>
          </View>

          <ColorSwatchPicker value={appColor} onChange={onColorChange} extraColors={extraColors} />
        </View>

        <SettingsDivider />

        {/* Profile header */}
        <View className="px-5 py-4 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="image-outline" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.profileHeader', 'Profile header')}
            </Text>
          </View>

          {headerImageId ? (
            <View className="rounded-xl overflow-hidden border border-border relative">
              <Image
                source={{ uri: oxyServices.getFileDownloadUrl(headerImageId, 'full') }}
                className="w-full h-32 bg-muted"
                resizeMode="cover"
              />
              <View className="absolute bottom-2 right-2 flex-row gap-1.5">
                <Pressable
                  className="w-8 h-8 rounded-full items-center justify-center bg-black/60"
                  onPress={openHeaderPicker}
                >
                  <Icon name="camera-outline" size={16} color="#FFFFFF" />
                </Pressable>
                <Pressable
                  className="w-8 h-8 rounded-full items-center justify-center bg-red-500/80"
                  onPress={removeHeaderImage}
                >
                  <Icon name="trash-outline" size={16} color="#FFFFFF" />
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              className="rounded-xl border-[1.5px] border-dashed border-border bg-secondary py-5 items-center gap-1.5"
              onPress={openHeaderPicker}
            >
              <View className="w-10 h-10 rounded-full items-center justify-center bg-muted">
                <Icon name="image-outline" size={20} color={colors.textSecondary} />
              </View>
              <Text className="text-sm font-semibold text-foreground">
                {t('settings.uploadHeader', 'Upload header image')}
              </Text>
              <Text className="text-xs text-muted-foreground">
                {t('settings.uploadHeaderHint', 'Recommended: 1500x500px')}
              </Text>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </ThemedView>
  );
}
