import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, Image, Pressable } from 'react-native';
import { useAppearanceStore, type PostTextExpand } from '@/store/appearanceStore';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useAuth } from '@oxyhq/services';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import {
  APP_COLOR_PRESETS,
  PREMIUM_COLOR_NAMES,
  useTheme,
  useBloomTheme,
  type AppColorName,
} from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';
import { useTranslation } from 'react-i18next';
import { SegmentedControl, SegmentedControlItem, SegmentedControlItemText } from '@oxyhq/bloom/segmented-control';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';
import { SettingsListDivider } from '@oxyhq/bloom/settings-list';
import { Icon } from '@/lib/icons';
import { useAppColorSave } from '@/hooks/useAppColorSave';

type ThemeMode = 'system' | 'light' | 'dark';

export default function AppearanceSettingsScreen() {
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const { colorPreset: appColor, mode: bloomMode, setMode } = useBloomTheme();
  const { showBottomSheet, oxyServices, user: authUser } = useAuth();
  const { saveColor, saving: colorSaving } = useAppColorSave();
  const safeBack = useSafeBack();
  const { colors } = useTheme();
  const { t } = useTranslation();

  const themeMode: ThemeMode = bloomMode === 'adaptive' || bloomMode === 'system'
    ? 'system'
    : bloomMode;
  const postTextExpand: PostTextExpand = mySettings?.appearance?.postTextExpand ?? 'default';
  const [headerImageId, setHeaderImageId] = useState<string>(mySettings?.profileHeaderImage ?? '');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const saving = settingsSaving || colorSaving;

  useEffect(() => {
    if (mySettings?.profileHeaderImage !== undefined) {
      setHeaderImageId(mySettings.profileHeaderImage || '');
    }
  }, [mySettings?.profileHeaderImage]);

  const normalizedUsername = authUser?.username?.toLowerCase();
  const isOxyUser = normalizedUsername === 'oxy';
  const isFaircoinUser = normalizedUsername === 'faircoin';
  const authUserRecord = authUser as { premium?: { isPremium?: boolean } } | null;
  const isPremium = authUserRecord?.premium?.isPremium ?? false;
  // Premium users see every premium color. Otherwise, unlock only the color tied
  // to the current username (e.g. @oxy unlocks "oxy", @faircoin unlocks "faircoin").
  const unlockedPremiumColors = useMemo<readonly AppColorName[] | undefined>(() => {
    if (isPremium) return PREMIUM_COLOR_NAMES;
    const unlocked: AppColorName[] = [];
    if (isOxyUser) unlocked.push('oxy');
    if (isFaircoinUser) unlocked.push('faircoin');
    return unlocked.length > 0 ? unlocked : undefined;
  }, [isPremium, isOxyUser, isFaircoinUser]);

  const preset = APP_COLOR_PRESETS[appColor];

  const saveSettings = useCallback(async (updates: { themeMode?: ThemeMode; primaryColor?: string; headerImageId?: string; postTextExpand?: PostTextExpand }) => {
    setSettingsSaving(true);
    const mode = updates.themeMode ?? themeMode;
    const color = updates.primaryColor ?? preset.hex;
    const header = updates.headerImageId ?? headerImageId;
    const expand = updates.postTextExpand ?? postTextExpand;
    await updateMySettings({
      appearance: { themeMode: mode, primaryColor: color || undefined, postTextExpand: expand },
      profileHeaderImage: header || null,
    });
    setSettingsSaving(false);
  }, [themeMode, preset.hex, headerImageId, postTextExpand, updateMySettings]);

  const onThemeModeChange = useCallback((mode: ThemeMode) => {
    setMode(mode);
    void saveSettings({ themeMode: mode });
  }, [saveSettings, setMode]);

  const onPostTextExpandChange = useCallback((value: PostTextExpand) => {
    void saveSettings({ postTextExpand: value });
  }, [saveSettings]);

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
              <Loading className="text-primary" variant="inline" size="small" />
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
          <SegmentedControl
            label={t('settings.theme', 'Color mode')}
            type="radio"
            value={themeMode}
            onChange={onThemeModeChange}>
            <SegmentedControlItem value="system">
              <SegmentedControlItemText>{t('settings.theme.system', 'System')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="light">
              <SegmentedControlItemText>{t('settings.theme.light', 'Light')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="dark">
              <SegmentedControlItemText>{t('settings.theme.dark', 'Dark')}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>

        <SettingsListDivider />

        {/* Post text length */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="text-outline" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.appearance.postTextLength', 'Post text length')}
            </Text>
          </View>
          <SegmentedControl
            label={t('settings.appearance.postTextLength', 'Post text length')}
            type="radio"
            value={postTextExpand}
            onChange={onPostTextExpandChange}>
            <SegmentedControlItem value="default">
              <SegmentedControlItemText>{t('settings.appearance.postTextLength.default', 'Default')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="more">
              <SegmentedControlItemText>{t('settings.appearance.postTextLength.more', 'More')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="muchMore">
              <SegmentedControlItemText>{t('settings.appearance.postTextLength.muchMore', 'Much more')}</SegmentedControlItemText>
            </SegmentedControlItem>
            <SegmentedControlItem value="all">
              <SegmentedControlItemText>{t('settings.appearance.postTextLength.all', 'Show all')}</SegmentedControlItemText>
            </SegmentedControlItem>
          </SegmentedControl>
        </View>

        <SettingsListDivider />

        {/* Accent color */}
        <View className="px-5 py-4 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="color-palette" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.accentColor', 'Accent color')}
            </Text>
          </View>

          <ColorSwatchPicker value={appColor} onChange={onColorChange} extraColors={unlockedPremiumColors} />
        </View>

        <SettingsListDivider />

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
