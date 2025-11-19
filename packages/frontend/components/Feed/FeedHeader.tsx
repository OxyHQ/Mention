import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { flattenStyleArray } from '@/utils/theme';

interface FeedHeaderProps {
    showComposeButton?: boolean;
    onComposePress?: () => void;
    hideHeader?: boolean;
}

/**
 * Feed header component
 * Displays compose button when enabled
 */
export const FeedHeader = memo<FeedHeaderProps>(
    ({ showComposeButton, onComposePress, hideHeader }) => {
        const theme = useTheme();

        if (!showComposeButton || hideHeader) return null;

        return (
            <View
                style={flattenStyleArray([
                    { backgroundColor: theme.colors.background },
                ])}
            >
                <TouchableOpacity
                    style={flattenStyleArray([
                        styles.composeButton,
                        {
                            backgroundColor: theme.colors.backgroundSecondary,
                            borderColor: theme.colors.border,
                            shadowColor: theme.colors.shadow,
                        },
                    ])}
                    onPress={onComposePress}
                    activeOpacity={0.7}
                    accessible={true}
                    accessibilityRole="button"
                    accessibilityLabel="Compose new post"
                    accessibilityHint="Opens the compose screen to create a new post"
                >
                    <Text
                        style={flattenStyleArray([
                            styles.composeButtonText,
                            { color: theme.colors.textSecondary },
                        ])}
                    >
                        What&apos;s happening?
                    </Text>
                </TouchableOpacity>
            </View>
        );
    }
);

FeedHeader.displayName = 'FeedHeader';

const styles = StyleSheet.create({
    composeButton: {
        marginHorizontal: 16,
        marginVertical: 12,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.05,
        shadowRadius: 2,
        elevation: 1,
    },
    composeButtonText: {
        fontSize: 16,
        fontWeight: '400',
    },
});

