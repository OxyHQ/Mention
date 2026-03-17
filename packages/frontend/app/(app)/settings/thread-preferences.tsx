import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeBack } from '@/hooks/useSafeBack';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Toggle } from '@/components/Toggle';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { storeData } from '@/utils/storage';
import { SettingsGroup } from '@/components/settings/SettingsItem';
import { STORAGE_KEYS } from '@/lib/constants';
import { Icon, type IconName } from '@/lib/icons';
import { RadioIndicator } from '@oxyhq/bloom/radio-indicator';
import { useThreadPreferencesStore, SORT_OPTIONS } from '@/hooks/useThreadPreferences';
import { useVoteStyle, type VoteStyle } from '@/hooks/useVoteStyle';

const VOTE_STYLE_OPTIONS: { value: VoteStyle; icon: IconName; labelKey: string; defaultLabel: string }[] = [
    { value: 'heart', icon: 'heart-outline', labelKey: 'settings.threadPreferences.voteStyleHeart', defaultLabel: 'Heart' },
    { value: 'pill', icon: 'chevron-up-outline', labelKey: 'settings.threadPreferences.voteStylePill', defaultLabel: 'Up/down vote' },
];

export default function ThreadPreferencesScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { colors } = useTheme();
    const { sortOrder, treeView, setSortOrder, setTreeView } = useThreadPreferencesStore();
    const savedVoteStyle = useVoteStyle();
    const [voteStyle, setVoteStyle] = useState<VoteStyle>(savedVoteStyle);

    useEffect(() => {
        setVoteStyle(savedVoteStyle);
    }, [savedVoteStyle]);

    const onVoteStyleChange = useCallback(async (value: VoteStyle) => {
        setVoteStyle(value);
        await storeData(STORAGE_KEYS.VOTE_STYLE, value);
    }, []);

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.threadPreferences.title', { defaultValue: 'Thread preferences' }),
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
                contentContainerClassName="px-4 pt-4 pb-8"
                showsVerticalScrollIndicator={false}
            >
                {/* Sort replies */}
                <SettingsGroup title={t('settings.threadPreferences.sortReplies', { defaultValue: 'Sort replies' })}>
                    {SORT_OPTIONS.map((option) => (
                        <Pressable
                            key={option.value}
                            className="px-4 py-3.5 flex-row items-center justify-between"
                            onPress={() => setSortOrder(option.value)}
                        >
                            <View className="flex-row items-center gap-3">
                                <View className="w-7 items-center justify-center">
                                    <Icon
                                        name={option.icon}
                                        size={20}
                                        color={colors.textSecondary}
                                    />
                                </View>
                                <Text className="text-[15px] font-medium text-foreground">
                                    {t(option.labelKey, { defaultValue: option.defaultLabel })}
                                </Text>
                            </View>
                            <RadioIndicator selected={sortOrder === option.value} />
                        </Pressable>
                    ))}
                </SettingsGroup>

                {/* Like style */}
                <SettingsGroup title={t('settings.threadPreferences.likeStyle', { defaultValue: 'Like style' })}>
                    {VOTE_STYLE_OPTIONS.map((option) => (
                        <Pressable
                            key={option.value}
                            className="px-4 py-3.5 flex-row items-center justify-between"
                            onPress={() => onVoteStyleChange(option.value)}
                        >
                            <View className="flex-row items-center gap-3">
                                <View className="w-7 items-center justify-center">
                                    <Icon
                                        name={option.icon}
                                        size={20}
                                        color={colors.textSecondary}
                                    />
                                </View>
                                <Text className="text-[15px] font-medium text-foreground">
                                    {t(option.labelKey, { defaultValue: option.defaultLabel })}
                                </Text>
                            </View>
                            <RadioIndicator selected={voteStyle === option.value} />
                        </Pressable>
                    ))}
                </SettingsGroup>

                {/* Tree view */}
                <SettingsGroup title={t('settings.threadPreferences.display', { defaultValue: 'Display' })}>
                    <View className="px-4 py-3.5 flex-row items-center justify-between">
                        <View className="flex-row items-center gap-3 flex-1 mr-3">
                            <View className="w-7 items-center justify-center">
                                <Icon name="git-branch-outline" size={20} color={colors.textSecondary} />
                            </View>
                            <View className="flex-1">
                                <Text className="text-[15px] font-medium text-foreground">
                                    {t('settings.threadPreferences.treeView', { defaultValue: 'Threaded tree view' })}
                                </Text>
                                <Text className="text-[13px] text-muted-foreground mt-0.5">
                                    {t('settings.threadPreferences.treeViewDesc', { defaultValue: 'Show replies in a threaded tree structure' })}
                                </Text>
                            </View>
                        </View>
                        <Toggle value={treeView} onValueChange={setTreeView} />
                    </View>
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
