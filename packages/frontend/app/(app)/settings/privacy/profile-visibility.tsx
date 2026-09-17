import React, { useState, useEffect } from 'react';
import { RiCheckboxCircleFill, RiEarthLine, RiGroupLine, RiLockLine } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { authenticatedClient } from '@/utils/api';
import { alertDialog } from '@/utils/alerts';
import {
    createPrivacySettingsCacheLease,
    updatePrivacySettingsCache,
    type UserSettingsResponse,
} from '@/hooks/usePrivacySettings';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { logger } from '@oxy.so/core/logger';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';

type VisibilityOption = 'public' | 'private' | 'followers_only';

interface VisibilityOptionConfig {
    value: VisibilityOption;
    label: string;
    description: string;
    icon: BloomIcon;
}

export default function ProfileVisibilityScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const {
        isAuthenticated,
        isAuthResolved,
        canUsePrivateApi,
        isPrivateApiPending,
        user,
    } = useAuth();

    const [profileVisibility, setProfileVisibility] = useState<VisibilityOption>('public');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        if (!isAuthResolved || isPrivateApiPending) {
            return;
        }
        if (!isAuthenticated) {
            setLoading(false);
            return;
        }
        loadSettings();
    }, [isAuthResolved, isPrivateApiPending, isAuthenticated]);

    const loadSettings = async () => {
        try {
            const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
            const settings = response.data;
            setProfileVisibility(settings.privacy?.profileVisibility || 'public');
            setLoading(false);
        } catch (error) {
            logger.error('Error loading settings', error);
            setLoading(false);
        }
    };

    const handleSave = async (newVisibility: VisibilityOption) => {
        if (newVisibility === profileVisibility) {
            safeBack();
            return;
        }

        setSaving(true);
        const cacheLease = createPrivacySettingsCacheLease(user?.id);
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
                profileVisibility: newVisibility,
            };
            await authenticatedClient.put('/profile/settings', {
                privacy: updatedPrivacy,
            });

            await updatePrivacySettingsCache(updatedPrivacy, cacheLease);

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
            logger.error('Error updating profile visibility', error);
            await alertDialog({
                title: t('common.error'),
                message: err?.response?.data?.error || t('settings.privacy.updateError'),
            });
        } finally {
            setSaving(false);
        }
    };

    if (!isAuthResolved || isPrivateApiPending) {
        return (
            <View className="flex-1">
                <PageHeader title={t('settings.privacy.privateProfile')} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />
                <View className="flex-1 items-center justify-center">
                    <Loading />
                </View>
            </View>
        );
    }

    if (!canUsePrivateApi) {
        return (
            <View className="flex-1">
                <PageHeader title={t('settings.privacy.privateProfile')} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />
                <OxyAuthPrompt
                    label={t('settings.privacy.profileVisibility.signInRequired', { defaultValue: 'Sign in to set profile visibility' })}
                    description={t('settings.privacy.profileVisibility.signInRequiredDesc', { defaultValue: 'Choose who can see your profile and posts.' })}
                />
            </View>
        );
    }

    if (loading) {
        return (
            <View className="flex-1">
                <PageHeader title={t('settings.privacy.privateProfile')} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />
                <View className="flex-1 justify-center items-center">
                    <Loading className="text-primary" size="large" />
                </View>
            </View>
        );
    }

    const options: VisibilityOptionConfig[] = [
        {
            value: 'public',
            label: t('settings.privacy.public'),
            description: t('settings.privacy.publicDescription'),
            icon: RiEarthLine,
        },
        {
            value: 'followers_only',
            label: t('settings.privacy.followersOnly'),
            description: t('settings.privacy.followersOnlyDescription'),
            icon: RiGroupLine,
        },
        {
            value: 'private',
            label: t('settings.privacy.private'),
            description: t('settings.privacy.privateDescription'),
            icon: RiLockLine,
        },
    ];

    return (
        <View className="flex-1">
            <PageHeader title={t('settings.privacy.privateProfile')} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} actions={saving ? <Loading className="text-primary" variant="inline" size="small" /> : undefined} />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-screen-margin py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsListGroup variant="filled" title={t('settings.privacy.privateProfile')}>
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
                                    <option.icon width={20} height={20} fill={isSelected ? colors.primary : colors.textSecondary} />
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
                                    <RiCheckboxCircleFill width={22} height={22} fill={colors.primary} />
                                )}
                            </Pressable>
                        );
                    })}
                </SettingsListGroup>
            </ScrollView>
        </View>
    );
}
