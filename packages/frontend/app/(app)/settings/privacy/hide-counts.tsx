import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { Toggle } from '@/components/Toggle';
import { updatePrivacySettingsCache } from '@/hooks/usePrivacySettings';
import { createScopedLogger } from '@/lib/logger';

const hideCountsLogger = createScopedLogger('HideCounts');

export default function HideCountsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
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
            hideCountsLogger.error('Error loading settings', { error });
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
                hideCountsLogger.debug('Could not load current privacy settings', { error: e });
            }

            const updatedPrivacy = {
                ...currentPrivacy,
                [field]: value,
            };
            await authenticatedClient.put('/profile/settings', {
                privacy: updatedPrivacy,
            });

            // Update cache from local state to avoid extra GET
            await updatePrivacySettingsCache(updatedPrivacy);
        } catch (error) {
            hideCountsLogger.error('Error updating setting', { error });
            // Revert on failure
            if (field === 'hideLikeCounts') setHideLikeCounts(!value);
            if (field === 'hideShareCounts') setHideShareCounts(!value);
            if (field === 'hideReplyCounts') setHideReplyCounts(!value);
            if (field === 'hideSaveCounts') setHideSaveCounts(!value);
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
                hideCountsLogger.debug('Could not load current privacy settings', { error: e });
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
                privacy: updatedPrivacy,
            });

            // Update local state
            setHideLikeCounts(value);
            setHideShareCounts(value);
            setHideReplyCounts(value);
            setHideSaveCounts(value);

            // Update cache from local state to avoid extra GET
            await updatePrivacySettingsCache(updatedPrivacy);
        } catch (error) {
            hideCountsLogger.error('Error updating all settings', { error });
        }
    };

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.hideAllCounts'),
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
                <View className="flex-1 justify-center items-center">
                    <Loading size="large" />
                </View>
            </ThemedView>
        );
    }

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.hideAllCounts'),
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

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-4 pt-5 pb-6"
                showsVerticalScrollIndicator={false}
            >
                {/* Main toggle card - highlighted */}
                <View className="rounded-2xl border border-border bg-card mb-6 p-5">
                    <View className="flex-row items-center justify-between">
                        <View className="flex-1 mr-4">
                            <Text className="text-lg font-semibold mb-1.5 text-foreground">
                                {t('settings.privacy.hideAllCounts')}
                            </Text>
                            <Text className="text-sm leading-5 text-muted-foreground">
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
                <View className="mb-3 px-1">
                    <Text className="text-[13px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('settings.privacy.individualSettings')}
                    </Text>
                </View>

                {/* Individual settings card */}
                <View className="rounded-2xl border border-border bg-card overflow-hidden">
                    <View className="flex-row items-center justify-between px-4 pt-[18px] py-4">
                        <View className="flex-1 mr-4">
                            <Text className="text-base font-medium mb-1 text-foreground">
                                {t('settings.privacy.hideLikeCounts')}
                            </Text>
                            <Text className="text-sm leading-5 text-muted-foreground">
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

                    <View className="h-px mx-4 bg-border" />

                    <View className="flex-row items-center justify-between px-4 py-4">
                        <View className="flex-1 mr-4">
                            <Text className="text-base font-medium mb-1 text-foreground">
                                {t('settings.privacy.hideShareCounts')}
                            </Text>
                            <Text className="text-sm leading-5 text-muted-foreground">
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

                    <View className="h-px mx-4 bg-border" />

                    <View className="flex-row items-center justify-between px-4 py-4">
                        <View className="flex-1 mr-4">
                            <Text className="text-base font-medium mb-1 text-foreground">
                                {t('settings.privacy.hideReplyCounts')}
                            </Text>
                            <Text className="text-sm leading-5 text-muted-foreground">
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

                    <View className="h-px mx-4 bg-border" />

                    <View className="flex-row items-center justify-between px-4 py-4 pb-[18px]">
                        <View className="flex-1 mr-4">
                            <Text className="text-base font-medium mb-1 text-foreground">
                                {t('settings.privacy.hideSaveCounts')}
                            </Text>
                            <Text className="text-sm leading-5 text-muted-foreground">
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
