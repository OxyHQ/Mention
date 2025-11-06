import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { alertDialog } from '@/utils/alerts';
import { updatePrivacySettingsCache } from '@/hooks/usePrivacySettings';

const IconComponent = Ionicons as any;

type VisibilityOption = 'public' | 'private' | 'followers_only';

export default function ProfileVisibilityScreen() {
    const { t } = useTranslation();
    const theme = useTheme();

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
            <ThemedView style={styles.container}>
                <Header
                    options={{
                        title: t('settings.privacy.privateProfile'),
                        leftComponents: [
                            <HeaderIconButton
                                key="back"
                                onPress={() => router.back()}
                            >
                                <BackArrowIcon size={20} color={theme.colors.text} />
                            </HeaderIconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
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
        <ThemedView style={styles.container}>
            <Header
                options={{
                    title: t('settings.privacy.privateProfile'),
                    leftComponents: [
                        <HeaderIconButton
                            key="back"
                            onPress={() => router.back()}
                        >
                            <BackArrowIcon size={20} color={theme.colors.text} />
                        </HeaderIconButton>,
                    ],
                }}
                hideBottomBorder={true}
                disableSticky={true}
            />

            <ScrollView 
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                {options.map((option, index) => {
                    const isSelected = profileVisibility === option.value;
                    const isLast = index === options.length - 1;

                    return (
                        <TouchableOpacity
                            key={option.value}
                            style={[
                                styles.optionItem,
                                index === 0 && styles.firstOptionItem,
                                isLast && styles.lastOptionItem,
                                { backgroundColor: theme.colors.card, borderColor: theme.colors.border }
                            ]}
                            onPress={() => !saving && handleSave(option.value)}
                            disabled={saving}
                        >
                            <View style={styles.optionContent}>
                                <View style={styles.optionHeader}>
                                    <View style={styles.optionLeft}>
                                        <IconComponent 
                                            name={option.icon} 
                                            size={20} 
                                            color={isSelected ? theme.colors.primary : theme.colors.textSecondary} 
                                        />
                                        <View style={styles.optionTextContainer}>
                                            <Text style={[styles.optionLabel, { color: theme.colors.text }]}>
                                                {option.label}
                                            </Text>
                                            <Text style={[styles.optionDescription, { color: theme.colors.textSecondary }]}>
                                                {option.description}
                                            </Text>
                                        </View>
                                    </View>
                                    {isSelected && (
                                        <IconComponent 
                                            name="checkmark-circle" 
                                            size={24} 
                                            color={theme.colors.primary} 
                                        />
                                    )}
                                </View>
                            </View>
                        </TouchableOpacity>
                    );
                })}

                {saving && (
                    <View style={styles.savingContainer}>
                        <ActivityIndicator size="small" color={theme.colors.primary} />
                        <Text style={[styles.savingText, { color: theme.colors.textSecondary }]}>
                            {t('common.saving')}
                        </Text>
                    </View>
                )}
            </ScrollView>
        </ThemedView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    scrollView: {
        flex: 1,
    },
    content: {
        paddingHorizontal: 16,
        paddingTop: 20,
        paddingBottom: 24,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    optionItem: {
        borderRadius: 16,
        borderWidth: 1,
        marginBottom: 12,
        paddingHorizontal: 16,
        paddingVertical: 18,
    },
    firstOptionItem: {
        marginTop: 0,
    },
    lastOptionItem: {
        marginBottom: 0,
    },
    optionContent: {
        flex: 1,
    },
    optionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    optionLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    optionTextContainer: {
        marginLeft: 12,
        flex: 1,
    },
    optionLabel: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 4,
    },
    optionDescription: {
        fontSize: 14,
        lineHeight: 20,
    },
    savingContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 16,
        gap: 8,
    },
    savingText: {
        fontSize: 14,
    },
});

