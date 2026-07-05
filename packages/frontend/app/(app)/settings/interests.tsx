import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAppearanceStore } from '@/store/appearanceStore';
import { authenticatedClient } from '@/utils/api';
import { topicService } from '@/services/topicService';
import { SettingsListGroup } from '@oxyhq/bloom/settings-list';
import { Icon } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';

function debounce<T extends (...args: unknown[]) => unknown>(func: T, wait: number): T {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    return ((...args: unknown[]) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    }) as T;
}

export default function InterestsSettingsScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { colors } = useTheme();
    const { canUsePrivateApi, isPrivateApiPending } = useAuth();
    const mySettings = useAppearanceStore((state) => state.mySettings);
    const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
    const [loading, setLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [interests, setInterests] = useState<string[]>([]);
    const [availableInterests, setAvailableInterests] = useState<Array<{ name: string; displayName: string }>>([]);

    const preselectedInterests = useMemo(
        () => mySettings?.interests?.tags || [],
        [mySettings?.interests?.tags]
    );

    useEffect(() => {
        // Wait out the token-pending SSO window; keep the initial `loading`
        // spinner up rather than firing private reads that would 401.
        if (isPrivateApiPending) {
            return;
        }
        if (!canUsePrivateApi) {
            setLoading(false);
            return;
        }
        void loadMySettings(true);

        let cancelled = false;
        topicService.getCategories().then(categories => {
            if (cancelled) return;
            setAvailableInterests(categories.map(c => ({ name: c.slug, displayName: c.displayName })));
        }).catch((error) => {
            if (cancelled) return;
            logger.error('Failed to load interest categories', { error });
            setAvailableInterests([]);
        });

        return () => { cancelled = true; };
    }, [canUsePrivateApi, isPrivateApiPending, loadMySettings]);

    useEffect(() => {
        if (mySettings) {
            setInterests(preselectedInterests);
            setLoading(false);
        }
    }, [mySettings, preselectedInterests]);

    const saveInterests = useMemo(() => {
        return debounce(async (...args: unknown[]) => {
            const newInterests = args[0] as string[];
            const noEdits =
                newInterests.length === preselectedInterests.length &&
                preselectedInterests.every(pre => {
                    return newInterests.find(int => int === pre);
                });

            if (noEdits) return;

            setIsSaving(true);

            try {
                await authenticatedClient.put('/profile/settings', {
                    interests: {
                        tags: newInterests,
                    },
                });

                await loadMySettings(true);

                logger.info('Interests saved successfully');
            } catch (error) {
                logger.error('Failed to save interests', { error });
            } finally {
                setIsSaving(false);
            }
        }, 1500);
    }, [preselectedInterests, loadMySettings]);

    const onChangeInterests = useCallback((newInterests: string[]) => {
        setInterests(newInterests);
        saveInterests(newInterests);
    }, [saveInterests]);

    const toggleInterest = useCallback((interest: string) => {
        const newInterests = interests.includes(interest)
            ? interests.filter(i => i !== interest)
            : [...interests, interest];
        onChangeInterests(newInterests);
    }, [interests, onChangeInterests]);

    if (isPrivateApiPending) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.interests.title', { defaultValue: 'Your interests' }),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
                />
                <View className="flex-1 justify-center items-center bg-background">
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
                        title: t('settings.interests.title', { defaultValue: 'Your interests' }),
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
                    label={t('settings.interests.signInRequired', { defaultValue: 'Sign in to choose your interests' })}
                    description={t('settings.interests.signInRequiredDesc', { defaultValue: 'Pick topics so we can tailor your feed.' })}
                />
            </ThemedView>
        );
    }

    if (loading) {
        return (
            <ThemedView className="flex-1">
                <Header
                    options={{
                        title: t('settings.interests.title', { defaultValue: 'Your interests' }),
                        leftComponents: [
                            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                <BackArrowIcon size={20} className="text-foreground" />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder
                    disableSticky
                />
                <View className="flex-1 justify-center items-center bg-background">
                    <Loading className="text-primary" size="large" />
                </View>
            </ThemedView>
        );
    }

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.interests.title', { defaultValue: 'Your interests' }),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                            <BackArrowIcon size={20} className="text-foreground" />
                        </IconButton>,
                    ],
                    rightComponents: isSaving ? [
                        <View key="loading" className="p-1 mr-2">
                            <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
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
                {interests.length === 0 && (
                    <SettingsListGroup>
                        <View className="px-4 py-3.5 flex-row items-center gap-3">
                            <View className="w-7 items-center justify-center">
                                <Icon name="information-circle-outline" size={20} color={colors.primary} />
                            </View>
                            <Text className="flex-1 text-[13px] text-foreground">
                                {t('settings.interests.tip', { defaultValue: 'We recommend selecting at least two interests.' })}
                            </Text>
                        </View>
                    </SettingsListGroup>
                )}

                <SettingsListGroup
                    title={t('settings.interests.title', { defaultValue: 'Your interests' })}
                    footer={t('settings.interests.description', {
                        defaultValue: 'Your selected interests help us serve you content you care about.',
                    })}
                >
                    <View className="flex-row flex-wrap gap-2 px-4 py-4">
                        {availableInterests.map(({ name, displayName }) => (
                            <InterestButton
                                key={name}
                                interest={name}
                                label={displayName}
                                isSelected={interests.includes(name)}
                                onPress={() => toggleInterest(name)}
                            />
                        ))}
                    </View>
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}

interface InterestButtonProps {
    interest: string;
    label: string;
    isSelected: boolean;
    onPress: () => void;
}

function InterestButton({ label, isSelected, onPress }: InterestButtonProps) {
    return (
        <TouchableOpacity
            className={cn(
                "px-4 py-2.5 rounded-full border",
                isSelected
                    ? "bg-primary border-primary"
                    : "bg-secondary border-border"
            )}
            onPress={onPress}
            activeOpacity={0.7}
        >
            <Text
                className={cn(
                    "text-sm",
                    isSelected ? "text-primary-foreground font-semibold" : "text-foreground font-medium"
                )}
            >
                {label}
            </Text>
        </TouchableOpacity>
    );
}
