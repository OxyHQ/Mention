import React, { useState, useEffect } from 'react';
import { View, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Switch } from '@oxyhq/bloom/switch';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useSafeBack } from '@/hooks/useSafeBack';
import { authenticatedClient } from '@/utils/api';
import { SettingsItem, SettingsGroup } from '@/components/settings/SettingsItem';
import { logger } from '@/lib/logger';
import {
    type RecommendationFilters,
    DEFAULT_RECOMMENDATION_FILTERS,
    getRecommendationFilters,
    saveRecommendationFilters,
} from '@/lib/recommendationFilters';
import type { PrivacySettings } from '@/hooks/usePrivacySettings';

const FILTER_TOGGLES: Array<{
    icon: string;
    titleKey: string;
    descKey: string;
    titleDefault: string;
    descDefault: string;
    filterKey: keyof RecommendationFilters;
}> = [
    {
        icon: 'globe-outline',
        titleKey: 'settings.privacy.showFediverse',
        descKey: 'settings.privacy.showFediverseDesc',
        titleDefault: 'Fediverse accounts in suggestions',
        descDefault: 'Show accounts from Mastodon and other fediverse instances',
        filterKey: 'showFederated',
    },
    {
        icon: 'sparkles-outline',
        titleKey: 'settings.privacy.showAgents',
        descKey: 'settings.privacy.showAgentsDesc',
        titleDefault: 'AI agents in suggestions',
        descDefault: 'Show AI-powered bot accounts',
        filterKey: 'showAgents',
    },
    {
        icon: 'sync-outline',
        titleKey: 'settings.privacy.showAutomated',
        descKey: 'settings.privacy.showAutomatedDesc',
        titleDefault: 'Automated accounts in suggestions',
        descDefault: 'Show scheduled and feed-based accounts',
        filterKey: 'showAutomated',
    },
];

export default function PrivacySettingsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();

    const [privacySettings, setPrivacySettings] = useState<PrivacySettings>({});
    const [recFilters, setRecFilters] = useState<RecommendationFilters>(DEFAULT_RECOMMENDATION_FILTERS);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadPrivacySettings();
        getRecommendationFilters().then(setRecFilters);
    }, []);

    const loadPrivacySettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setPrivacySettings(settings.privacy || { profileVisibility: 'public' });
            setLoading(false);
        } catch (error) {
            logger.error('Error loading privacy settings', { error });
            setPrivacySettings({ profileVisibility: 'public' });
            setLoading(false);
        }
    };

    const updateRecFilter = (key: keyof RecommendationFilters, value: boolean) => {
        const updated = { ...recFilters, [key]: value };
        setRecFilters(updated);
        saveRecommendationFilters(updated);
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
                    title: t('settings.privacy.title'),
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
                <SettingsGroup>
                    <SettingsItem
                        icon="lock-closed"
                        title={t('settings.privacy.privateProfile')}
                        description={t('settings.privacy.privateProfileDesc', { defaultValue: 'Control who can see your profile' })}
                        badgeText={getProfileVisibilityText()}
                        onPress={() => router.push('/settings/privacy/profile-visibility')}
                    />
                    <SettingsItem
                        icon="at"
                        title={t('settings.privacy.tagsAndMentions')}
                        description={t('settings.privacy.tagsAndMentionsDesc', { defaultValue: 'Choose who can tag or mention you' })}
                        onPress={() => router.push('/settings/privacy/tags-mentions')}
                    />
                    <SettingsItem
                        icon="ellipse"
                        title={t('settings.privacy.onlineStatus')}
                        description={t('settings.privacy.onlineStatusDesc', { defaultValue: 'Show when you are active' })}
                        onPress={() => router.push('/settings/privacy/online-status')}
                    />
                </SettingsGroup>

                <SettingsGroup>
                    <SettingsItem
                        icon="people"
                        title={t('settings.privacy.restrictedProfiles')}
                        description={t('settings.privacy.restrictedProfilesDesc', { defaultValue: 'Limit interactions from specific people' })}
                        onPress={() => router.push('/settings/privacy/restricted')}
                    />
                    <SettingsItem
                        icon="close-circle"
                        title={t('settings.privacy.blockedProfiles')}
                        description={t('settings.privacy.blockedProfilesDesc', { defaultValue: 'People you have blocked' })}
                        onPress={() => router.push('/settings/privacy/blocked')}
                    />
                </SettingsGroup>

                <SettingsGroup>
                    <SettingsItem
                        icon="eye-off"
                        title={t('settings.privacy.hiddenWords')}
                        description={t('settings.privacy.hiddenWordsDesc', { defaultValue: 'Filter posts containing specific words' })}
                        onPress={() => router.push('/settings/privacy/hidden-words')}
                    />
                    <SettingsItem
                        icon="heart-outline"
                        title={t('settings.privacy.hideLikeShareCounts')}
                        description={t('settings.privacy.hideLikeShareCountsDesc', { defaultValue: 'Hide engagement counts on posts' })}
                        onPress={() => router.push('/settings/privacy/hide-counts')}
                    />
                </SettingsGroup>

                <SettingsGroup>
                    {FILTER_TOGGLES.map(({ icon, titleKey, descKey, titleDefault, descDefault, filterKey }) => (
                        <SettingsItem
                            key={filterKey}
                            icon={icon}
                            title={t(titleKey, { defaultValue: titleDefault })}
                            description={t(descKey, { defaultValue: descDefault })}
                            showChevron={false}
                            rightElement={
                                <Switch
                                    value={recFilters[filterKey]}
                                    onValueChange={(v) => updateRecFilter(filterKey, v)}
                                />
                            }
                        />
                    ))}
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
