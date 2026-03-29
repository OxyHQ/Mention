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
import { logger } from '@/lib/logger';

export default function TagsMentionsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const [allowTags, setAllowTags] = useState(true);
    const [allowMentions, setAllowMentions] = useState(true);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

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
            // Load current settings first to preserve other privacy settings
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
            // Revert on failure
            if (field === 'allowTags') setAllowTags(!value);
            if (field === 'allowMentions') setAllowMentions(!value);
        }
    };

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.tagsAndMentions'),
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
                    title: t('settings.privacy.tagsAndMentions'),
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
                <View className="rounded-2xl border border-border bg-card overflow-hidden">
                    <View className="flex-row items-center justify-between px-4 pt-[18px] py-4">
                        <View className="flex-1">
                            <View>
                                <Text className="text-base font-medium mb-1 text-foreground">
                                    {t('settings.privacy.allowTags')}
                                </Text>
                                <Text className="text-sm leading-5 text-muted-foreground">
                                    {t('settings.privacy.allowTagsDesc')}
                                </Text>
                            </View>
                        </View>
                        <Toggle
                            value={allowTags}
                            onValueChange={(value) => {
                                setAllowTags(value);
                                updateSetting('allowTags', value);
                            }}
                        />
                    </View>

                    <View className="h-px mx-4 bg-border" />

                    <View className="flex-row items-center justify-between px-4 py-4 pb-[18px]">
                        <View className="flex-1">
                            <View>
                                <Text className="text-base font-medium mb-1 text-foreground">
                                    {t('settings.privacy.allowMentions')}
                                </Text>
                                <Text className="text-sm leading-5 text-muted-foreground">
                                    {t('settings.privacy.allowMentionsDesc')}
                                </Text>
                            </View>
                        </View>
                        <Toggle
                            value={allowMentions}
                            onValueChange={(value) => {
                                setAllowMentions(value);
                                updateSetting('allowMentions', value);
                            }}
                        />
                    </View>
                </View>
            </ScrollView>
        </ThemedView>
    );
}
