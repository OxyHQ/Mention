import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Pressable } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Toggle } from '@/components/Toggle';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { getData, storeData } from '@/utils/storage';
import { SettingsGroup } from '@/components/settings/SettingsItem';

const IconComponent = Ionicons as React.ComponentType<React.ComponentProps<typeof Ionicons>>;

type SortOrder = 'top' | 'oldest' | 'newest';

const SORT_OPTIONS: { value: SortOrder; labelKey: string; defaultLabel: string }[] = [
    { value: 'top', labelKey: 'settings.threadPreferences.sortTop', defaultLabel: 'Most liked' },
    { value: 'oldest', labelKey: 'settings.threadPreferences.sortOldest', defaultLabel: 'Oldest first' },
    { value: 'newest', labelKey: 'settings.threadPreferences.sortNewest', defaultLabel: 'Newest first' },
];

const STORAGE_KEY_SORT = 'pref:thread:sortOrder';
const STORAGE_KEY_TREE = 'pref:thread:treeView';

export default function ThreadPreferencesScreen() {
    const { t } = useTranslation();
    const { colors } = useTheme();
    const [sortOrder, setSortOrder] = useState<SortOrder>('top');
    const [treeView, setTreeView] = useState(false);

    useEffect(() => {
        let mounted = true;
        const load = async () => {
            const savedSort = await getData<SortOrder>(STORAGE_KEY_SORT);
            const savedTree = await getData<boolean>(STORAGE_KEY_TREE);
            if (!mounted) return;
            if (savedSort) setSortOrder(savedSort);
            if (typeof savedTree === 'boolean') setTreeView(savedTree);
        };
        load();
        return () => { mounted = false; };
    }, []);

    const onSortChange = useCallback(async (value: SortOrder) => {
        setSortOrder(value);
        await storeData(STORAGE_KEY_SORT, value);
    }, []);

    const onTreeToggle = useCallback(async (value: boolean) => {
        setTreeView(value);
        await storeData(STORAGE_KEY_TREE, value);
    }, []);

    return (
        <ThemedView className="flex-1">
            <Header
                options={{
                    title: t('settings.threadPreferences.title', { defaultValue: 'Thread preferences' }),
                    leftComponents: [
                        <IconButton variant="icon" key="back" onPress={() => router.back()}>
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
                            onPress={() => onSortChange(option.value)}
                        >
                            <View className="flex-row items-center gap-3">
                                <View className="w-7 items-center justify-center">
                                    <IconComponent
                                        name={
                                            option.value === 'top' ? 'trending-up' :
                                            option.value === 'oldest' ? 'time-outline' :
                                            'arrow-down'
                                        }
                                        size={20}
                                        color={colors.textSecondary}
                                    />
                                </View>
                                <Text className="text-[15px] font-medium text-foreground">
                                    {t(option.labelKey, { defaultValue: option.defaultLabel })}
                                </Text>
                            </View>
                            <View
                                className={`w-5 h-5 rounded-full border-2 items-center justify-center ${
                                    sortOrder === option.value ? 'border-primary bg-primary' : 'border-border'
                                }`}
                            >
                                {sortOrder === option.value ? (
                                    <View className="w-2 h-2 rounded-full bg-white" />
                                ) : null}
                            </View>
                        </Pressable>
                    ))}
                </SettingsGroup>

                {/* Tree view */}
                <SettingsGroup title={t('settings.threadPreferences.display', { defaultValue: 'Display' })}>
                    <View className="px-4 py-3.5 flex-row items-center justify-between">
                        <View className="flex-row items-center gap-3 flex-1 mr-3">
                            <View className="w-7 items-center justify-center">
                                <IconComponent name="git-branch-outline" size={20} color={colors.textSecondary} />
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
                        <Toggle value={treeView} onValueChange={onTreeToggle} />
                    </View>
                </SettingsGroup>
            </ScrollView>
        </ThemedView>
    );
}
