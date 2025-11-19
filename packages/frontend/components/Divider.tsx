import React from 'react';
import { View, StyleSheet, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface DividerProps {
    style?: ViewStyle;
}

/**
 * Divider Component
 * 
 * A simple horizontal divider line component.
 * Reused from social-app and adapted for Mention's theme system.
 */
export function Divider({ style }: DividerProps) {
    const theme = useTheme();

    return (
        <View
            style={[
                styles.divider,
                {
                    borderTopColor: theme.colors.border,
                },
                style,
            ]}
        />
    );
}

const styles = StyleSheet.create({
    divider: {
        width: '100%',
        borderTopWidth: 1,
    },
});

