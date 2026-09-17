import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { useTranslation } from 'react-i18next';
import { RiListUnordered, RiNodeTree } from '@oxy.so/bloom/icons';
import { SORT_ICONS } from '@/components/settings/threadSortIcons';
import { RadioIndicator } from '@oxy.so/bloom/radio-indicator';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import {
    useThreadPreferencesStore,
    SORT_OPTIONS,
} from '@/hooks/useThreadPreferences';

export default function ReplyPreferencesSheet() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const { treeView, sortOrder, setTreeView, setSortOrder } = useThreadPreferencesStore();

    return (
        <ScrollView
            contentContainerClassName="px-4 pt-2 pb-8"
            showsVerticalScrollIndicator={false}
        >
            {/* Show replies as */}
            <SettingsListGroup title={t('replyPreferences.showRepliesAs', { defaultValue: 'Show replies as' })}>
                <Pressable
                    className="px-4 py-3.5 flex-row items-center justify-between"
                    onPress={() => setTreeView(false)}
                >
                    <View className="flex-row items-center gap-3">
                        <View className="w-7 items-center justify-center">
                            <RiListUnordered size="md" fill={colors.textSecondary} />
                        </View>
                        <Text className="text-[15px] font-medium text-foreground">
                            {t('replyPreferences.linear', { defaultValue: 'Linear' })}
                        </Text>
                    </View>
                    <RadioIndicator selected={!treeView} />
                </Pressable>
                <Pressable
                    className="px-4 py-3.5 flex-row items-center justify-between"
                    onPress={() => setTreeView(true)}
                >
                    <View className="flex-row items-center gap-3">
                        <View className="w-7 items-center justify-center">
                            <RiNodeTree size="md" fill={colors.textSecondary} />
                        </View>
                        <Text className="text-[15px] font-medium text-foreground">
                            {t('replyPreferences.threaded', { defaultValue: 'Threaded' })}
                        </Text>
                    </View>
                    <RadioIndicator selected={treeView} />
                </Pressable>
            </SettingsListGroup>

            {/* Reply sorting */}
            <SettingsListGroup title={t('replyPreferences.replySorting', { defaultValue: 'Reply sorting' })}>
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
                                    <SortIcon size="md" fill={colors.textSecondary} />
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
        </ScrollView>
    );
}
