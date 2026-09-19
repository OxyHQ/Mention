import React from 'react';
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiGitMergeLine } from '@oxy.so/bloom/icons/RiGitMergeLine';
import { RiHeartLine } from '@oxy.so/bloom/icons/RiHeartLine';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { View, ScrollView } from 'react-native';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Toggle } from '@/components/Toggle';
import { useTranslation } from 'react-i18next';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';
import { RowIcon, type BloomIcon } from '@/components/settings/RowIcon';
import { ThreadSortGroup } from '@/components/settings/ThreadSortGroup';
import { useThreadPreferencesStore, type VoteStyle } from '@/hooks/useThreadPreferences';

const VOTE_STYLE_OPTIONS: { value: VoteStyle; icon: BloomIcon; labelKey: string; defaultLabel: string }[] = [
    { value: 'heart', icon: RiHeartLine, labelKey: 'settings.threadPreferences.voteStyleHeart', defaultLabel: 'Heart' },
    { value: 'pill', icon: RiArrowUpSLine, labelKey: 'settings.threadPreferences.voteStylePill', defaultLabel: 'Up/down vote' },
];

export default function ThreadPreferencesScreen() {
    const { t } = useTranslation();
    const safeBack = useSafeBack();
    // All three preferences live in the one store, which owns persistence — so
    // every row reads and writes the same value, with no local copy to sync.
    const { treeView, voteStyle, setTreeView, setVoteStyle } = useThreadPreferencesStore();

    return (
        <View className="flex-1">
            <PageHeader title={t('settings.threadPreferences.title', { defaultValue: 'Thread preferences' })} onBack={() => safeBack()} backLabel={t('common.back', { defaultValue: 'Back' })} />

            <ScrollView
                className="flex-1"
                contentContainerClassName="px-screen-margin pt-4 pb-8"
                showsVerticalScrollIndicator={false}
            >
                <ThreadSortGroup
                    title={t('settings.threadPreferences.sortReplies', { defaultValue: 'Sort replies' })}
                />

                <SettingsListGroup title={t('settings.threadPreferences.likeStyle', { defaultValue: 'Like style' })}>
                    {VOTE_STYLE_OPTIONS.map((option) => (
                        <SettingsListItem
                            key={option.value}
                            icon={<RowIcon icon={option.icon} />}
                            title={t(option.labelKey, { defaultValue: option.defaultLabel })}
                            rightElement={<RadioIndicator selected={voteStyle === option.value} />}
                            showChevron={false}
                            onPress={() => setVoteStyle(option.value)}
                        />
                    ))}
                </SettingsListGroup>

                <SettingsListGroup title={t('settings.threadPreferences.display', { defaultValue: 'Display' })}>
                    <SettingsListItem
                        icon={<RowIcon icon={RiGitMergeLine} />}
                        title={t('settings.threadPreferences.treeView', { defaultValue: 'Threaded tree view' })}
                        description={t('settings.threadPreferences.treeViewDesc', { defaultValue: 'Show replies in a threaded tree structure' })}
                        rightElement={<Toggle value={treeView} onValueChange={setTreeView} />}
                    />
                </SettingsListGroup>
            </ScrollView>
        </View>
    );
}
