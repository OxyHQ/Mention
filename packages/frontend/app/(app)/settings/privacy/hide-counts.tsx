import React, { useState, useEffect } from 'react';
import { View, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { Toggle } from '@/components/Toggle';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { updatePrivacySettingsCache } from '@/hooks/usePrivacySettings';
import { createScopedLogger } from '@/lib/logger';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';

const hideCountsLogger = createScopedLogger('HideCounts');

export default function HideCountsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { isAuthenticated } = useAuth();
    const [hideLikeCounts, setHideLikeCounts] = useState(false);
    const [hideShareCounts, setHideShareCounts] = useState(false);
    const [hideReplyCounts, setHideReplyCounts] = useState(false);
    const [hideSaveCounts, setHideSaveCounts] = useState(false);
    const [loading, setLoading] = useState(true);

    const allHidden = hideLikeCounts && hideShareCounts && hideReplyCounts && hideSaveCounts;

    useEffect(() => {
        if (!isAuthenticated) {
            setLoading(false);
            return;
        }
        loadSettings();
    }, [isAuthenticated]);

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

            await updatePrivacySettingsCache(updatedPrivacy);
        } catch (error) {
            hideCountsLogger.error('Error updating setting', { error });
            if (field === 'hideLikeCounts') setHideLikeCounts(!value);
            if (field === 'hideShareCounts') setHideShareCounts(!value);
            if (field === 'hideReplyCounts') setHideReplyCounts(!value);
            if (field === 'hideSaveCounts') setHideSaveCounts(!value);
        }
    };

    const updateAllSettings = async (value: boolean) => {
        try {
            let currentPrivacy = {};
            try {
                const currentResponse = await authenticatedClient.get('/profile/settings/me');
                currentPrivacy = currentResponse.data?.privacy || {};
            } catch (e) {
                hideCountsLogger.debug('Could not load current privacy settings', { error: e });
            }

            const updatedPrivacy = {
                ...currentPrivacy,
                hideLikeCounts: value,
                hideShareCounts: value,
                hideReplyCounts: value,
                hideSaveCounts: value,
            };
            await authenticatedClient.put('/profile/settings', {
                privacy: updatedPrivacy,
            });

            setHideLikeCounts(value);
            setHideShareCounts(value);
            setHideReplyCounts(value);
            setHideSaveCounts(value);

            await updatePrivacySettingsCache(updatedPrivacy);
        } catch (error) {
            hideCountsLogger.error('Error updating all settings', { error });
        }
    };

    if (!isAuthenticated) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.hideAllCounts'),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
                />
                <OxyAuthPrompt
                    label={t('settings.privacy.hideCounts.signInRequired', { defaultValue: 'Sign in to hide engagement counts' })}
                    description={t('settings.privacy.hideCounts.signInRequiredDesc', { defaultValue: 'Hide likes, boosts, replies, and saves on your posts.' })}
                />
            </ThemedView>
        );
    }

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.hideAllCounts'),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
                />
                <View className="flex-1 justify-center items-center">
                    <Loading className="text-primary" size="large" />
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
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                }}
                hideBottomBorder
                disableSticky
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsListGroup>
                    <SettingsListItem
                        icon={<RowIcon name="eye-off-outline" />}
                        title={t('settings.privacy.hideAllCounts')}
                        description={t('settings.privacy.hideAllCountsDesc')}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={allHidden}
                                onValueChange={(value) => updateAllSettings(value)}
                            />
                        }
                    />
                </SettingsListGroup>

                <SettingsListGroup title={t('settings.privacy.individualSettings')}>
                    <SettingsListItem
                        icon={<RowIcon name="heart-outline" />}
                        title={t('settings.privacy.hideLikeCounts')}
                        description={t('settings.privacy.hideLikeCountsDesc')}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={hideLikeCounts}
                                onValueChange={(value) => {
                                    setHideLikeCounts(value);
                                    updateSetting('hideLikeCounts', value);
                                }}
                            />
                        }
                    />
                    <SettingsListItem
                        icon={<RowIcon name="repeat-outline" />}
                        title={t('settings.privacy.hideShareCounts')}
                        description={t('settings.privacy.hideShareCountsDesc')}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={hideShareCounts}
                                onValueChange={(value) => {
                                    setHideShareCounts(value);
                                    updateSetting('hideShareCounts', value);
                                }}
                            />
                        }
                    />
                    <SettingsListItem
                        icon={<RowIcon name="chatbubble-outline" />}
                        title={t('settings.privacy.hideReplyCounts')}
                        description={t('settings.privacy.hideReplyCountsDesc')}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={hideReplyCounts}
                                onValueChange={(value) => {
                                    setHideReplyCounts(value);
                                    updateSetting('hideReplyCounts', value);
                                }}
                            />
                        }
                    />
                    <SettingsListItem
                        icon={<RowIcon name="bookmark-outline" />}
                        title={t('settings.privacy.hideSaveCounts')}
                        description={t('settings.privacy.hideSaveCountsDesc')}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={hideSaveCounts}
                                onValueChange={(value) => {
                                    setHideSaveCounts(value);
                                    updateSetting('hideSaveCounts', value);
                                }}
                            />
                        }
                    />
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}
