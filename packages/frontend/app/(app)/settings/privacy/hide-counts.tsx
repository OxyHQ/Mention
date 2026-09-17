import React, { useState, useEffect } from 'react';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, ScrollView } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { Toggle } from '@/components/Toggle';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { RiBookmarkLine, RiChat4Line, RiEyeOffLine, RiHeartLine, RiRepeatLine } from '@oxy.so/bloom/icons';
import {
    createPrivacySettingsCacheLease,
    updatePrivacySettingsCache,
    type UserSettingsResponse,
} from '@/hooks/usePrivacySettings';
import { createLogger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';

const hideCountsLogger = createLogger('HideCounts');

export default function HideCountsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { canUsePrivateApi, isPrivateApiPending, user } = useAuth();
    const [hideLikeCounts, setHideLikeCounts] = useState(false);
    const [hideShareCounts, setHideShareCounts] = useState(false);
    const [hideReplyCounts, setHideReplyCounts] = useState(false);
    const [hideSaveCounts, setHideSaveCounts] = useState(false);
    const [loading, setLoading] = useState(true);

    const allHidden = hideLikeCounts && hideShareCounts && hideReplyCounts && hideSaveCounts;

    useEffect(() => {
        if (isPrivateApiPending) {
            return;
        }
        if (!canUsePrivateApi) {
            setLoading(false);
            return;
        }
        loadSettings();
    }, [canUsePrivateApi, isPrivateApiPending]);

    const loadSettings = async () => {
        try {
            const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
            const settings = response.data;
            setHideLikeCounts(settings.privacy?.hideLikeCounts || false);
            setHideShareCounts(settings.privacy?.hideShareCounts || false);
            setHideReplyCounts(settings.privacy?.hideReplyCounts || false);
            setHideSaveCounts(settings.privacy?.hideSaveCounts || false);
            setLoading(false);
        } catch (error) {
            hideCountsLogger.error('Error loading settings', error);
            setLoading(false);
        }
    };

    const updateSetting = async (field: 'hideLikeCounts' | 'hideShareCounts' | 'hideReplyCounts' | 'hideSaveCounts', value: boolean) => {
        const cacheLease = createPrivacySettingsCacheLease(user?.id);
        try {
            let currentPrivacy = {};
            try {
                const currentResponse = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
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

            await updatePrivacySettingsCache(updatedPrivacy, cacheLease);
        } catch (error) {
            hideCountsLogger.error('Error updating setting', error);
            if (field === 'hideLikeCounts') setHideLikeCounts(!value);
            if (field === 'hideShareCounts') setHideShareCounts(!value);
            if (field === 'hideReplyCounts') setHideReplyCounts(!value);
            if (field === 'hideSaveCounts') setHideSaveCounts(!value);
        }
    };

    const updateAllSettings = async (value: boolean) => {
        const cacheLease = createPrivacySettingsCacheLease(user?.id);
        try {
            let currentPrivacy = {};
            try {
                const currentResponse = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
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

            await updatePrivacySettingsCache(updatedPrivacy, cacheLease);
        } catch (error) {
            hideCountsLogger.error('Error updating all settings', error);
        }
    };

    const header = <PageHeader title={t('settings.privacy.hideAllCounts')} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />;

    if (isPrivateApiPending) {
        return (
            <View className="flex-1">
                {header}
                <View className="flex-1 justify-center items-center">
                    <Loading className="text-primary" size="large" />
                </View>
            </View>
        );
    }

    if (!canUsePrivateApi) {
        return (
            <View className="flex-1">
                {header}
                <OxyAuthPrompt
                    label={t('settings.privacy.hideCounts.signInRequired', { defaultValue: 'Sign in to hide engagement counts' })}
                    description={t('settings.privacy.hideCounts.signInRequiredDesc', { defaultValue: 'Hide likes, boosts, replies, and saves on your posts.' })}
                />
            </View>
        );
    }

    if (loading) {
        return (
            <View className="flex-1">
                {header}
                <View className="flex-1 justify-center items-center">
                    <Loading className="text-primary" size="large" />
                </View>
            </View>
        );
    }

    return (
        <View className="flex-1">
            {header}

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-screen-margin py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsListGroup variant="filled">
                    <SettingsListItem
                        icon={<RowIcon icon={RiEyeOffLine} />}
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

                <SettingsListGroup variant="filled" title={t('settings.privacy.individualSettings')}>
                    <SettingsListItem
                        icon={<RowIcon icon={RiHeartLine} />}
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
                        icon={<RowIcon icon={RiRepeatLine} />}
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
                        icon={<RowIcon icon={RiChat4Line} />}
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
                        icon={<RowIcon icon={RiBookmarkLine} />}
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
        </View>
    );
}
