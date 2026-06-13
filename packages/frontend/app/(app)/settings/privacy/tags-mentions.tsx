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
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';

export default function TagsMentionsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { isAuthenticated } = useAuth();
    const [allowTags, setAllowTags] = useState(true);
    const [allowMentions, setAllowMentions] = useState(true);
    const [loading, setLoading] = useState(true);

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
            setAllowTags(settings.privacy?.allowTags !== false);
            setAllowMentions(settings.privacy?.allowMentions !== false);
            setLoading(false);
        } catch (error) {
            logger.error('Error loading settings', { error });
            setLoading(false);
        }
    };

    const updateSetting = async (field: 'allowTags' | 'allowMentions', value: boolean) => {
        try {
            let currentPrivacy = {};
            try {
                const currentResponse = await authenticatedClient.get('/profile/settings/me');
                currentPrivacy = currentResponse.data?.privacy || {};
            } catch (e) {
                logger.debug('Could not load current privacy settings', { error: e });
            }

            const updatedPrivacy = {
                ...currentPrivacy,
                [field]: value,
            };
            await authenticatedClient.put('/profile/settings', {
                privacy: updatedPrivacy,
            });
        } catch (error) {
            logger.error('Error updating setting', { error });
            if (field === 'allowTags') setAllowTags(!value);
            if (field === 'allowMentions') setAllowMentions(!value);
        }
    };

    if (!isAuthenticated) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.tagsAndMentions'),
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
                    label={t('settings.privacy.tagsMentions.signInRequired', { defaultValue: 'Sign in to manage tags and mentions' })}
                    description={t('settings.privacy.tagsMentions.signInRequiredDesc', { defaultValue: 'Control who can tag or mention you in posts.' })}
                />
            </ThemedView>
        );
    }

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.tagsAndMentions'),
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
                    title: t('settings.privacy.tagsAndMentions'),
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
                        icon={<RowIcon name="pricetag-outline" />}
                        title={t('settings.privacy.allowTags')}
                        description={t('settings.privacy.allowTagsDesc')}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={allowTags}
                                onValueChange={(value) => {
                                    setAllowTags(value);
                                    updateSetting('allowTags', value);
                                }}
                            />
                        }
                    />
                    <SettingsListItem
                        icon={<RowIcon name="at-outline" />}
                        title={t('settings.privacy.allowMentions')}
                        description={t('settings.privacy.allowMentionsDesc')}
                        showChevron={false}
                        rightElement={
                            <Toggle
                                value={allowMentions}
                                onValueChange={(value) => {
                                    setAllowMentions(value);
                                    updateSetting('allowMentions', value);
                                }}
                            />
                        }
                    />
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}
