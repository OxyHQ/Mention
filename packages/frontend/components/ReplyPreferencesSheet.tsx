import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Toggle } from '@/components/Toggle';
import { SettingsGroup } from '@/components/settings/SettingsItem';
import {
    useThreadPreferencesStore,
    type SortOrder,
} from '@/hooks/useThreadPreferences';

const IconComponent = Ionicons as React.ComponentType<React.ComponentProps<typeof Ionicons>>;

const SORT_OPTIONS: { value: SortOrder; icon: string; labelKey: string; defaultLabel: string }[] = [
    { value: 'top', icon: 'trending-up', labelKey: 'replyPreferences.sortTop', defaultLabel: 'Top replies first' },
    { value: 'oldest', icon: 'time-outline', labelKey: 'replyPreferences.sortOldest', defaultLabel: 'Oldest replies first' },
    { value: 'newest', icon: 'arrow-down', labelKey: 'replyPreferences.sortNewest', defaultLabel: 'Newest replies first' },
];

function RadioIndicator({ selected }: { selected: boolean }) {
    return (
        <View
            className={`w-5 h-5 rounded-full border-2 items-center justify-center ${
                selected ? 'border-primary bg-primary' : 'border-border'
            }`}
        >
            {selected ? <View className="w-2 h-2 rounded-full bg-white" /> : null}
        </View>
    );
}

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
            <SettingsGroup title={t('replyPreferences.showRepliesAs', { defaultValue: 'Show replies as' })}>
                <Pressable
                    className="px-4 py-3.5 flex-row items-center justify-between"
                    onPress={() => setTreeView(false)}
                >
                    <View className="flex-row items-center gap-3">
                        <View className="w-7 items-center justify-center">
                            <IconComponent name="list-outline" size={20} color={colors.textSecondary} />
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
                            <IconComponent name="git-branch-outline" size={20} color={colors.textSecondary} />
                        </View>
                        <Text className="text-[15px] font-medium text-foreground">
                            {t('replyPreferences.threaded', { defaultValue: 'Threaded' })}
                        </Text>
                    </View>
                    <RadioIndicator selected={treeView} />
                </Pressable>
            </SettingsGroup>

            {/* Reply sorting */}
            <SettingsGroup title={t('replyPreferences.replySorting', { defaultValue: 'Reply sorting' })}>
                {SORT_OPTIONS.map((option) => (
                    <Pressable
                        key={option.value}
                        className="px-4 py-3.5 flex-row items-center justify-between"
                        onPress={() => setSortOrder(option.value)}
                    >
                        <View className="flex-row items-center gap-3">
                            <View className="w-7 items-center justify-center">
                                <IconComponent
                                    name={option.icon as React.ComponentProps<typeof Ionicons>['name']}
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
        </ScrollView>
    );
}
