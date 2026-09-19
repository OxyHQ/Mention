import React from 'react';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { RiMic2Line } from '@oxy.so/bloom/icons/RiMic2Line';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loading } from '@oxy.so/bloom/loading';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import {
    getLivePresencePreference,
    updateLivePresencePreference,
    type LiveVisibility,
} from '@/lib/syraApi';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

interface PresenceOption {
    value: LiveVisibility;
    labelKey: string;
    labelDefault: string;
    descKey: string;
    descDefault: string;
    icon: BloomIcon;
}

const OPTIONS: PresenceOption[] = [
    {
        value: 'active',
        labelKey: 'settings.livePresence.active',
        labelDefault: "When I'm in a live room",
        descKey: 'settings.livePresence.activeDesc',
        descDefault: 'Your avatar shows a live badge to others whenever you join a live room.',
        icon: RiBroadcastLine,
    },
    {
        value: 'speaking',
        labelKey: 'settings.livePresence.speaking',
        labelDefault: "Only when I'm speaking",
        descKey: 'settings.livePresence.speakingDesc',
        descDefault: 'Your avatar shows a live badge only while you hold the mic.',
        icon: RiMic2Line,
    },
];

export default function LivePresenceScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const queryClient = useQueryClient();
    const { canUsePrivateApi, isPrivateApiPending, user } = useAuth();
    const viewerId = user?.id;
    const livePresenceQueryKey = viewerQueryKeys.livePresence(viewerId);

    const { data: preference, isLoading } = useQuery({
        queryKey: livePresenceQueryKey,
        queryFn: getLivePresencePreference,
        enabled: canUsePrivateApi && Boolean(viewerId),
        staleTime: 60_000,
    });

    const mutation = useMutation({
        mutationFn: updateLivePresencePreference,
        onMutate: async (next: LiveVisibility) => {
            await queryClient.cancelQueries({ queryKey: livePresenceQueryKey });
            const previous = queryClient.getQueryData<LiveVisibility>(livePresenceQueryKey);
            queryClient.setQueryData<LiveVisibility>(livePresenceQueryKey, next);
            return { previous };
        },
        onError: (_error, _next, context) => {
            if (context) {
                queryClient.setQueryData(livePresenceQueryKey, context.previous);
            }
        },
        onSettled: () => {
            queryClient.invalidateQueries({ queryKey: livePresenceQueryKey });
        },
    });

    const selected: LiveVisibility = preference ?? 'active';

    const renderHeader = () => (
        <PageHeader title={t('settings.livePresence.title', { defaultValue: 'Live presence' })} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />
    );

    if (isPrivateApiPending) {
        return (
            <View className="flex-1">
                {renderHeader()}
                <View className="flex-1 items-center justify-center">
                    <Loading className="text-primary" size="large" />
                </View>
            </View>
        );
    }

    if (!canUsePrivateApi) {
        return (
            <View className="flex-1">
                {renderHeader()}
                <OxyAuthPrompt
                    label={t('settings.livePresence.signInRequired', { defaultValue: 'Sign in to manage your live presence' })}
                    description={t('settings.livePresence.signInRequiredDesc', { defaultValue: 'Choose when others see you live in a room.' })}
                />
            </View>
        );
    }

    if (isLoading) {
        return (
            <View className="flex-1">
                {renderHeader()}
                <View className="flex-1 items-center justify-center">
                    <Loading className="text-primary" size="large" />
                </View>
            </View>
        );
    }

    return (
        <View className="flex-1">
            {renderHeader()}
            <ScrollView
                className="flex-1"
                contentContainerClassName="px-screen-margin py-2"
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
                                    <option.icon width={20} height={20} fill={isSelected ? colors.primary : colors.textSecondary} />
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
