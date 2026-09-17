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
import { RiCheckboxBlankCircleLine } from '@oxy.so/bloom/icons';
import { logger } from '@oxy.so/core/logger';
import type { UserSettingsResponse } from '@/hooks/usePrivacySettings';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';

export default function OnlineStatusScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { canUsePrivateApi, isPrivateApiPending } = useAuth();
    const [showOnlineStatus, setShowOnlineStatus] = useState(true);
    const [loading, setLoading] = useState(true);

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
            setShowOnlineStatus(settings.privacy?.showOnlineStatus !== false);
            setLoading(false);
        } catch (error) {
            logger.error('Error loading settings', error);
            setLoading(false);
        }
    };

    const updateSetting = async (value: boolean) => {
        try {
            let currentPrivacy = {};
            try {
                const currentResponse = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
                currentPrivacy = currentResponse.data?.privacy || {};
            } catch (e) {
                logger.debug('Could not load current privacy settings', { error: e });
            }

            const updatedPrivacy = {
                ...currentPrivacy,
                showOnlineStatus: value,
            };
            await authenticatedClient.put('/profile/settings', {
                privacy: updatedPrivacy,
            });
        } catch (error) {
            logger.error('Error updating setting', error);
            setShowOnlineStatus(!value);
        }
    };

    const header = <PageHeader title={t('settings.privacy.onlineStatus')} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />;

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
                    label={t('settings.privacy.onlineStatus.signInRequired', { defaultValue: 'Sign in to manage your online status' })}
                    description={t('settings.privacy.onlineStatus.signInRequiredDesc', { defaultValue: 'Decide whether others see when you are online.' })}
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
                        icon={<RowIcon icon={RiCheckboxBlankCircleLine} />}
                        title={t('settings.privacy.showOnlineStatus')}
                        description={t('settings.privacy.showOnlineStatusDesc')}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={showOnlineStatus}
                                onValueChange={(value) => {
                                    setShowOnlineStatus(value);
                                    updateSetting(value);
                                }}
                            />
                        }
                    />
                </SettingsListGroup>
            </ScrollView>
        </View>
    );
}
