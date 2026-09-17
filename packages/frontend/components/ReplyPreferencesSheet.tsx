import React from 'react';
import { ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiListUnordered, RiNodeTree } from '@oxy.so/bloom/icons';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { RowIcon } from '@/components/settings/RowIcon';
import { ThreadSortGroup } from '@/components/settings/ThreadSortGroup';
import { useThreadPreferencesStore } from '@/hooks/useThreadPreferences';

export default function ReplyPreferencesSheet() {
    const { t } = useTranslation();
    const treeView = useThreadPreferencesStore((state) => state.treeView);
    const setTreeView = useThreadPreferencesStore((state) => state.setTreeView);

    return (
        <ScrollView
            contentContainerClassName="px-4 pt-2 pb-8"
            showsVerticalScrollIndicator={false}
        >
            <SettingsListGroup title={t('replyPreferences.showRepliesAs', { defaultValue: 'Show replies as' })}>
                <SettingsListItem
                    icon={<RowIcon icon={RiListUnordered} />}
                    title={t('replyPreferences.linear', { defaultValue: 'Linear' })}
                    rightElement={<RadioIndicator selected={!treeView} />}
                    showChevron={false}
                    onPress={() => setTreeView(false)}
                />
                <SettingsListItem
                    icon={<RowIcon icon={RiNodeTree} />}
                    title={t('replyPreferences.threaded', { defaultValue: 'Threaded' })}
                    rightElement={<RadioIndicator selected={treeView} />}
                    showChevron={false}
                    onPress={() => setTreeView(true)}
                />
            </SettingsListGroup>

            <ThreadSortGroup title={t('replyPreferences.replySorting', { defaultValue: 'Reply sorting' })} />
        </ScrollView>
    );
}
