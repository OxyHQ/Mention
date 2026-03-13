import React, { memo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

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
        if (!showComposeButton || hideHeader) return null;

        return (
            <View className="bg-background">
                <TouchableOpacity
                    className="bg-surface border-border"
                    style={styles.composeButton}
                    onPress={onComposePress}
                    activeOpacity={0.7}
                    accessible={true}
                    accessibilityRole="button"
                    accessibilityLabel="Compose new post"
                    accessibilityHint="Opens the compose screen to create a new post"
                >
                    <Text
                        className="text-muted-foreground"
                        style={styles.composeButtonText}
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
        boxShadow: '0px 1px 2px 0px rgba(0, 0, 0, 0.05)',
        elevation: 1,
    },
    composeButtonText: {
        fontSize: 16,
        fontWeight: '400',
    },
});

