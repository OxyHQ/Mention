import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, Image } from 'react-native';
import { vars } from 'react-native-css';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useThemeStore } from '@/lib/theme-store';
import { APP_COLOR_PRESETS, APP_COLOR_NAMES, type AppColorName, type AppColorPreset } from '@/lib/app-color-presets';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@oxyhq/services';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { Loading } from '@/components/ui/Loading';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

type ThemeMode = 'system' | 'light' | 'dark';

/** Miniature post row used inside MentionMiniature feed column */
function MiniPost({ hasImage }: { hasImage?: boolean }) {
  return (
    <View className="flex-row gap-1 p-1.5">
      <View className="w-3.5 h-3.5 rounded-full bg-muted-foreground/20" />
      <View className="flex-1 gap-1">
        <View className="flex-row gap-1">
          <View className="h-1 w-2/5 rounded-full bg-foreground/80" />
          <View className="h-1 w-1/4 rounded-full bg-muted-foreground/30" />
        </View>
        <View className="h-0.5 w-full rounded-full bg-foreground/40" />
        <View className="h-0.5 w-3/4 rounded-full bg-foreground/40" />
        {hasImage && <View className="h-4 w-full rounded bg-muted mt-0.5" />}
      </View>
    </View>
  );
}

/** Miniature Mention app preview using real theme tokens via vars() */
const MentionMiniature = React.memo(function MentionMiniature({ variant, preset }: { variant: 'light' | 'dark'; preset: AppColorPreset }) {
  const themeVars = vars(variant === 'light' ? preset.light : preset.dark);

  return (
    <View className="flex-row flex-1 rounded-md overflow-hidden bg-background" style={themeVars}>
      {/* Collapsed icon sidebar */}
      <View className="items-center py-2 gap-1.5 justify-between" style={{ width: '15%' }}>
        <View className="gap-2 items-center">
          <View className="w-2.5 h-2.5 rounded bg-foreground/80" />
          <View className="w-2 h-2 rounded-full bg-primary" />
          <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground/25" />
          <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground/25" />
          <View className="w-1.5 h-1.5 rounded-full bg-muted-foreground/25" />
        </View>
        <View className="items-center gap-1.5">
          <View className="w-3 h-3 rounded-full bg-primary" />
          <View className="w-2 h-2 rounded-full bg-muted-foreground/30" />
        </View>
      </View>

      {/* Timeline feed */}
      <View className="flex-1 border-x border-border">
        <View className="px-1.5 py-1 border-b border-border flex-row gap-2 items-center">
          <View className="h-1 w-1/4 rounded-full bg-primary" />
          <View className="h-1 w-1/4 rounded-full bg-muted-foreground/20" />
        </View>
        <MiniPost />
        <View className="h-px bg-border" />
        <MiniPost hasImage />
        <View className="h-px bg-border" />
        <MiniPost />
      </View>

      {/* Right panel */}
      <View className="py-1.5 px-1.5 gap-1.5" style={{ width: '32%' }}>
        <View className="h-2 rounded-full bg-muted" />
        <View className="rounded bg-muted p-1.5 gap-1">
          <View className="h-1 w-3/4 rounded-full bg-foreground/60" />
          <View className="h-0.5 w-full rounded-full bg-muted-foreground/20" />
          <View className="h-0.5 w-2/3 rounded-full bg-muted-foreground/20" />
        </View>
        <View className="rounded bg-muted p-1.5 gap-1">
          <View className="h-1 w-2/3 rounded-full bg-foreground/60" />
          <View className="flex-row gap-1 items-center">
            <View className="w-2 h-2 rounded-full bg-muted-foreground/20" />
            <View className="h-0.5 flex-1 rounded-full bg-muted-foreground/20" />
          </View>
          <View className="flex-row gap-1 items-center">
            <View className="w-2 h-2 rounded-full bg-muted-foreground/20" />
            <View className="h-0.5 flex-1 rounded-full bg-muted-foreground/20" />
          </View>
        </View>
      </View>
    </View>
  );
});

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
      const mode = mySettings.appearance?.themeMode || 'system';
      setThemeMode(mode === 'adaptive' ? 'system' : mode);
      setHeaderImageId(mySettings.profileHeaderImage || '');
    }
  }, [mySettings]);

  const preset = APP_COLOR_PRESETS[appColor];

  const saveSettings = useCallback(async (updates: { themeMode?: ThemeMode; primaryColor?: string; headerImageId?: string }) => {
    setSaving(true);
    const mode = updates.themeMode ?? themeMode;
    const color = updates.primaryColor ?? preset.hex;
    const header = updates.headerImageId ?? headerImageId;
    await updateMySettings({
      appearance: { themeMode: mode, primaryColor: color || undefined },
      profileHeaderImage: header || undefined,
    } as Record<string, unknown>);
    setSaving(false);
  }, [themeMode, preset.hex, headerImageId, updateMySettings]);

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
        contentContainerClassName="p-4 gap-5"
        showsVerticalScrollIndicator={false}
      >
        {/* Theme */}
        <View className="gap-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            {t('settings.theme', 'Theme')}
          </Text>

          <View className="flex-row gap-2">
            <Pressable onPress={() => onThemeModeChange('light')} className="flex-1">
              <View
                className={cn(
                  'rounded-lg p-1.5',
                  themeMode === 'light' ? 'border-2 border-primary' : 'border border-border',
                )}
              >
                <View className="mb-1 aspect-[4/3]">
                  <MentionMiniature variant="light" preset={preset} />
                </View>
                <Text className="text-center text-xs font-medium text-foreground">
                  {t('settings.theme.light', 'Light')}
                </Text>
              </View>
            </Pressable>

            <Pressable onPress={() => onThemeModeChange('system')} className="flex-1">
              <View
                className={cn(
                  'rounded-lg p-1.5',
                  themeMode === 'system' ? 'border-2 border-primary' : 'border border-border',
                )}
              >
                <View className="rounded overflow-hidden mb-1 aspect-[4/3]">
                  <View className="flex-row flex-1">
                    <View className="flex-1 overflow-hidden">
                      <MentionMiniature variant="light" preset={preset} />
                    </View>
                    <View className="flex-1 overflow-hidden">
                      <MentionMiniature variant="dark" preset={preset} />
                    </View>
                  </View>
                </View>
                <Text className="text-center text-xs font-medium text-foreground">
                  {t('settings.theme.system', 'System')}
                </Text>
              </View>
            </Pressable>

            <Pressable onPress={() => onThemeModeChange('dark')} className="flex-1">
              <View
                className={cn(
                  'rounded-lg p-1.5',
                  themeMode === 'dark' ? 'border-2 border-primary' : 'border border-border',
                )}
              >
                <View className="mb-1 aspect-[4/3]">
                  <MentionMiniature variant="dark" preset={preset} />
                </View>
                <Text className="text-center text-xs font-medium text-foreground">
                  {t('settings.theme.dark', 'Dark')}
                </Text>
              </View>
            </Pressable>
          </View>
        </View>

        {/* Accent color */}
        <View className="gap-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            {t('settings.accentColor', 'Accent color')}
          </Text>

          <View className="flex-row gap-3 flex-wrap">
            {APP_COLOR_NAMES.map((name) => {
              const p = APP_COLOR_PRESETS[name];
              const isSelected = appColor === name;
              return (
                <Pressable
                  key={name}
                  onPress={() => onColorChange(name)}
                  className="items-center gap-1"
                >
                  <View
                    className={cn(
                      'w-8 h-8 rounded-full border-2 overflow-hidden',
                      isSelected ? 'border-foreground scale-110' : 'border-transparent',
                    )}
                  >
                    <View style={{ backgroundColor: p.hex, flex: 1 }} />
                  </View>
                  <Text
                    className={cn(
                      'text-[10px] capitalize',
                      isSelected ? 'text-foreground font-medium' : 'text-muted-foreground',
                    )}
                  >
                    {name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>

        {/* Profile header */}
        <View className="gap-2">
          <Text className="text-[11px] font-semibold text-muted-foreground tracking-wider uppercase">
            {t('settings.profileHeader', 'Profile header')}
          </Text>

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
                  <Ionicons name="camera-outline" size={16} color="#FFFFFF" />
                </Pressable>
                <Pressable
                  className="w-8 h-8 rounded-full items-center justify-center bg-red-500/80"
                  onPress={removeHeaderImage}
                >
                  <Ionicons name="trash-outline" size={16} color="#FFFFFF" />
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              className="rounded-xl border-[1.5px] border-dashed border-border bg-secondary py-5 items-center gap-1.5"
              onPress={openHeaderPicker}
            >
              <View className="w-10 h-10 rounded-full items-center justify-center bg-muted">
                <Ionicons name="image-outline" size={20} color={colors.textSecondary} />
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
