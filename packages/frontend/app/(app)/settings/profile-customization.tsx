import React, { useEffect, useState, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Ionicons } from '@expo/vector-icons';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@oxyhq/bloom/theme';
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

  const pulseAnim = useRef(new Animated.Value(0.5)).current;

  // Memoize style options to update when translations change
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

  // Determine current style based on settings
  const currentStyle: ProfileStyle = useMemo(() => {
    // Match the style based on both settings
    if (minimalistMode && !coverPhotoEnabled) {
      return 'minimalist';
    }
    return 'default';
  }, [minimalistMode, coverPhotoEnabled]);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulseAnim, { toValue: 0.5, duration: 1000, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [pulseAnim]);

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  useEffect(() => {
    if (mySettings) {
      setCoverPhotoEnabled(mySettings.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings.profileCustomization?.minimalistMode ?? false);
    }
  }, [mySettings]);

  const handleStyleSelect = async (style: StyleOption) => {
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
    }
  };

  const Shimmer = ({ style: shimmerStyle }: { style?: any }) => (
    <Animated.View
      style={[
        {
          backgroundColor: colors.backgroundSecondary,
          opacity: pulseAnim,
        },
        shimmerStyle,
      ]}
    />
  );

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.profileCustomization.title'),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => safeBack()}
            >
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView contentContainerClassName="p-4">
        {/* Profile Style Selector */}
        <Text className="text-lg font-bold mb-4 text-foreground">
          {t('settings.profileCustomization.profileStyle')}
        </Text>
        <View className="flex-row flex-wrap gap-3">
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
                {/* Preview */}
                <View style={styles.previewContainer}>
                  {/* Banner/Header area */}
                  {style.coverPhotoEnabled ? (
                    <View style={[styles.previewBanner, { backgroundColor: colors.primary + '30' }]}>
                      <Shimmer style={StyleSheet.absoluteFillObject} />
                    </View>
                  ) : (
                    <View style={[styles.previewBanner, { backgroundColor: 'transparent', height: 0 }]} />
                  )}

                  {/* Content area */}
                  <View style={[styles.previewContent, { backgroundColor: colors.background }]}>
                    {/* Avatar */}
                    <View style={[
                      styles.previewAvatar,
                      {
                        backgroundColor: colors.backgroundSecondary,
                        borderColor: colors.background,
                        marginTop: style.minimalistMode ? 8 : -20,
                      },
                    ]}>
                      <Shimmer style={styles.previewAvatarInner} />
                    </View>

                    {/* Name */}
                    <View style={styles.previewNameContainer}>
                      <Shimmer style={[styles.previewName, { marginTop: style.minimalistMode ? 8 : 12 }]} />
                      <Shimmer style={[styles.previewHandle, { marginTop: 4 }]} />
                    </View>

                    {/* Bio placeholder */}
                    <Shimmer style={[styles.previewBio, { marginTop: 8 }]} />
                    <Shimmer style={[styles.previewBio, { marginTop: 4, width: '60%' }]} />
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

        {/* Info Text */}
        <View className="flex-row items-start mt-6 p-3 gap-2">
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
  // Style cards need pixel-precise layout for the preview
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
    position: 'relative',
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
    overflow: 'hidden',
    position: 'relative',
  },
  previewAvatarInner: {
    width: '100%',
    height: '100%',
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
    marginTop: 4,
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
