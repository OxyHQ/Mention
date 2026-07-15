import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxyhq/bloom/theme';
import { Icon } from '@/lib/icons';
import { useAppearanceStore } from '@/store/appearanceStore';
import { logger } from '@/lib/logger';

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

/**
 * Profile layout picker (default vs. minimalist) — extracted from the old
 * `settings/profile-customization.tsx`, unchanged in behavior. Self-contained:
 * reads/writes `useAppearanceStore` directly.
 */
export const ProfileStyleSection: React.FC = () => {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);

  const [coverPhotoEnabled, setCoverPhotoEnabled] = useState<boolean>(true);
  const [minimalistMode, setMinimalistMode] = useState<boolean>(false);

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
    if (mySettings) {
      setCoverPhotoEnabled(mySettings.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings.profileCustomization?.minimalistMode ?? false);
    }
  }, [mySettings]);

  const handleStyleSelect = useCallback(async (style: StyleOption) => {
    setCoverPhotoEnabled(style.coverPhotoEnabled);
    setMinimalistMode(style.minimalistMode);

    try {
      await updateMySettings({
        profileCustomization: {
          coverPhotoEnabled: style.coverPhotoEnabled,
          minimalistMode: style.minimalistMode,
        },
      });
    } catch (error) {
      logger.error('Error updating profile customization', { error });
      setCoverPhotoEnabled(mySettings?.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings?.profileCustomization?.minimalistMode ?? false);
    }
  }, [updateMySettings, mySettings]);

  return (
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
  );
};
