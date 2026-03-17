import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Pressable } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Ionicons } from '@expo/vector-icons';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { useTheme, APP_COLOR_PRESETS, APP_COLOR_NAMES, HEX_TO_APP_COLOR, type AppColorName } from '@oxyhq/bloom/theme';
import { Loading } from '@oxyhq/bloom/loading';
import { SettingsDivider } from '@/components/settings/SettingsItem';
import { Icon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

const IconComponent = Ionicons as React.ComponentType<React.ComponentProps<typeof Ionicons>>;

type ProfileStyle = 'default' | 'minimalist';

interface StyleOption {
  id: ProfileStyle;
  name: string;
  description: string;
  icon: string;
  coverPhotoEnabled: boolean;
  minimalistMode: boolean;
}

export default function ProfileCustomizationScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const { colors } = useTheme();

  const [coverPhotoEnabled, setCoverPhotoEnabled] = useState<boolean>(true);
  const [minimalistMode, setMinimalistMode] = useState<boolean>(false);
  const [profileColor, setProfileColor] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

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

  // The color used for preview tinting: profileColor if set, otherwise the app's primary
  const previewColor = profileColor || colors.primary;

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  useEffect(() => {
    if (mySettings) {
      setCoverPhotoEnabled(mySettings.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings.profileCustomization?.minimalistMode ?? false);
      setProfileColor(mySettings.profileCustomization?.profileColor ?? undefined);
    }
  }, [mySettings]);

  const handleStyleSelect = useCallback(async (style: StyleOption) => {
    setSaving(true);
    try {
      setCoverPhotoEnabled(style.coverPhotoEnabled);
      setMinimalistMode(style.minimalistMode);

      const result = await updateMySettings({
        profileCustomization: {
          coverPhotoEnabled: style.coverPhotoEnabled,
          minimalistMode: style.minimalistMode,
        },
      } as Record<string, unknown>);

      if (result) {
        await loadMySettings();
      }
    } catch (error) {
      console.error('Error updating profile customization:', error);
      setCoverPhotoEnabled(mySettings?.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings?.profileCustomization?.minimalistMode ?? false);
    } finally {
      setSaving(false);
    }
  }, [updateMySettings, loadMySettings, mySettings]);

  const handleColorSelect = useCallback(async (hex: string | null) => {
    setSaving(true);
    const previousColor = profileColor;
    setProfileColor(hex ?? undefined);
    try {
      const result = await updateMySettings({
        profileCustomization: {
          profileColor: hex,
        },
      } as Record<string, unknown>);

      if (result) {
        await loadMySettings();
      }
    } catch (error) {
      console.error('Error updating profile color:', error);
      setProfileColor(previousColor);
    } finally {
      setSaving(false);
    }
  }, [updateMySettings, loadMySettings, profileColor]);

  // Match profileColor hex to a preset name for selection state
  const selectedColorName: AppColorName | null = useMemo(() => {
    if (!profileColor) return null;
    return HEX_TO_APP_COLOR[profileColor] ?? HEX_TO_APP_COLOR[profileColor.toLowerCase()] ?? null;
  }, [profileColor]);

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
                  style={[
                    styles.styleCard,
                    {
                      backgroundColor: colors.card,
                      borderColor: isSelected ? colors.primary : colors.border,
                      borderWidth: isSelected ? 2 : 1,
                    },
                  ]}
                  onPress={() => handleStyleSelect(style)}
                  activeOpacity={0.7}
                >
                  {/* Static Preview */}
                  <View style={styles.previewContainer}>
                    {style.coverPhotoEnabled ? (
                      <View style={[styles.previewBanner, { backgroundColor: previewColor + '20' }]} />
                    ) : (
                      <View style={[styles.previewBanner, { backgroundColor: 'transparent', height: 0 }]} />
                    )}

                    <View style={[styles.previewContent, { backgroundColor: colors.background }]}>
                      <View style={[
                        styles.previewAvatar,
                        {
                          backgroundColor: colors.backgroundSecondary,
                          borderColor: colors.background,
                          marginTop: style.minimalistMode ? 8 : -20,
                        },
                      ]} />

                      <View style={styles.previewNameContainer}>
                        <View style={[styles.previewName, {
                          backgroundColor: colors.backgroundSecondary,
                          marginTop: style.minimalistMode ? 8 : 12,
                        }]} />
                        <View style={[styles.previewHandle, {
                          backgroundColor: colors.backgroundSecondary,
                          marginTop: 4,
                        }]} />
                      </View>

                      <View style={[styles.previewBio, { backgroundColor: colors.backgroundSecondary, marginTop: 8 }]} />
                      <View style={[styles.previewBio, { backgroundColor: colors.backgroundSecondary, marginTop: 4, width: '60%' }]} />
                    </View>
                  </View>

                  {/* Style Info */}
                  <View className="p-3">
                    <View className="flex-row items-center gap-1.5 mb-1">
                      <IconComponent
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
                    <View style={[styles.selectedIndicator, { backgroundColor: colors.primary }]}>
                      <IconComponent name="checkmark" size={14} color="#fff" />
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

          <View className="flex-row gap-3 flex-wrap">
            {/* Default (no color) option */}
            <Pressable
              onPress={() => handleColorSelect(null)}
              className="items-center gap-1"
            >
              <View
                className={cn(
                  'w-9 h-9 rounded-full border-2 overflow-hidden items-center justify-center',
                  selectedColorName === null ? 'border-foreground scale-110' : 'border-transparent',
                )}
                style={{ backgroundColor: colors.backgroundSecondary }}
              >
                <Icon name="ban-outline" size={16} color={colors.textTertiary} />
              </View>
              <Text
                className={cn(
                  'text-[10px]',
                  selectedColorName === null ? 'text-foreground font-medium' : 'text-muted-foreground',
                )}
              >
                {t('settings.profileCustomization.profileColorDefault', { defaultValue: 'Default' })}
              </Text>
            </Pressable>

            {APP_COLOR_NAMES.map((name) => {
              const preset = APP_COLOR_PRESETS[name];
              const isSelected = selectedColorName === name;
              return (
                <Pressable
                  key={name}
                  onPress={() => handleColorSelect(preset.hex)}
                  className="items-center gap-1"
                >
                  <View
                    className={cn(
                      'w-9 h-9 rounded-full border-2 overflow-hidden',
                      isSelected ? 'border-foreground scale-110' : 'border-transparent',
                    )}
                  >
                    <View style={{ backgroundColor: preset.hex, flex: 1 }} />
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

          <Text className="text-[13px] leading-[18px] text-muted-foreground">
            {t('settings.profileCustomization.profileColorHint', { defaultValue: 'Choose a color for your profile. Visitors will see this color when viewing your profile. Default uses each visitor\'s own color.' })}
          </Text>
        </View>

        <SettingsDivider />

        {/* Info Text */}
        <View className="flex-row items-start px-5 py-4 gap-2">
          <IconComponent name="information-circle-outline" size={16} color={colors.textTertiary} />
          <Text className="flex-1 text-[13px] leading-[18px] text-muted-foreground">
            {t('settings.profileCustomization.info')}
          </Text>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  styleCard: {
    flex: 1,
    minWidth: '47%',
    borderRadius: 12,
    overflow: 'hidden',
    position: 'relative',
  },
  previewContainer: {
    width: '100%',
    overflow: 'hidden',
  },
  previewBanner: {
    width: '100%',
    height: 60,
  },
  previewContent: {
    paddingHorizontal: 8,
    paddingBottom: 12,
    paddingTop: 4,
  },
  previewAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    alignSelf: 'flex-start',
  },
  previewNameContainer: {
    marginTop: 8,
  },
  previewName: {
    height: 12,
    width: '80%',
    borderRadius: 6,
  },
  previewHandle: {
    height: 10,
    width: '60%',
    borderRadius: 5,
  },
  previewBio: {
    height: 8,
    width: '100%',
    borderRadius: 4,
  },
  selectedIndicator: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
