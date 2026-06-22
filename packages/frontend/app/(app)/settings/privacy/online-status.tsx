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
import { logger } from '@/lib/logger';
import type { UserSettingsResponse } from '@/hooks/usePrivacySettings';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services';

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
            logger.error('Error loading settings', { error });
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
            logger.error('Error updating setting', { error });
            setShowOnlineStatus(!value);
        }
    };

    if (isPrivateApiPending) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.onlineStatus'),
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

    if (!canUsePrivateApi) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.onlineStatus'),
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
                    label={t('settings.privacy.onlineStatus.signInRequired', { defaultValue: 'Sign in to manage your online status' })}
                    description={t('settings.privacy.onlineStatus.signInRequiredDesc', { defaultValue: 'Decide whether others see when you are online.' })}
                />
            </ThemedView>
        );
    }

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.onlineStatus'),
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
                    title: t('settings.privacy.onlineStatus'),
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
                        icon={<RowIcon name="ellipse" />}
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
        </ThemedView>
    );
}
