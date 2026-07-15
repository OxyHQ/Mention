import React from 'react';
import { View, StyleSheet } from 'react-native';
import { PressableScale } from '@oxyhq/bloom/pressable-scale';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ThemedText } from './ThemedText';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';
import { cn } from '@/lib/utils';

/**
 * ListCard Component
 *
 * A component for displaying user lists (e.g., moderation lists, curated lists).
 *
 * Two visual languages, picked with `variant`:
 * - `card` (default): a bordered, rounded surface — for standalone list grids.
 * - `row`: a flush, full-width feed row (bottom hairline, no radius) — for result
 *   lists that must share ONE visual language with the feed (search).
 */

export interface ListCardData {
    id: string;
    uri: string;
    name: string;
    description?: string;
    avatar?: string | null;
    creator?: {
        username: string;
        displayName?: string;
        avatar?: string;
    };
    purpose?: 'curatelist' | 'modlist';
    itemCount?: number;
    subscriberCount?: number;
}

export type ListCardVariant = 'card' | 'row';

interface ListCardProps {
    list: ListCardData;
    onPress?: () => void;
    showPinButton?: boolean;
    variant?: ListCardVariant;
}

/**
 * Main ListCard component
 */
export function ListCard({
    list,
    onPress,
    showPinButton = false,
    variant = 'card',
}: ListCardProps) {
    const router = useRouter();
    const { t } = useTranslation();
    const isRow = variant === 'row';

    const handlePress = () => {
        if (onPress) {
            onPress();
        } else if (list.id) {
            router.push(`/lists/${list.id}`);
        }
    };

    const purposeLabel = list.purpose === 'modlist'
        ? 'Moderation list'
        : 'List';

    return (
        <PressableScale
            onPress={handlePress}
            className={cn(
                'w-full',
                isRow
                    ? 'px-3 py-3 gap-1 border-b border-border'
                    : 'bg-card border-border p-4 rounded-xl gap-3',
            )}
            style={isRow ? undefined : { borderWidth: StyleSheet.hairlineWidth }}>
            <View className="flex-row items-center gap-3">
                <Avatar
                    source={list.avatar || undefined}
                    size={40}
                    variant={MEDIA_VARIANT_AVATAR}
                />
                <View className="flex-1 gap-1">
                    <ThemedText
                        className="text-base font-semibold leading-5"
                        numberOfLines={1}>
                        {list.name}
                    </ThemedText>
                    {list.creator && (
                        <ThemedText
                            className="text-muted-foreground text-sm leading-[18px]"
                            numberOfLines={1}>
                            {purposeLabel} by @{list.creator.username}
                        </ThemedText>
                    )}
                </View>
                {showPinButton && (
                    <View className="items-end min-w-[80px]">
                        {/* Pin button can be added here if needed */}
                    </View>
                )}
            </View>
            {list.description && (
                <ThemedText
                    className={cn('text-muted-foreground text-sm leading-5', !isRow && 'mt-1')}
                    numberOfLines={isRow ? 2 : 3}>
                    {list.description}
                </ThemedText>
            )}
            {(list.itemCount !== undefined || list.subscriberCount !== undefined) && (
                <View className={cn('flex-row items-center gap-3', !isRow && 'mt-1')}>
                    {list.itemCount !== undefined && (
                        <ThemedText className="text-muted-foreground text-sm font-semibold">
                            {list.itemCount} {list.itemCount === 1 ? 'item' : 'items'}
                        </ThemedText>
                    )}
                    {list.subscriberCount !== undefined && (
                        <ThemedText className="text-muted-foreground text-sm font-semibold">
                            {t('lists.subscriberCount', {
                                count: list.subscriberCount,
                                defaultValue: '{{count}} subscribers',
                            })}
                        </ThemedText>
                    )}
                </View>
            )}
        </PressableScale>
    );
}
