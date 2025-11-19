import React from 'react';
import { View, StyleSheet, ViewStyle, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from './ThemedText';
import Avatar from './Avatar';

/**
 * ListCard Component
 * 
 * A card component for displaying user lists (e.g., moderation lists, curated lists).
 * Reused from social-app and simplified for Mention's needs.
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
}

interface ListCardProps {
    list: ListCardData;
    onPress?: () => void;
    showPinButton?: boolean;
    style?: ViewStyle;
}

/**
 * Main ListCard component
 */
export function ListCard({
    list,
    onPress,
    showPinButton = false,
    style,
}: ListCardProps) {
    const router = useRouter();
    const theme = useTheme();

    const handlePress = () => {
        if (onPress) {
            onPress();
        } else {
            // Navigate to list detail page if route exists
            // router.push(`/lists/${list.id}`);
        }
    };

    const purposeLabel = list.purpose === 'modlist'
        ? 'Moderation list'
        : 'List';

    return (
        <TouchableOpacity
            onPress={handlePress}
            activeOpacity={0.7}
            style={[
                styles.outer,
                {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                },
                style,
            ]}>
            <View style={styles.header}>
                <Avatar
                    source={list.avatar || undefined}
                    size={40}
                />
                <View style={styles.titleContainer}>
                    <ThemedText
                        style={styles.title}
                        numberOfLines={1}>
                        {list.name}
                    </ThemedText>
                    {list.creator && (
                        <ThemedText
                            style={[
                                styles.byline,
                                { color: theme.colors.textSecondary },
                            ]}
                            numberOfLines={1}>
                            {purposeLabel} by @{list.creator.username}
                        </ThemedText>
                    )}
                </View>
                {showPinButton && (
                    <View style={styles.pinButtonContainer}>
                        {/* Pin button can be added here if needed */}
                    </View>
                )}
            </View>
            {list.description && (
                <View style={styles.description}>
                    <ThemedText
                        style={[
                            styles.descriptionText,
                            { color: theme.colors.textSecondary },
                        ]}
                        numberOfLines={3}>
                        {list.description}
                    </ThemedText>
                </View>
            )}
            {list.itemCount !== undefined && (
                <View style={styles.itemCount}>
                    <ThemedText
                        style={[
                            styles.itemCountText,
                            { color: theme.colors.textSecondary },
                        ]}>
                        {list.itemCount} {list.itemCount === 1 ? 'item' : 'items'}
                    </ThemedText>
                </View>
            )}
        </TouchableOpacity>
    );
}

/**
 * Outer container
 */
export function ListCardOuter({
    children,
    style,
}: {
    children: React.ReactNode;
    style?: ViewStyle;
}) {
    return <View style={[styles.outerContainer, style]}>{children}</View>;
}

/**
 * Header section
 */
export function ListCardHeader({
    children,
    style,
}: {
    children: React.ReactNode;
    style?: ViewStyle;
}) {
    return <View style={[styles.header, style]}>{children}</View>;
}

const styles = StyleSheet.create({
    outerContainer: {
        width: '100%',
        gap: 12,
    },
    outer: {
        width: '100%',
        padding: 16,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        gap: 12,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    titleContainer: {
        flex: 1,
        gap: 4,
    },
    title: {
        fontSize: 16,
        fontWeight: '600',
        lineHeight: 20,
    },
    byline: {
        fontSize: 14,
        lineHeight: 18,
    },
    description: {
        marginTop: 4,
    },
    descriptionText: {
        fontSize: 14,
        lineHeight: 20,
    },
    itemCount: {
        marginTop: 4,
    },
    itemCountText: {
        fontSize: 14,
        fontWeight: '600',
    },
    pinButtonContainer: {
        minWidth: 80,
        alignItems: 'flex-end',
    },
});

