import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Ionicons } from '@expo/vector-icons';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAppearanceStore } from '@/store/appearanceStore';
import { authenticatedClient } from '@/utils/api';
import { interests as allInterests, useInterestsDisplayNames, type Interest } from '@/lib/interests';
import { cn } from '@/lib/utils';

// Simple debounce function
function debounce<T extends (...args: any[]) => any>(func: T, wait: number): T {
  let timeout: NodeJS.Timeout | null = null;
  return ((...args: any[]) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  }) as T;
}

const IconComponent = Ionicons as React.ComponentType<React.ComponentProps<typeof Ionicons>>;

export default function InterestsSettingsScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { colors } = useTheme();
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
  const [loading, setLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [interests, setInterests] = useState<string[]>([]);
  const interestsDisplayNames = useInterestsDisplayNames();

  const preselectedInterests = useMemo(
    () => mySettings?.interests?.tags || [],
    [mySettings?.interests?.tags]
  );

  useEffect(() => {
    loadMySettings();
  }, [loadMySettings]);

  useEffect(() => {
    if (mySettings) {
      setInterests(preselectedInterests);
      setLoading(false);
    }
  }, [mySettings, preselectedInterests]);

  const saveInterests = useMemo(() => {
    return debounce(async (newInterests: string[]) => {
      const noEdits =
        newInterests.length === preselectedInterests.length &&
        preselectedInterests.every(pre => {
          return newInterests.find(int => int === pre);
        });

      if (noEdits) return;

      setIsSaving(true);

      try {
        await authenticatedClient.put('/profile/settings', {
          interests: {
            tags: newInterests,
          },
        });

        // Reload settings to get updated data
        await loadMySettings();

        // Show success message (you can add a toast here if available)
        console.log('Interests saved successfully');
      } catch (error) {
        console.error('Failed to save interests:', error);
        // Show error message (you can add a toast here if available)
      } finally {
        setIsSaving(false);
      }
    }, 1500);
  }, [preselectedInterests, loadMySettings]);

  const onChangeInterests = useCallback((newInterests: string[]) => {
    setInterests(newInterests);
    saveInterests(newInterests);
  }, [saveInterests]);

  const toggleInterest = useCallback((interest: Interest) => {
    const newInterests = interests.includes(interest)
      ? interests.filter(i => i !== interest)
      : [...interests, interest];
    onChangeInterests(newInterests);
  }, [interests, onChangeInterests]);

  if (loading) {
    return (
      <ThemedView className="flex-1">
        <Header
          options={{
            title: t('settings.interests.title', { defaultValue: 'Your interests' }),
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
        <View className="flex-1 justify-center items-center bg-background">
          <Loading size="large" />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.interests.title', { defaultValue: 'Your interests' }),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => safeBack()}
            >
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: isSaving ? [
            <View key="loading" className="p-1 mr-2">
              <Loading variant="inline" size="small" style={{ flex: undefined }} />
            </View>,
          ] : [],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="pb-5"
      >
        <View className="p-4">
          <Text className="text-sm leading-5 mb-6 text-muted-foreground">
            {t('settings.interests.description', {
              defaultValue: 'Your selected interests help us serve you content you care about.',
            })}
          </Text>

          {interests.length === 0 && (
            <View className="flex-row items-center p-3 rounded-lg border border-border bg-card mb-6 gap-2">
              <IconComponent name="information-circle-outline" size={20} color={colors.primary} />
              <Text className="text-sm flex-1 text-foreground">
                {t('settings.interests.tip', { defaultValue: 'We recommend selecting at least two interests.' })}
              </Text>
            </View>
          )}

          <View className="flex-row flex-wrap gap-2">
            {allInterests.map(interest => {
              const name = interestsDisplayNames[interest];
              if (!name) return null;

              const isSelected = interests.includes(interest);

              return (
                <InterestButton
                  key={interest}
                  interest={interest}
                  label={name}
                  isSelected={isSelected}
                  onPress={() => toggleInterest(interest)}
                />
              );
            })}
          </View>
        </View>
      </ScrollView>
    </ThemedView>
  );
}

interface InterestButtonProps {
  interest: Interest;
  label: string;
  isSelected: boolean;
  onPress: () => void;
}

function InterestButton({ label, isSelected, onPress }: InterestButtonProps) {
  return (
    <TouchableOpacity
      className={cn(
        "px-4 py-2.5 rounded-full border",
        isSelected
          ? "bg-primary border-primary"
          : "bg-secondary border-border"
      )}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text
        className={cn(
          "text-sm",
          isSelected ? "text-primary-foreground font-semibold" : "text-foreground font-medium"
        )}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}
