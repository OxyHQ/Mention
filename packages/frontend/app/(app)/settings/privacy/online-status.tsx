import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { Toggle } from '@/components/Toggle';

export default function OnlineStatusScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const [showOnlineStatus, setShowOnlineStatus] = useState(true);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSettings();
    }, []);

    const loadSettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setShowOnlineStatus(settings.privacy?.showOnlineStatus !== false);
            setLoading(false);
        } catch (error) {
            console.error('Error loading settings:', error);
            setLoading(false);
        }
    };

    const updateSetting = async (value: boolean) => {
        try {
            await authenticatedClient.put('/profile/settings', {
                privacy: {
                    showOnlineStatus: value
                }
            });
        } catch (error) {
            console.error('Error updating setting:', error);
        }
    };

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.onlineStatus'),
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
                    title: t('settings.privacy.onlineStatus'),
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
                    <View className="flex-row items-center justify-between px-4 pt-[18px] pb-[18px]">
                        <View className="flex-1">
                            <View>
                                <Text className="text-base font-medium mb-1 text-foreground">
                                    {t('settings.privacy.showOnlineStatus')}
                                </Text>
                                <Text className="text-sm leading-5 text-muted-foreground">
                                    {t('settings.privacy.showOnlineStatusDesc')}
                                </Text>
                            </View>
                        </View>
                        <Toggle
                            value={showOnlineStatus}
                            onValueChange={(value) => {
                                setShowOnlineStatus(value);
                                updateSetting(value);
                            }}
                        />
                    </View>
                </View>
            </ScrollView>
        </ThemedView>
    );
}
