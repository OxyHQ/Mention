import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useThemeStore } from '@/lib/theme-store';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';
import { SettingsDivider } from '@/components/settings/SettingsItem';
import { ColorSwatchPicker } from '@/components/settings/ColorSwatchPicker';
import { Icon } from '@/lib/icons';
import { useAppColorSave } from '@/hooks/useAppColorSave';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';
import { Ionicons } from '@expo/vector-icons';

type ProfileStyle = 'default' | 'minimalist';
type IoniconName = React.ComponentProps<typeof Ionicons>['name'];

interface StyleOption {
  id: ProfileStyle;
  name: string;
  description: string;
  icon: IoniconName;
  coverPhotoEnabled: boolean;
  minimalistMode: boolean;
}

export default function ProfileCustomizationScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const appColor = useThemeStore((s) => s.appColor);
  const { colors } = useTheme();
  const { saveColor, saving: colorSaving } = useAppColorSave();

  const [coverPhotoEnabled, setCoverPhotoEnabled] = useState<boolean>(true);
  const [minimalistMode, setMinimalistMode] = useState<boolean>(false);
  const [styleSaving, setStyleSaving] = useState(false);

  const saving = styleSaving || colorSaving;

  const styleOptions: StyleOption[] = useMemo(() => [
    {
      id: 'default' as ProfileStyle,
      name: t('settings.profileCustomization.styleDefault'),
      description: t('settings.profileCustomization.styleDefaultDesc'),
      icon: 'image-outline',
      coverPhotoEnabled: true,
      minimalistMode: false,
    },
    {
      id: 'minimalist' as ProfileStyle,
      name: t('settings.profileCustomization.styleMinimalist'),
      description: t('settings.profileCustomization.styleMinimalistDesc'),
      icon: 'remove-outline',
      coverPhotoEnabled: false,
      minimalistMode: true,
    },
  ], [t]);

  const currentStyle: ProfileStyle = useMemo(() => {
    if (minimalistMode && !coverPhotoEnabled) {
      return 'minimalist';
    }
    return 'default';
  }, [minimalistMode, coverPhotoEnabled]);

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  useEffect(() => {
    if (mySettings) {
      setCoverPhotoEnabled(mySettings.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings.profileCustomization?.minimalistMode ?? false);
    }
  }, [mySettings]);

  const handleStyleSelect = useCallback(async (style: StyleOption) => {
    setStyleSaving(true);
    try {
      setCoverPhotoEnabled(style.coverPhotoEnabled);
      setMinimalistMode(style.minimalistMode);

      await updateMySettings({
        profileCustomization: {
          coverPhotoEnabled: style.coverPhotoEnabled,
          minimalistMode: style.minimalistMode,
        },
      } as Record<string, unknown>);
    } catch (error) {
      logger.error('Error updating profile customization', { error });
      setCoverPhotoEnabled(mySettings?.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings?.profileCustomization?.minimalistMode ?? false);
    } finally {
      setStyleSaving(false);
    }
  }, [updateMySettings, mySettings]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.profileCustomization.title'),
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
        {/* Profile Style */}
        <View className="px-5 py-3 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="layers-outline" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.profileCustomization.profileStyle')}
            </Text>
          </View>
          <View className="flex-row gap-3">
            {styleOptions.map((style) => {
              const isSelected = currentStyle === style.id;
              return (
                <TouchableOpacity
                  key={style.id}
                  className="flex-1 rounded-xl overflow-hidden relative"
                  style={{
                    minWidth: '47%',
                    backgroundColor: colors.card,
                    borderColor: isSelected ? colors.primary : colors.border,
                    borderWidth: isSelected ? 2 : 1,
                  }}
                  onPress={() => handleStyleSelect(style)}
                  activeOpacity={0.7}
                >
                  {/* Static Preview */}
                  <View className="w-full overflow-hidden">
                    {style.coverPhotoEnabled ? (
                      <View className="w-full h-[60px]" style={{ backgroundColor: colors.primary + '20' }} />
                    ) : (
                      <View className="w-full h-0" />
                    )}

                    <View className="px-2 pb-3 pt-1" style={{ backgroundColor: colors.background }}>
                      <View
                        className="w-10 h-10 rounded-full self-start"
                        style={{
                          backgroundColor: colors.backgroundSecondary,
                          borderWidth: 2,
                          borderColor: colors.background,
                          marginTop: style.minimalistMode ? 8 : -20,
                        }}
                      />
                      <View className="mt-2">
                        <View
                          className="h-3 w-4/5 rounded-md"
                          style={{
                            backgroundColor: colors.backgroundSecondary,
                            marginTop: style.minimalistMode ? 8 : 12,
                          }}
                        />
                        <View
                          className="h-2.5 w-3/5 rounded-md mt-1"
                          style={{ backgroundColor: colors.backgroundSecondary }}
                        />
                      </View>
                      <View
                        className="h-2 w-full rounded mt-2"
                        style={{ backgroundColor: colors.backgroundSecondary }}
                      />
                      <View
                        className="h-2 w-3/5 rounded mt-1"
                        style={{ backgroundColor: colors.backgroundSecondary }}
                      />
                    </View>
                  </View>

                  {/* Style Info */}
                  <View className="p-3">
                    <View className="flex-row items-center gap-1.5 mb-1">
                      <Icon
                        name={style.icon}
                        size={18}
                        color={isSelected ? colors.primary : colors.textSecondary}
                      />
                      <Text
                        className="text-sm font-semibold"
                        style={{ color: isSelected ? colors.primary : colors.text }}
                      >
                        {style.name}
                      </Text>
                    </View>
                    <Text className="text-xs leading-4 text-muted-foreground">
                      {style.description}
                    </Text>
                  </View>

                  {/* Selected indicator */}
                  {isSelected && (
                    <View
                      className="absolute top-2 right-2 w-6 h-6 rounded-full items-center justify-center"
                      style={{ backgroundColor: colors.primary }}
                    >
                      <Icon name="checkmark" size={14} color="#fff" />
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <SettingsDivider />

        {/* Profile Color */}
        <View className="px-5 py-4 gap-3">
          <View className="flex-row items-center gap-3">
            <Icon name="color-palette" size={22} color={colors.text} />
            <Text className="text-[16px] text-foreground">
              {t('settings.profileCustomization.profileColor', { defaultValue: 'Profile color' })}
            </Text>
          </View>

          <ColorSwatchPicker value={appColor} onChange={saveColor} />

          <Text className="text-[13px] leading-[18px] text-muted-foreground">
            {t('settings.profileCustomization.profileColorHint', { defaultValue: 'This color is used across the app and on your profile. Visitors will see this color when viewing your profile.' })}
          </Text>
        </View>

        <SettingsDivider />

        {/* Info Text */}
        <View className="flex-row items-start px-5 py-4 gap-2">
          <Icon name="information-circle-outline" size={16} color={colors.textTertiary} />
          <Text className="flex-1 text-[13px] leading-[18px] text-muted-foreground">
            {t('settings.profileCustomization.info')}
          </Text>
        </View>
      </ScrollView>
    </ThemedView>
  );
}
