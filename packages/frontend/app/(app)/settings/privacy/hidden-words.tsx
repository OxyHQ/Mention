import React, { useState } from 'react';
import { View, Text, ScrollView, TextInput, TouchableOpacity } from 'react-native';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loading } from '@oxyhq/bloom/loading';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Icon } from '@/lib/icons';
import { EmptyState } from '@/components/common/EmptyState';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import ConfirmBottomSheet from '@/components/common/ConfirmBottomSheet';
import { createScopedLogger } from '@/lib/logger';
import {
    muteWordsService,
    isHashtagMuteWord,
    muteWordDisplayValue,
    type SerializedMuteWord,
} from '@/services/muteWordsService';

const hiddenWordsLogger = createScopedLogger('HiddenWords');

const MUTE_WORDS_QUERY_KEY = ['mute-words'] as const;

/** Pull a human-readable message off an axios-style error without `as any`. */
function getErrorMessage(error: unknown, fallback: string): string {
    if (error && typeof error === 'object' && 'response' in error) {
        const response = (error as { response?: { data?: { error?: string; message?: string } } }).response;
        return response?.data?.error || response?.data?.message || fallback;
    }
    return fallback;
}

export default function HiddenWordsScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const safeBack = useSafeBack();
    const { isAuthenticated, user, canUsePrivateApi } = useAuth();
    const bottomSheet = React.useContext(BottomSheetContext);
    const queryClient = useQueryClient();
    const [input, setInput] = useState('');

    const headerOptions = {
        title: t('settings.privacy.hiddenWords'),
        leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
        ],
    };

    const {
        data: mutedWords = [],
        isLoading,
        isError,
        refetch,
    } = useQuery<SerializedMuteWord[]>({
        queryKey: [...MUTE_WORDS_QUERY_KEY, user?.id],
        queryFn: () => muteWordsService.list(),
        enabled: canUsePrivateApi,
    });

    // Muting/unmuting changes which posts are filtered out of the MTN feed.
    // The home feed is store-based (postsStore + feedService), not React-Query
    // cached, so it re-filters on its next fetchInitial(true)/pull-to-refresh.
    // We still invalidate the ['feed'] key to cover any React-Query feed
    // consumers and prime a refetch on next navigation.
    const invalidateFeed = () => {
        queryClient.invalidateQueries({ queryKey: ['feed'] });
    };

    const addMutation = useMutation<SerializedMuteWord, unknown, string>({
        mutationFn: (rawInput: string) => muteWordsService.create(rawInput),
        onSuccess: () => {
            setInput('');
            queryClient.invalidateQueries({ queryKey: MUTE_WORDS_QUERY_KEY });
            invalidateFeed();
            toast(t('settings.privacy.wordMuted', { defaultValue: 'Word muted' }), { type: 'success' });
        },
        onError: (error) => {
            hiddenWordsLogger.error('Failed to add muted word', { error });
            toast(getErrorMessage(error, t('settings.privacy.failedToMuteWord', { defaultValue: 'Failed to mute word' })), {
                type: 'error',
            });
        },
    });

    const removeMutation = useMutation<void, unknown, string>({
        mutationFn: (id: string) => muteWordsService.remove(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: MUTE_WORDS_QUERY_KEY });
            invalidateFeed();
            toast(t('settings.privacy.wordUnmuted', { defaultValue: 'Word unmuted' }), { type: 'success' });
        },
        onError: (error) => {
            hiddenWordsLogger.error('Failed to remove muted word', { error });
            toast(
                getErrorMessage(error, t('settings.privacy.failedToUnmuteWord', { defaultValue: 'Failed to unmute word' })),
                { type: 'error' }
            );
        },
    });

    const handleAdd = () => {
        const value = input.trim();
        if (!value || addMutation.isPending) return;
        addMutation.mutate(value);
    };

    const handleRemove = (word: SerializedMuteWord) => {
        bottomSheet.setBottomSheetContent(
            <ConfirmBottomSheet
                title={t('settings.privacy.removeMutedWord', { defaultValue: 'Remove muted word' })}
                message={t('settings.privacy.removeMutedWordConfirm', {
                    defaultValue: 'Stop hiding posts containing "{{value}}"?',
                    value: muteWordDisplayValue(word),
                })}
                confirmText={t('common.remove', { defaultValue: 'Remove' })}
                cancelText={t('common.cancel')}
                destructive
                onConfirm={() => removeMutation.mutate(word.id)}
                onCancel={() => bottomSheet.openBottomSheet(false)}
            />
        );
        bottomSheet.openBottomSheet(true);
    };

    if (!isAuthenticated) {
        return (
            <ThemedView className="flex-1">
                <Header options={headerOptions} hideBottomBorder disableSticky />
                <OxyAuthPrompt
                    label={t('settings.privacy.hiddenWordsSignInRequired', {
                        defaultValue: 'Sign in to manage muted words',
                    })}
                    description={t('settings.privacy.hiddenWordsSignInRequiredDesc', {
                        defaultValue: 'Muted words and hashtags hide matching posts from your feeds.',
                    })}
                />
            </ThemedView>
        );
    }

    return (
        <ThemedView className="flex-1">
            <Header options={headerOptions} hideBottomBorder disableSticky />

            <ScrollView
                className="flex-1"
                contentContainerClassName="py-2"
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
            >
                <SettingsListGroup>
                    <View className="px-4 py-3.5 flex-row items-center gap-3">
                        <Icon name="information-circle" size={20} color={colors.primary} />
                        <Text className="flex-1 text-[13px] text-foreground">
                            {t('settings.privacy.hiddenWordsDescription', {
                                defaultValue:
                                    'Posts containing these words or hashtags are hidden from your feeds. Start an entry with # to mute a hashtag.',
                            })}
                        </Text>
                    </View>
                </SettingsListGroup>

                <SettingsListGroup title={t('settings.privacy.addMutedWord', { defaultValue: 'Add a word or hashtag' })}>
                    <View className="px-4 py-3 flex-row items-center gap-3">
                        <Icon name="eye-off-outline" size={20} color={colors.textSecondary} />
                        <TextInput
                            className="flex-1 text-[15px] text-foreground"
                            placeholder={t('settings.privacy.addWordPlaceholder', {
                                defaultValue: 'Word or #hashtag',
                            })}
                            placeholderTextColor={colors.textSecondary}
                            value={input}
                            onChangeText={setInput}
                            autoCapitalize="none"
                            autoCorrect={false}
                            returnKeyType="done"
                            onSubmitEditing={handleAdd}
                            editable={!addMutation.isPending}
                        />
                        {addMutation.isPending ? (
                            <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
                        ) : (
                            <TouchableOpacity
                                accessibilityRole="button"
                                accessibilityLabel={t('settings.privacy.addMutedWord', { defaultValue: 'Add a word or hashtag' })}
                                disabled={input.trim().length === 0}
                                onPress={handleAdd}
                                activeOpacity={0.7}
                            >
                                <Icon
                                    name="add-circle"
                                    size={26}
                                    color={input.trim().length === 0 ? colors.textSecondary : colors.primary}
                                />
                            </TouchableOpacity>
                        )}
                    </View>
                </SettingsListGroup>

                <SettingsListGroup title={t('settings.privacy.mutedWords', { defaultValue: 'Muted words and hashtags' })}>
                    {isLoading ? (
                        <View className="py-10 items-center">
                            <Loading className="text-primary" size="large" style={{ flex: undefined }} />
                        </View>
                    ) : isError ? (
                        <View className="py-4">
                            <EmptyState
                                title={t('settings.privacy.failedToLoadMutedWords', {
                                    defaultValue: 'Failed to load muted words',
                                })}
                                icon={{ name: 'alert-circle-outline', size: 48 }}
                                error={{
                                    title: t('settings.privacy.failedToLoadMutedWords', {
                                        defaultValue: 'Failed to load muted words',
                                    }),
                                    message: t('common.tryAgain', { defaultValue: 'Try again' }),
                                    onRetry: async () => {
                                        await refetch();
                                    },
                                }}
                            />
                        </View>
                    ) : mutedWords.length === 0 ? (
                        <View className="py-4">
                            <EmptyState
                                title={t('settings.privacy.mutedWordsEmpty', {
                                    defaultValue: 'No muted words yet',
                                })}
                                icon={{ name: 'eye-off-outline', size: 48 }}
                            />
                        </View>
                    ) : (
                        mutedWords.map((word) => {
                            const isHashtag = isHashtagMuteWord(word);
                            return (
                                <SettingsListItem
                                    key={word.id}
                                    icon={
                                        <Icon
                                            name={isHashtag ? 'pricetag-outline' : 'text-outline'}
                                            size={20}
                                            color={colors.textSecondary}
                                        />
                                    }
                                    title={muteWordDisplayValue(word)}
                                    description={
                                        isHashtag
                                            ? t('settings.privacy.mutedWordTypeHashtag', { defaultValue: 'Hashtag' })
                                            : t('settings.privacy.mutedWordTypeWord', { defaultValue: 'Word' })
                                    }
                                    showChevron={false}
                                    rightElement={
                                        <TouchableOpacity
                                            className="px-3 py-1.5 rounded-lg"
                                            style={{ backgroundColor: colors.error + '20' }}
                                            activeOpacity={0.7}
                                            accessibilityRole="button"
                                            accessibilityLabel={t('settings.privacy.removeMutedWord', {
                                                defaultValue: 'Remove muted word',
                                            })}
                                            onPress={() => handleRemove(word)}
                                        >
                                            <Text className="text-[13px] font-semibold" style={{ color: colors.error }}>
                                                {t('common.remove', { defaultValue: 'Remove' })}
                                            </Text>
                                        </TouchableOpacity>
                                    }
                                />
                            );
                        })
                    )}
                </SettingsListGroup>
            </ScrollView>
        </ThemedView>
    );
}
