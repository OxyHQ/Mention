import React from 'react';
import { RiGitMergeLine } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loading } from '@oxy.so/bloom/loading';
import { toast } from '@oxy.so/bloom/toast';
import { useTheme } from '@oxy.so/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@oxy.so/core/logger';
import { getNormalizedUserHandle } from '@oxy.so/core';
import type { MutedLane } from '@mention/shared-types';
import { useSafeBack } from '@/hooks/useSafeBack';
import { EmptyState } from '@/components/common/EmptyState';
import { getErrorMessage } from '@/utils/apiError';
import { lanesService } from '@/services/lanesService';
import { noteLaneListsChanged } from '@/stores/laneInvalidation';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { Admonition } from '@oxy.so/bloom/admonition';
import { RowIcon } from '@/components/settings/RowIcon';

const mutedLanesLogger = createLogger('MutedLanes');

/**
 * The lanes this reader has silenced.
 *
 * Deliberately narrower than muted words, and the copy says so: a muted word is
 * a safety rule about content the reader must not be shown, so it applies in
 * search and notifications too. A muted lane is a TIMELINE preference — "don't
 * push me this track" — so it applies to feeds only, and opening the post or
 * searching for it still works. Suppressing a deliberate retrieval would just
 * make the product look broken.
 */
export default function MutedLanesScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const { isAuthenticated, user, canUsePrivateApi } = useAuth();
    const queryClient = useQueryClient();

    const header = <PageHeader title={t('lanes.muted.title', { defaultValue: 'Muted lanes' })} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />;

    const mutedQueryKey = viewerQueryKeys.mutedLanes(user?.id);
    const {
        data: muted = [],
        isLoading,
        isError,
        refetch,
    } = useQuery<MutedLane[]>({
        queryKey: mutedQueryKey,
        queryFn: () => lanesService.listMuted(),
        enabled: canUsePrivateApi,
    });

    const unmuteMutation = useMutation<void, unknown, string>({
        mutationFn: (laneId: string) => lanesService.unmute(laneId),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: mutedQueryKey });
            // Unmuting puts posts BACK into every feed this reader opens, which
            // is the same reach a mute had — so it is the same signal.
            noteLaneListsChanged('mute');
            toast(t('lanes.muted.unmuted', { defaultValue: 'Lane unmuted' }), { type: 'success' });
        },
        onError: (error) => {
            mutedLanesLogger.error('Failed to unmute lane', error);
            toast(
                getErrorMessage(error, t('lanes.muted.unmuteFailed', { defaultValue: 'Failed to unmute lane' })),
                { type: 'error' },
            );
        },
    });

    if (!isAuthenticated) {
        return (
            <View className="flex-1">
                {header}
                <OxyAuthPrompt
                    label={t('lanes.muted.signInRequired', { defaultValue: 'Sign in to manage muted lanes' })}
                    description={t('lanes.muted.description', {
                        defaultValue: 'A muted lane stops appearing in your feeds. You keep following its author, and everything else they post still reaches you.',
                    })}
                />
            </View>
        );
    }

    return (
        <View className="flex-1">
            {header}

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-screen-margin py-2"
                showsVerticalScrollIndicator={false}
            >
                <View className="mb-4">
                    <Admonition type="info">
                        {t('lanes.muted.description', {
                            defaultValue: 'A muted lane stops appearing in your feeds. You keep following its author, and everything else they post still reaches you.',
                        })}
                    </Admonition>
                </View>

                <SettingsListGroup title={t('lanes.muted.title', { defaultValue: 'Muted lanes' })}>
                    {isLoading ? (
                        <View className="py-10 items-center">
                            <Loading className="text-primary" size="large" style={{ flex: undefined }} />
                        </View>
                    ) : isError ? (
                        <View className="py-4">
                            <EmptyState
                                title={t('lanes.muted.loadFailed', { defaultValue: 'Failed to load muted lanes' })}
                                icon={{ name: 'alert-circle-outline', size: 48 }}
                                error={{
                                    title: t('lanes.muted.loadFailed', { defaultValue: 'Failed to load muted lanes' }),
                                    message: t('common.tryAgain', { defaultValue: 'Try again' }),
                                    onRetry: async () => {
                                        await refetch();
                                    },
                                }}
                            />
                        </View>
                    ) : muted.length === 0 ? (
                        <View className="py-4">
                            <EmptyState
                                title={t('lanes.muted.empty', { defaultValue: 'No muted lanes' })}
                                icon={{ name: 'volume-mute-outline', size: 48 }}
                            />
                        </View>
                    ) : (
                        muted.map((entry) => {
                            // The publisher's handle comes from the canonical Oxy
                            // identity the server resolved; an owner that could not
                            // be resolved is dropped there, never rendered blank.
                            const handle = getNormalizedUserHandle(entry.owner) || '';
                            return (
                                <SettingsListItem
                                    key={entry.lane.id}
                                    icon={<RowIcon icon={RiGitMergeLine} />}
                                    title={entry.lane.name}
                                    description={handle ? `@${handle}` : undefined}
                                    showChevron={false}
                                    rightElement={
                                        <TouchableOpacity
                                            className="px-3 py-1.5 rounded-lg"
                                            style={{ backgroundColor: colors.error + '20' }}
                                            activeOpacity={0.7}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('lanes.muted.unmute', { defaultValue: 'Unmute' })}
                                            onPress={() => unmuteMutation.mutate(entry.lane.id)}
                                        >
                                            <Text className="text-[13px] font-semibold" style={{ color: colors.error }}>
                                                {t('lanes.muted.unmute', { defaultValue: 'Unmute' })}
                                            </Text>
                                        </TouchableOpacity>
                                    }
                                />
                            );
                        })
                    )}
                </SettingsListGroup>
            </ScrollView>
        </View>
    );
}
