import React, { useState, useMemo, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { useQuery } from '@tanstack/react-query';
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
    const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();
    const mySettings = useAppearanceStore((state) => state.mySettings);
    const loadMySettings = useAppearanceStore((state) => state.loadMySettings);
    const [isSaving, setIsSaving] = useState(false);

    // The interest categories are served by an auth-gated endpoint, so the query
    // is keyed on the viewer identity and gated on `canUsePrivateApi` (matching
    // the sibling authed settings screens). `getCategories` resolves to `[]` on
    // failure rather than throwing, so the query always settles — the spinner can
    // never hang, and an error simply surfaces the empty state.
    const categoriesQuery = useQuery({
        queryKey: ['interests', 'categories', user?.id],
        queryFn: () => topicService.getCategories(),
        enabled: canUsePrivateApi,
        staleTime: 5 * 60 * 1000,
    });

    // Drive the Zustand `loadMySettings` action declaratively through React Query
    // (no data-fetching effect, no fire-and-forget `void`). The action swallows its
    // own errors, so this query settles regardless of outcome — the spinner clears
    // on success AND on failure, rather than waiting forever for `mySettings` to
    // become truthy (the old permanent-spinner bug).
    const mySettingsQuery = useQuery({
        queryKey: ['appearance', 'mySettings', user?.id],
        queryFn: async () => {
            await loadMySettings(true);
            return useAppearanceStore.getState().mySettings ?? null;
        },
        enabled: canUsePrivateApi,
    });

    const availableInterests = useMemo(
        () => (categoriesQuery.data ?? []).map((c) => ({ name: c.slug, displayName: c.displayName })),
        [categoriesQuery.data]
    );

    const preselectedInterests = useMemo(
        () => mySettings?.interests?.tags || [],
        [mySettings?.interests?.tags]
    );

    // Loading is derived from the two queries' fetch state (never from data
    // presence). Both `getCategories` and `loadMySettings` resolve to an
    // empty/degraded result instead of throwing, so `isLoading` always returns to
    // `false` — the error path ends the spinner and shows the empty state.
    const isLoading = categoriesQuery.isLoading || mySettingsQuery.isLoading;

    // Seed the locally-editable selection from the loaded settings, re-syncing
    // whenever the persisted tags change (React's "adjust state during render"
    // pattern — no effect). `preselectedInterests` only changes reference when the
    // stored `interests.tags` array does, so this fires once per real update.
    const [interests, setInterests] = useState<string[]>(preselectedInterests);
    const [syncedInterests, setSyncedInterests] = useState<string[]>(preselectedInterests);
    if (syncedInterests !== preselectedInterests) {
        setSyncedInterests(preselectedInterests);
        setInterests(preselectedInterests);
    }

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

    if (isLoading) {
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
