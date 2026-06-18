import React, { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { alertDialog } from '@/utils/alerts';
import { updatePrivacySettingsCache } from '@/hooks/usePrivacySettings';
import { SettingsListGroup } from '@oxyhq/bloom/settings-list';
import { Icon, type IconName } from '@/lib/icons';
import { logger } from '@/lib/logger';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';

type VisibilityOption = 'public' | 'private' | 'followers_only';

interface VisibilityOptionConfig {
    value: VisibilityOption;
    label: string;
    description: string;
    icon: IconName;
}

export default function ProfileVisibilityScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const { isAuthenticated, isAuthResolved, isReady } = useAuth();
    const canLoadPrivateSettings = isAuthResolved && isReady && isAuthenticated;

    const [profileVisibility, setProfileVisibility] = useState<VisibilityOption>('public');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!isAuthResolved || (isAuthenticated && !isReady)) {
            return;
        }
        if (!isAuthenticated) {
            setLoading(false);
            return;
        }
        loadSettings();
    }, [isAuthResolved, isReady, isAuthenticated]);

    const loadSettings = async () => {
        try {
            const response = await authenticatedClient.get('/profile/settings/me');
            const settings = response.data;
            setProfileVisibility(settings.privacy?.profileVisibility || 'public');
            setLoading(false);
        } catch (error) {
            logger.error('Error loading settings', { error });
            setLoading(false);
        }
    };

    const handleSave = async (newVisibility: VisibilityOption) => {
        if (newVisibility === profileVisibility) {
            safeBack();
            return;
        }

        setSaving(true);
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
                profileVisibility: newVisibility,
            };
            await authenticatedClient.put('/profile/settings', {
                privacy: updatedPrivacy,
            });

            await updatePrivacySettingsCache(updatedPrivacy);

            setProfileVisibility(newVisibility);
            await alertDialog({
                title: t('common.success'),
                message: t('settings.privacy.profileVisibilityUpdated'),
            });
            setTimeout(() => {
                safeBack();
            }, 300);
        } catch (error) {
            const err = error as { response?: { data?: { error?: string } } };
            logger.error('Error updating profile visibility', { error });
            await alertDialog({
                title: t('common.error'),
                message: err?.response?.data?.error || t('settings.privacy.updateError'),
            });
        } finally {
            setSaving(false);
        }
    };

    if (!isAuthResolved || (isAuthenticated && !isReady)) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.privateProfile'),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
                />
                <View className="flex-1 items-center justify-center">
                    <Loading />
                </View>
            </ThemedView>
        );
    }

    if (!canLoadPrivateSettings) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.privateProfile'),
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
                    label={t('settings.privacy.profileVisibility.signInRequired', { defaultValue: 'Sign in to set profile visibility' })}
                    description={t('settings.privacy.profileVisibility.signInRequiredDesc', { defaultValue: 'Choose who can see your profile and posts.' })}
                />
            </ThemedView>
        );
    }

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.privacy.privateProfile'),
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

    const options: VisibilityOptionConfig[] = [
        {
            value: 'public',
            label: t('settings.privacy.public'),
            description: t('settings.privacy.publicDescription'),
            icon: 'globe',
        },
        {
            value: 'followers_only',
            label: t('settings.privacy.followersOnly'),
            description: t('settings.privacy.followersOnlyDescription'),
            icon: 'people',
        },
        {
            value: 'private',
            label: t('settings.privacy.private'),
            description: t('settings.privacy.privateDescription'),
            icon: 'lock-closed',
        },
    ];

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.privacy.privateProfile'),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                    rightComponents: saving ? [
                        <View key="saving" className="pr-2">
                            <Loading className="text-primary" variant="inline" size="small" />
                        </View>,
                    ] : [],
                }}
                hideBottomBorder
                disableSticky
            />

            <ScrollView
                className="flex-1"
                contentContainerClassName="py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsListGroup title={t('settings.privacy.privateProfile')}>
                    {options.map((option) => {
                        const isSelected = profileVisibility === option.value;

                        return (
                            <Pressable
                                key={option.value}
                                className="px-4 py-3 flex-row items-center"
                                style={{ minHeight: 56 }}
                                onPress={() => !saving && handleSave(option.value)}
                                disabled={saving}
                            >
                                <View className="w-7 items-center justify-center">
                                    <Icon
                                        name={option.icon}
                                        size={20}
                                        color={isSelected ? colors.primary : colors.textSecondary}
                                    />
                                </View>
                                <View className="flex-1 ml-3">
                                    <Text className="text-[15px] font-medium text-foreground">
                                        {option.label}
                                    </Text>
                                    <Text className="text-[13px] text-muted-foreground mt-0.5">
                                        {option.description}
                                    </Text>
                                </View>
                                {isSelected && (
                                    <Icon
                                        name="checkmark-circle"
                                        size={22}
                                        color={colors.primary}
                                    />
                                )}
                            </Pressable>
                        );
                    })}
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}
