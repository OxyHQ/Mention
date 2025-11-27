import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { Toggle } from '@/components/Toggle';
import { updatePrivacySettingsCache } from '@/hooks/usePrivacySettings';

export default function HideCountsScreen() {
    const { t } = useTranslation();
    const theme = useTheme();

    const [hideLikeCounts, setHideLikeCounts] = useState(false);
    const [hideShareCounts, setHideShareCounts] = useState(false);
    const [hideReplyCounts, setHideReplyCounts] = useState(false);
    const [hideSaveCounts, setHideSaveCounts] = useState(false);
    const [loading, setLoading] = useState(true);

    // Calculate if all counts are hidden
    const allHidden = hideLikeCounts && hideShareCounts && hideReplyCounts && hideSaveCounts;

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setHideLikeCounts(settings.privacy?.hideLikeCounts || false);
            setHideShareCounts(settings.privacy?.hideShareCounts || false);
            setHideReplyCounts(settings.privacy?.hideReplyCounts || false);
            setHideSaveCounts(settings.privacy?.hideSaveCounts || false);
            setLoading(false);
        } catch (error) {
            console.error('Error loading settings:', error);
            setLoading(false);
        }
    };

    const updateSetting = async (field: 'hideLikeCounts' | 'hideShareCounts' | 'hideReplyCounts' | 'hideSaveCounts', value: boolean) => {
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
                [field]: value
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
        } catch (error) {
            console.error('Error updating setting:', error);
        }
    };

    const updateAllSettings = async (value: boolean) => {
        try {
            // Load current settings first to preserve other privacy settings
            let currentPrivacy = {};
            try {
                const currentResponse = await authenticatedClient.get('/profile/settings/me');
                currentPrivacy = currentResponse.data?.privacy || {};
            } catch (e) {
                console.debug('Could not load current privacy settings:', e);
            }

            // Update all count settings at once
            const updatedPrivacy = {
                ...currentPrivacy,
                hideLikeCounts: value,
                hideShareCounts: value,
                hideReplyCounts: value,
                hideSaveCounts: value
            };
            await authenticatedClient.put('/profile/settings', {
                privacy: updatedPrivacy
            });

            // Update local state
            setHideLikeCounts(value);
            setHideShareCounts(value);
            setHideReplyCounts(value);
            setHideSaveCounts(value);
            
            // Update cache immediately
            try {
                const currentResponse = await authenticatedClient.get('/profile/settings/me');
                if (currentResponse.data?.privacy) {
                    await updatePrivacySettingsCache(currentResponse.data.privacy);
                }
            } catch (e) {
                console.debug('Failed to update privacy settings cache:', e);
            }
        } catch (error) {
            console.error('Error updating all settings:', error);
        }
    };

    if (loading) {
        return (
            <ThemedView style={styles.container}>
                <Header
                    options={{
                        title: t('settings.privacy.hideAllCounts'),
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
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                </View>
            </ThemedView>
        );
    }

    return (
        <ThemedView style={styles.container}>
            <Header
                options={{
                    title: t('settings.privacy.hideAllCounts'),
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

            <ScrollView 
                style={styles.scrollView}
                contentContainerStyle={styles.content}
                showsVerticalScrollIndicator={false}
            >
                {/* Main toggle card - highlighted */}
                <View style={[styles.mainCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    <View style={styles.mainCardContent}>
                        <View style={styles.mainCardInfo}>
                            <Text style={[styles.mainCardLabel, { color: theme.colors.text }]}>
                                {t('settings.privacy.hideAllCounts')}
                            </Text>
                            <Text style={[styles.mainCardDescription, { color: theme.colors.textSecondary }]}>
                                {t('settings.privacy.hideAllCountsDesc')}
                            </Text>
                        </View>
                        <Toggle
                            value={allHidden}
                            onValueChange={(value) => {
                                updateAllSettings(value);
                            }}
                        />
                    </View>
                </View>

                {/* Section header */}
                <View style={styles.sectionHeader}>
                    <Text style={[styles.sectionHeaderText, { color: theme.colors.textSecondary }]}>
                        {t('settings.privacy.individualSettings')}
                    </Text>
                </View>

                {/* Individual settings card */}
                <View style={[styles.settingsCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    <View style={[styles.settingItem, styles.firstSettingItem]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                {t('settings.privacy.hideLikeCounts')}
                            </Text>
                            <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                {t('settings.privacy.hideLikeCountsDesc')}
                            </Text>
                        </View>
                        <Toggle
                            value={hideLikeCounts}
                            onValueChange={(value) => {
                                setHideLikeCounts(value);
                                updateSetting('hideLikeCounts', value);
                            }}
                        />
                    </View>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    <View style={styles.settingItem}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                {t('settings.privacy.hideShareCounts')}
                            </Text>
                            <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                {t('settings.privacy.hideShareCountsDesc')}
                            </Text>
                        </View>
                        <Toggle
                            value={hideShareCounts}
                            onValueChange={(value) => {
                                setHideShareCounts(value);
                                updateSetting('hideShareCounts', value);
                            }}
                        />
                    </View>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    <View style={styles.settingItem}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                {t('settings.privacy.hideReplyCounts')}
                            </Text>
                            <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                {t('settings.privacy.hideReplyCountsDesc')}
                            </Text>
                        </View>
                        <Toggle
                            value={hideReplyCounts}
                            onValueChange={(value) => {
                                setHideReplyCounts(value);
                                updateSetting('hideReplyCounts', value);
                            }}
                        />
                    </View>

                    <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

                    <View style={[styles.settingItem, styles.lastSettingItem]}>
                        <View style={styles.settingInfo}>
                            <Text style={[styles.settingLabel, { color: theme.colors.text }]}>
                                {t('settings.privacy.hideSaveCounts')}
                            </Text>
                            <Text style={[styles.settingDescription, { color: theme.colors.textSecondary }]}>
                                {t('settings.privacy.hideSaveCountsDesc')}
                            </Text>
                        </View>
                        <Toggle
                            value={hideSaveCounts}
                            onValueChange={(value) => {
                                setHideSaveCounts(value);
                                updateSetting('hideSaveCounts', value);
                            }}
                        />
                    </View>
                </View>
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
    mainCard: {
        borderRadius: 16,
        borderWidth: 1,
        marginBottom: 24,
        padding: 20,
    },
    mainCardContent: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    mainCardInfo: {
        flex: 1,
        marginRight: 16,
    },
    mainCardLabel: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 6,
    },
    mainCardDescription: {
        fontSize: 14,
        lineHeight: 20,
    },
    sectionHeader: {
        marginBottom: 12,
        paddingHorizontal: 4,
    },
    sectionHeaderText: {
        fontSize: 13,
        fontWeight: '600',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
    },
    settingsCard: {
        borderRadius: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    settingItem: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 16,
    },
    firstSettingItem: {
        paddingTop: 18,
    },
    lastSettingItem: {
        paddingBottom: 18,
    },
    divider: {
        height: 1,
        marginHorizontal: 16,
    },
    settingInfo: {
        flex: 1,
        marginRight: 16,
    },
    settingLabel: {
        fontSize: 16,
        fontWeight: '500',
        marginBottom: 4,
    },
    settingDescription: {
        fontSize: 14,
        lineHeight: 20,
    },
});

