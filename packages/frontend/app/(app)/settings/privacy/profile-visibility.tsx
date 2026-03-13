import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { alertDialog } from '@/utils/alerts';
import { updatePrivacySettingsCache } from '@/hooks/usePrivacySettings';
import { cn } from '@/lib/utils';

const IconComponent = Ionicons as any;

type VisibilityOption = 'public' | 'private' | 'followers_only';

export default function ProfileVisibilityScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();

    const [profileVisibility, setProfileVisibility] = useState<VisibilityOption>('public');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setProfileVisibility(settings.privacy?.profileVisibility || 'public');
            setLoading(false);
        } catch (error) {
            console.error('Error loading settings:', error);
            setLoading(false);
        }
    };

    const handleSave = async (newVisibility: VisibilityOption) => {
        if (newVisibility === profileVisibility) {
            router.back();
            return;
        }

        setSaving(true);
        try {
            // Load current settings first to preserve other privacy settings
            let currentPrivacy = {};
            try {
                const currentResponse = await authenticatedClient.get('/profile/settings/me');
                currentPrivacy = currentResponse.data?.privacy || {};
            } catch (e) {
                // If we can't load current settings, start fresh
                console.debug('Could not load current privacy settings:', e);
            }

            // Update with merged settings
            const updatedPrivacy = {
                ...currentPrivacy,
                profileVisibility: newVisibility
            };
            await authenticatedClient.put('/profile/settings', {
                privacy: updatedPrivacy
            });

            // Update cache immediately
            try {
                const currentResponse = await authenticatedClient.get('/profile/settings/me');
                if (currentResponse.data?.privacy) {
                    await updatePrivacySettingsCache(currentResponse.data.privacy);
                }
            } catch (e) {
                console.debug('Failed to update privacy settings cache:', e);
            }

            setProfileVisibility(newVisibility);
            await alertDialog({
                title: t('common.success'),
                message: t('settings.privacy.profileVisibilityUpdated')
            });
            // Small delay to ensure backend has processed the update
            setTimeout(() => {
                router.back();
            }, 300);
        } catch (error: any) {
            console.error('Error updating profile visibility:', error);
            await alertDialog({
                title: t('common.error'),
                message: error?.response?.data?.error || t('settings.privacy.updateError')
            });
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.privateProfile'),
                        leftComponents: [
                            <IconButton variant="icon"
                                key="back"
                                onPress={() => router.back()}
                            >
                                <BackArrowIcon size={20} color={colors.text} />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />
                <View className="flex-1 justify-center items-center">
                    <Loading size="large" />
                </View>
            </ThemedView>
        );
    }

    const options: { value: VisibilityOption; label: string; description: string; icon: string }[] = [
        {
            value: 'public',
            label: t('settings.privacy.public'),
            description: t('settings.privacy.publicDescription'),
            icon: 'globe'
        },
        {
            value: 'followers_only',
            label: t('settings.privacy.followersOnly'),
            description: t('settings.privacy.followersOnlyDescription'),
            icon: 'people'
        },
        {
            value: 'private',
            label: t('settings.privacy.private'),
            description: t('settings.privacy.privateDescription'),
            icon: 'lock-closed'
        }
    ];

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.privateProfile'),
                    leftComponents: [
                        <IconButton variant="icon"
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={colors.text} />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-4 pt-5 pb-6"
                showsVerticalScrollIndicator={false}
            >
                {options.map((option, index) => {
                    const isSelected = profileVisibility === option.value;
                    const isLast = index === options.length - 1;

                    return (
                        <TouchableOpacity
                            key={option.value}
                            className={cn(
                                "rounded-2xl border border-border bg-card mb-3 px-4 py-[18px]",
                                index === 0 && "mt-0",
                                isLast && "mb-0"
                            )}
                            onPress={() => !saving && handleSave(option.value)}
                            disabled={saving}
                        >
                            <View className="flex-1">
                                <View className="flex-row items-center justify-between">
                                    <View className="flex-row items-center flex-1">
                                        <IconComponent
                                            name={option.icon}
                                            size={20}
                                            color={isSelected ? colors.primary : colors.textSecondary}
                                        />
                                        <View className="ml-3 flex-1">
                                            <Text className="text-base font-semibold mb-1 text-foreground">
                                                {option.label}
                                            </Text>
                                            <Text className="text-sm leading-5 text-muted-foreground">
                                                {option.description}
                                            </Text>
                                        </View>
                                    </View>
                                    {isSelected && (
                                        <IconComponent
                                            name="checkmark-circle"
                                            size={24}
                                            color={colors.primary}
                                        />
                                    )}
                                </View>
                            </View>
                        </TouchableOpacity>
                    );
                })}

                {saving && (
                    <View className="flex-row items-center justify-center py-4 gap-2">
                        <Loading variant="inline" size="small" style={{ flex: undefined }} />
                        <Text className="text-sm text-muted-foreground">
                            {t('common.saving')}
                        </Text>
                    </View>
                )}
            </ScrollView>
        </ThemedView>
    );
}
