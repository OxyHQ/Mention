import React from 'react';
import { RiArrowUpSLine, RiGitMergeLine, RiHeartLine } from '@oxy.so/bloom/icons';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Toggle } from '@/components/Toggle';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import type { BloomIcon } from '@/components/settings/RowIcon';
import { SORT_ICONS } from '@/components/settings/threadSortIcons';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';
import { useThreadPreferencesStore, SORT_OPTIONS, type VoteStyle } from '@/hooks/useThreadPreferences';

const VOTE_STYLE_OPTIONS: { value: VoteStyle; icon: BloomIcon; labelKey: string; defaultLabel: string }[] = [
    { value: 'heart', icon: RiHeartLine, labelKey: 'settings.threadPreferences.voteStyleHeart', defaultLabel: 'Heart' },
    { value: 'pill', icon: RiArrowUpSLine, labelKey: 'settings.threadPreferences.voteStylePill', defaultLabel: 'Up/down vote' },
];

export default function ThreadPreferencesScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    const { colors } = useTheme();
    // All three preferences live in the one store, which owns persistence — so
    // every row reads and writes the same value, with no local copy to sync.
    const { sortOrder, treeView, voteStyle, setSortOrder, setTreeView, setVoteStyle } =
        useThreadPreferencesStore();

    return (
        <View className="flex-1">
            <PageHeader title={t('settings.threadPreferences.title', { defaultValue: 'Thread preferences' })} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-screen-margin pt-4 pb-8"
                showsVerticalScrollIndicator={false}
            >
                {/* Sort replies */}
                <SettingsListGroup variant="filled" title={t('settings.threadPreferences.sortReplies', { defaultValue: 'Sort replies' })}>
                    {SORT_OPTIONS.map((option) => {
                        const SortIcon = SORT_ICONS[option.value];
                        return (
                            <Pressable
                                key={option.value}
                                className="px-4 py-3.5 flex-row items-center justify-between"
                                onPress={() => setSortOrder(option.value)}
                            >
                                <View className="flex-row items-center gap-3">
                                    <View className="w-7 items-center justify-center">
                                        <SortIcon width={20} height={20} fill={colors.textSecondary} />
                                    </View>
                                    <Text className="text-[15px] font-medium text-foreground">
                                        {t(option.labelKey, { defaultValue: option.defaultLabel })}
                                    </Text>
                                </View>
                                <RadioIndicator selected={sortOrder === option.value} />
                            </Pressable>
                        );
                    })}
                </SettingsListGroup>

                {/* Like style */}
                <SettingsListGroup variant="filled" title={t('settings.threadPreferences.likeStyle', { defaultValue: 'Like style' })}>
                    {VOTE_STYLE_OPTIONS.map((option) => (
                        <Pressable
                            key={option.value}
                            className="px-4 py-3.5 flex-row items-center justify-between"
                            onPress={() => setVoteStyle(option.value)}
                        >
                            <View className="flex-row items-center gap-3">
                                <View className="w-7 items-center justify-center">
                                    <option.icon width={20} height={20} fill={colors.textSecondary} />
                                </View>
                                <Text className="text-[15px] font-medium text-foreground">
                                    {t(option.labelKey, { defaultValue: option.defaultLabel })}
                                </Text>
                            </View>
                            <RadioIndicator selected={voteStyle === option.value} />
                        </Pressable>
                    ))}
                </SettingsListGroup>

                {/* Tree view */}
                <SettingsListGroup variant="filled" title={t('settings.threadPreferences.display', { defaultValue: 'Display' })}>
                    <View className="px-4 py-3.5 flex-row items-center justify-between">
                        <View className="flex-row items-center gap-3 flex-1 mr-3">
                            <View className="w-7 items-center justify-center">
                                <RiGitMergeLine width={20} height={20} fill={colors.textSecondary} />
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
                </SettingsListGroup>
            </ScrollView>
        </View>
    );
}
