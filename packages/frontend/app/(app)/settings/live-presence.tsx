import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { SettingsListGroup } from '@oxyhq/bloom/settings-list';
import { Icon, type IconName } from '@/lib/icons';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services';
import {
    getLivePresencePreference,
    updateLivePresencePreference,
    type LiveVisibility,
} from '@/lib/liveConfig';

const LIVE_PRESENCE_QUERY_KEY = ['live-presence-preference'] as const;

interface PresenceOption {
    value: LiveVisibility;
    labelKey: string;
    labelDefault: string;
    descKey: string;
    descDefault: string;
    icon: IconName;
}

const OPTIONS: PresenceOption[] = [
    {
        value: 'active',
        labelKey: 'settings.livePresence.active',
        labelDefault: "When I'm in a live room",
        descKey: 'settings.livePresence.activeDesc',
        descDefault: 'Your avatar shows a live badge to others whenever you join a live room.',
        icon: 'radio-outline',
    },
    {
        value: 'speaking',
        labelKey: 'settings.livePresence.speaking',
        labelDefault: "Only when I'm speaking",
        descKey: 'settings.livePresence.speakingDesc',
        descDefault: 'Your avatar shows a live badge only while you hold the mic.',
        icon: 'mic-outline',
    },
];

export default function LivePresenceScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const queryClient = useQueryClient();
    const { canUsePrivateApi, isPrivateApiPending } = useAuth();

    const { data: preference, isLoading } = useQuery({
        queryKey: LIVE_PRESENCE_QUERY_KEY,
        queryFn: getLivePresencePreference,
        enabled: canUsePrivateApi,
        staleTime: 60_000,
    });

    const mutation = useMutation({
        mutationFn: updateLivePresencePreference,
        onMutate: async (next: LiveVisibility) => {
            await queryClient.cancelQueries({ queryKey: LIVE_PRESENCE_QUERY_KEY });
            const previous = queryClient.getQueryData<LiveVisibility>(LIVE_PRESENCE_QUERY_KEY);
            queryClient.setQueryData<LiveVisibility>(LIVE_PRESENCE_QUERY_KEY, next);
            return { previous };
        },
        onError: (_error, _next, context) => {
            if (context) {
                queryClient.setQueryData(LIVE_PRESENCE_QUERY_KEY, context.previous);
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: LIVE_PRESENCE_QUERY_KEY });
        },
    });

    const selected: LiveVisibility = preference ?? 'active';

    const renderHeader = () => (
        <Header
            options={{
                title: t('settings.livePresence.title', { defaultValue: 'Live presence' }),
                leftComponents: [
                    <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                        <BackArrowIcon size={20} className="text-foreground" />
                    </IconButton>,
                ],
            }}
            hideBottomBorder
            disableSticky
        />
    );

    if (isPrivateApiPending) {
        return (
            <ThemedView className="flex-1">
                {renderHeader()}
                <View className="flex-1 items-center justify-center">
                    <Loading className="text-primary" size="large" />
                </View>
            </ThemedView>
        );
    }

    if (!canUsePrivateApi) {
        return (
            <ThemedView className="flex-1">
                {renderHeader()}
                <OxyAuthPrompt
                    label={t('settings.livePresence.signInRequired', { defaultValue: 'Sign in to manage your live presence' })}
                    description={t('settings.livePresence.signInRequiredDesc', { defaultValue: 'Choose when others see you live in a room.' })}
                />
            </ThemedView>
        );
    }

    if (isLoading) {
        return (
            <ThemedView className="flex-1">
                {renderHeader()}
                <View className="flex-1 items-center justify-center">
                    <Loading className="text-primary" size="large" />
                </View>
            </ThemedView>
        );
    }

    return (
        <ThemedView className="flex-1">
            {renderHeader()}
            <ScrollView
                className="flex-1"
                contentContainerClassName="py-2"
                showsVerticalScrollIndicator={false}
            >
                <SettingsListGroup
                    title={t('settings.livePresence.title', { defaultValue: 'Live presence' })}
                    footer={t('settings.livePresence.footer', {
                        defaultValue: 'This controls when your avatar shows a live badge across Mention.',
                    })}
                >
                    {OPTIONS.map((option) => {
                        const isSelected = selected === option.value;
                        return (
                            <Pressable
                                key={option.value}
                                className="px-4 py-3 flex-row items-center"
                                style={{ minHeight: 56 }}
                                onPress={() => mutation.mutate(option.value)}
                                disabled={mutation.isPending}
                                accessibilityRole="radio"
                                accessibilityState={{ selected: isSelected, disabled: mutation.isPending }}
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
                                        {t(option.labelKey, { defaultValue: option.labelDefault })}
                                    </Text>
                                    <Text className="text-[13px] text-muted-foreground mt-0.5">
                                        {t(option.descKey, { defaultValue: option.descDefault })}
                                    </Text>
                                </View>
                                {isSelected && (
                                    <Icon name="checkmark-circle" size={22} color={colors.primary} />
                                )}
                            </Pressable>
                        );
                    })}
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}
