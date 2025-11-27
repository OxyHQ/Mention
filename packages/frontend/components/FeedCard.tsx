import React from 'react';
import { View, StyleSheet, ViewStyle, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from './ThemedText';
import Avatar from './Avatar';

/**
 * FeedCard Component
 * 
 * A card component for displaying feed/algorithm generators in lists.
 * Reused from social-app and simplified for Mention's needs.
 */

export interface FeedCardData {
    id: string;
    uri: string;
    displayName: string;
    description?: string;
    avatar?: string | null;
    creator?: {
        username: string;
        displayName?: string;
        avatar?: string;
    };
    likeCount?: number;
    subscriberCount?: number;
}

interface FeedCardProps {
    feed: FeedCardData;
    onPress?: () => void;
    headerRight?: React.ReactNode;
    style?: ViewStyle;
}

/**
 * Main FeedCard component
 */
export function FeedCard({
    feed,
    onPress,
    headerRight,
    style,
}: FeedCardProps) {
    const router = useRouter();
    const theme = useTheme();

    const handlePress = () => {
        if (onPress) {
            onPress();
        }
    };

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
                    source={feed.avatar || undefined}
                    size={40}
                />
                <View style={styles.titleContainer}>
                    <ThemedText
                        style={styles.title}
                        numberOfLines={1}>
                        {feed.displayName}
                    </ThemedText>
                    {feed.creator && (
                        <ThemedText
                            style={[
                                styles.byline,
                                { color: theme.colors.textSecondary },
                            ]}
                            numberOfLines={1}>
                            Feed by @{feed.creator.username}
                        </ThemedText>
                    )}
                </View>
                {headerRight && (
                    <View style={styles.headerRight}>
                        {headerRight}
                    </View>
                )}
            </View>
            {feed.description && (
                <View style={styles.description}>
                    <ThemedText
                        style={[
                            styles.descriptionText,
                            { color: theme.colors.textSecondary },
                        ]}
                        numberOfLines={3}>
                        {feed.description}
                    </ThemedText>
                </View>
            )}
            {feed.likeCount !== undefined && feed.likeCount > 0 && (
                <View style={styles.likes}>
                    <ThemedText
                        style={[
                            styles.likesText,
                            { color: theme.colors.textSecondary },
                        ]}>
                        Liked by {feed.likeCount} {feed.likeCount === 1 ? 'user' : 'users'}
                    </ThemedText>
                </View>
            )}
        </TouchableOpacity>
    );
}

/**
 * Outer container
 */
export function FeedCardOuter({
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
export function FeedCardHeader({
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
    likes: {
        marginTop: 4,
    },
    likesText: {
        fontSize: 14,
        fontWeight: '600',
    },
    headerRight: {
        alignItems: 'flex-end',
    },
});

