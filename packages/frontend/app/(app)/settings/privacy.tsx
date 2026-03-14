import React, { useState, useEffect } from 'react';
import { View, ScrollView } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { SettingsItem, SettingsGroup } from '@/components/settings/SettingsItem';

interface PrivacySettings {
    profileVisibility?: 'public' | 'private' | 'followers_only';
    showContactInfo?: boolean;
    allowTags?: boolean;
    allowMentions?: boolean;
    showOnlineStatus?: boolean;
    hideLikeCounts?: boolean;
    hideShareCounts?: boolean;
    hiddenWords?: string[];
    restrictedUsers?: string[];
}

export default function PrivacySettingsScreen() {
    const { t } = useTranslation();

    const [privacySettings, setPrivacySettings] = useState<PrivacySettings>({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadPrivacySettings();
    }, []);

    const loadPrivacySettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setPrivacySettings(settings.privacy || { profileVisibility: 'public' });
            setLoading(false);
        } catch (error) {
            console.error('Error loading privacy settings:', error);
            setPrivacySettings({ profileVisibility: 'public' });
            setLoading(false);
        }
    };

    const getProfileVisibilityText = () => {
        const visibility = privacySettings.profileVisibility || 'public';
        if (visibility === 'private') return t('settings.privacy.private');
        if (visibility === 'followers_only') return t('settings.privacy.followersOnly');
        return t('settings.privacy.public');
    };

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.title'),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => router.back()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
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
                    title: t('settings.privacy.title'),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => router.back()}>
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
                <SettingsGroup>
                    <SettingsItem
                        icon="lock-closed"
                        title={t('settings.privacy.privateProfile')}
                        badgeText={getProfileVisibilityText()}
                        onPress={() => router.push('/settings/privacy/profile-visibility')}
                    />
                    <SettingsItem
                        icon="at"
                        title={t('settings.privacy.tagsAndMentions')}
                        onPress={() => router.push('/settings/privacy/tags-mentions')}
                    />
                    <SettingsItem
                        icon="ellipse"
                        title={t('settings.privacy.onlineStatus')}
                        onPress={() => router.push('/settings/privacy/online-status')}
                    />
                </SettingsGroup>

                <SettingsGroup>
                    <SettingsItem
                        icon="people"
                        title={t('settings.privacy.restrictedProfiles')}
                        onPress={() => router.push('/settings/privacy/restricted')}
                    />
                    <SettingsItem
                        icon="close-circle"
                        title={t('settings.privacy.blockedProfiles')}
                        onPress={() => router.push('/settings/privacy/blocked')}
                    />
                </SettingsGroup>

                <SettingsGroup>
                    <SettingsItem
                        icon="eye-off"
                        title={t('settings.privacy.hiddenWords')}
                        onPress={() => router.push('/settings/privacy/hidden-words')}
                    />
                    <SettingsItem
                        icon="heart-outline"
                        title={t('settings.privacy.hideLikeShareCounts')}
                        onPress={() => router.push('/settings/privacy/hide-counts')}
                    />
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
