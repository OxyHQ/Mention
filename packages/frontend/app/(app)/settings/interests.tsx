import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { useAppearanceStore } from '@/store/appearanceStore';
import { authenticatedClient } from '@/utils/api';
import { interests as allInterests, useInterestsDisplayNames, type Interest } from '@/lib/interests';

// Simple debounce function
function debounce<T extends (...args: any[]) => any>(func: T, wait: number): T {
  let timeout: NodeJS.Timeout | null = null;
  return ((...args: any[]) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  }) as T;
}

const IconComponent = Ionicons as any;

export default function InterestsSettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
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
      <ThemedView style={styles.container}>
        <Header
          options={{
            title: t('settings.interests.title', { defaultValue: 'Your interests' }),
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
        <View style={[styles.loadingContainer, { backgroundColor: theme.colors.background }]}>
          <Loading size="large" />
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.container}>
      <Header
        options={{
          title: t('settings.interests.title', { defaultValue: 'Your interests' }),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
          rightComponents: isSaving ? [
            <View key="loading" style={styles.savingIndicator}>
              <Loading variant="inline" size="small" style={{ flex: undefined }} />
            </View>,
          ] : [],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={styles.content}>
          <Text style={[styles.description, { color: theme.colors.textSecondary }]}>
            {t('settings.interests.description', {
              defaultValue: 'Your selected interests help us serve you content you care about.',
            })}
          </Text>

          {interests.length === 0 && (
            <View style={[styles.tipContainer, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
              <IconComponent name="information-circle-outline" size={20} color={theme.colors.primary} />
              <Text style={[styles.tipText, { color: theme.colors.text }]}>
                {t('settings.interests.tip', { defaultValue: 'We recommend selecting at least two interests.' })}
              </Text>
            </View>
          )}

          <View style={styles.interestsContainer}>
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
  const theme = useTheme();

  return (
    <TouchableOpacity
      style={[
        styles.interestButton,
        {
          backgroundColor: isSelected ? theme.colors.primary : theme.colors.backgroundSecondary,
          borderColor: isSelected ? theme.colors.primary : theme.colors.border,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <Text
        style={[
          styles.interestButtonText,
          {
            color: isSelected ? theme.colors.card : theme.colors.text,
            fontWeight: isSelected ? '600' : '500',
          },
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 20,
  },
  content: {
    padding: 16,
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 24,
  },
  tipContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 24,
    gap: 8,
  },
  tipText: {
    fontSize: 14,
    flex: 1,
  },
  interestsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  interestButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  interestButtonText: {
    fontSize: 14,
  },
  savingIndicator: {
    padding: 4,
    marginRight: 8,
  },
});

