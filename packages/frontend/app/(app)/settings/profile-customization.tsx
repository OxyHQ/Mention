import React, { useEffect, useState, useRef, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated, Platform } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Toggle } from '@/components/Toggle';
import { FONT_FAMILIES } from '@/styles/typography';

const IconComponent = Ionicons as any;

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
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loading = useAppearanceStore((state) => state.loading);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const updateMySettings = useAppearanceStore((state) => state.updateMySettings);
  const theme = useTheme();

  const [coverPhotoEnabled, setCoverPhotoEnabled] = useState<boolean>(true);
  const [minimalistMode, setMinimalistMode] = useState<boolean>(false);
  const [saving, setSaving] = useState(false);
  
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

  const handleSave = async () => {
    setSaving(true);
    await updateMySettings({
      profileCustomization: {
        coverPhotoEnabled,
        minimalistMode,
      },
    } as any);
    setSaving(false);
  };

  const handleCoverPhotoToggle = async (value: boolean) => {
    try {
      const newCoverPhotoEnabled = value;
      // If disabling cover photo and minimalist mode is off, enable minimalist mode
      // If enabling cover photo, disable minimalist mode
      const newMinimalistMode = !newCoverPhotoEnabled;
      
      // Update state immediately for instant UI feedback
      setCoverPhotoEnabled(newCoverPhotoEnabled);
      setMinimalistMode(newMinimalistMode);
      
      // Save to backend
      const result = await updateMySettings({
        profileCustomization: {
          coverPhotoEnabled: newCoverPhotoEnabled,
          minimalistMode: newMinimalistMode,
        },
      } as any);
      
      // Reload settings to ensure sync
      if (result) {
        await loadMySettings();
      }
    } catch (error) {
      console.error('Error updating cover photo setting:', error);
      // Revert state on error
      setCoverPhotoEnabled(mySettings?.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings?.profileCustomization?.minimalistMode ?? false);
    }
  };

  const handleMinimalistModeToggle = async (value: boolean) => {
    try {
      const newMinimalistMode = value;
      // If enabling minimalist mode, disable cover photo
      // If disabling minimalist mode, enable cover photo
      const newCoverPhotoEnabled = !newMinimalistMode;
      
      // Update state immediately for instant UI feedback
      setMinimalistMode(newMinimalistMode);
      setCoverPhotoEnabled(newCoverPhotoEnabled);
      
      // Save to backend
      const result = await updateMySettings({
        profileCustomization: {
          coverPhotoEnabled: newCoverPhotoEnabled,
          minimalistMode: newMinimalistMode,
        },
      } as any);
      
      // Reload settings to ensure sync
      if (result) {
        await loadMySettings();
      }
    } catch (error) {
      console.error('Error updating minimalist mode setting:', error);
      // Revert state on error
      setCoverPhotoEnabled(mySettings?.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings?.profileCustomization?.minimalistMode ?? false);
    }
  };

  const handleStyleSelect = async (style: StyleOption) => {
    try {
      // Update state immediately for instant UI feedback
      setCoverPhotoEnabled(style.coverPhotoEnabled);
      setMinimalistMode(style.minimalistMode);
      
      // Save to backend
      const result = await updateMySettings({
        profileCustomization: {
          coverPhotoEnabled: style.coverPhotoEnabled,
          minimalistMode: style.minimalistMode,
        },
      } as any);
      
      // Reload settings to ensure sync
      if (result) {
        await loadMySettings();
      }
    } catch (error) {
      console.error('Error updating profile customization:', error);
      // Revert state on error
      setCoverPhotoEnabled(mySettings?.profileCustomization?.coverPhotoEnabled ?? true);
      setMinimalistMode(mySettings?.profileCustomization?.minimalistMode ?? false);
    }
  };

  const Shimmer = ({ style: shimmerStyle }: { style?: any }) => (
    <Animated.View 
      style={[
        {
          backgroundColor: theme.colors.backgroundSecondary,
          opacity: pulseAnim,
        },
        shimmerStyle,
      ]} 
    />
  );

  return (
    <ThemedView style={styles.container}>
      <Header 
        options={{ 
          title: t('settings.profileCustomization.title'), 
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
        }} 
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView contentContainerStyle={styles.content}>
        {/* Profile Style Selector */}
        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
          {t('settings.profileCustomization.profileStyle')}
        </Text>
        <View style={styles.styleGrid}>
          {styleOptions.map((style) => {
            const isSelected = currentStyle === style.id;
            return (
              <TouchableOpacity
                key={style.id}
                style={[
                  styles.styleCard,
                  {
                    backgroundColor: theme.colors.card,
                    borderColor: isSelected ? theme.colors.primary : theme.colors.border,
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
                    <View style={[styles.previewBanner, { backgroundColor: theme.colors.primary + '30' }]}>
                      <Shimmer style={StyleSheet.absoluteFillObject} />
                    </View>
                  ) : (
                    <View style={[styles.previewBanner, { backgroundColor: 'transparent', height: 0 }]} />
                  )}
                  
                  {/* Content area */}
                  <View style={[styles.previewContent, { backgroundColor: theme.colors.background }]}>
                    {/* Avatar */}
                    <View style={[
                      styles.previewAvatar,
                      {
                        backgroundColor: theme.colors.backgroundSecondary,
                        borderColor: theme.colors.background,
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
                <View style={styles.styleInfo}>
                  <View style={styles.styleHeader}>
                    <IconComponent 
                      name={style.icon} 
                      size={18} 
                      color={isSelected ? theme.colors.primary : theme.colors.textSecondary} 
                    />
                    <Text style={[
                      styles.styleName,
                      { color: isSelected ? theme.colors.primary : theme.colors.text },
                    ]}>
                      {style.name}
                    </Text>
                  </View>
                  <Text style={[styles.styleDescription, { color: theme.colors.textSecondary }]}>
                    {style.description}
                  </Text>
                </View>

                {/* Selected indicator */}
                {isSelected && (
                  <View style={[styles.selectedIndicator, { backgroundColor: theme.colors.primary }]}>
                    <IconComponent name="checkmark" size={14} color="#fff" />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Advanced Options */}
        <Text style={[styles.sectionTitle, { color: theme.colors.text, marginTop: 32 }]}>
          {t('settings.profileCustomization.advancedOptions')}
        </Text>

        {/* Cover Photo Toggle */}
        <View style={[styles.settingCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <View style={styles.settingIcon}>
                <IconComponent name="image-outline" size={20} color={theme.colors.textSecondary} />
              </View>
              <View style={styles.settingTextContainer}>
                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                  {t('settings.profileCustomization.coverPhoto')}
                </Text>
                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                  {t('settings.profileCustomization.coverPhotoDesc')}
                </Text>
              </View>
            </View>
            <Toggle
              value={coverPhotoEnabled}
              onValueChange={handleCoverPhotoToggle}
            />
          </View>
        </View>

        {/* Minimalist Mode Toggle */}
        <View style={[styles.settingCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, marginTop: 16 }]}>
          <View style={styles.settingRow}>
            <View style={styles.settingInfo}>
              <View style={styles.settingIcon}>
                <IconComponent name="remove-outline" size={20} color={theme.colors.textSecondary} />
              </View>
              <View style={styles.settingTextContainer}>
                <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                  {t('settings.profileCustomization.minimalistMode')}
                </Text>
                <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                  {t('settings.profileCustomization.minimalistModeDesc')}
                </Text>
              </View>
            </View>
            <Toggle
              value={minimalistMode}
              onValueChange={handleMinimalistModeToggle}
            />
          </View>
        </View>

        {/* Info Text */}
        <View style={styles.infoContainer}>
          <IconComponent name="information-circle-outline" size={16} color={theme.colors.textTertiary} />
          <Text style={[styles.infoText, { color: theme.colors.textSecondary }]}>
            {t('settings.profileCustomization.info')}
          </Text>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { 
    flex: 1 
  },
  content: { 
    padding: 16 
  },
  settingCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  settingInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 16,
  },
  settingIcon: {
    marginRight: 12,
  },
  settingTextContainer: {
    flex: 1,
  },
  settingLabel: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
    fontFamily: FONT_FAMILIES.primary,
  },
  settingDescription: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: FONT_FAMILIES.primary,
  },
  infoContainer: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 24,
    padding: 12,
    gap: 8,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: FONT_FAMILIES.primary,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
    fontFamily: FONT_FAMILIES.primary,
  },
  styleGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
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
  styleInfo: {
    padding: 12,
  },
  styleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  styleName: {
    fontSize: 14,
    fontWeight: '600',
    fontFamily: FONT_FAMILIES.primary,
  },
  styleDescription: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: FONT_FAMILIES.primary,
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

