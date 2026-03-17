import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/lib/icons';
import { RadioIndicator } from '@/components/ui/RadioIndicator';
import { SettingsGroup } from '@/components/settings/SettingsItem';
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
            <SettingsGroup title={t('replyPreferences.showRepliesAs', { defaultValue: 'Show replies as' })}>
                <Pressable
                    className="px-4 py-3.5 flex-row items-center justify-between"
                    onPress={() => setTreeView(false)}
                >
                    <View className="flex-row items-center gap-3">
                        <View className="w-7 items-center justify-center">
                            <Icon name="list-outline" size={20} color={colors.textSecondary} />
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
                            <Icon name="git-branch-outline" size={20} color={colors.textSecondary} />
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
        </ScrollView>
    );
}
