/**
 * SessionSwitcherButton Component
 * 
 * A button component that opens the SessionSwitcher in a bottom sheet.
 * This is a simple example of how to use the SessionSwitcher.
 */

import React, { useContext } from 'react';
import { TouchableOpacity, Text, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { bottomSheetState } from './context/BottomSheetContainer';
import { SessionSwitcher } from './SessionSwitcher';
import { colors } from '../styles/colors';
import { useSession } from '../hooks/useSession';
import { BottomSheetContext } from '@/context/BottomSheetContext';

interface SessionSwitcherButtonProps {
    label?: string;
    showIcon?: boolean;
    style?: any;
    textStyle?: any;
}

export function SessionSwitcherButton({
    label = 'Switch Account',
    showIcon = true,
    style,
    textStyle
}: SessionSwitcherButtonProps) {
    const { state } = useSession();
    const { setBottomSheetContent, openBottomSheet } = useContext(BottomSheetContext);

    const handlePress = () => {
        // Open the session switcher in the bottom sheet
        // Use the BottomSheetContext directly for better integration
        setBottomSheetContent(
            <SessionSwitcher
                onClose={() => {
                    openBottomSheet(false);
                }}
            />
        );
        openBottomSheet(true);
    };

    return (
        <TouchableOpacity
            style={[styles.button, style]}
            onPress={handlePress}
            accessibilityLabel={label}
            accessibilityRole="button"
        >
            {showIcon && (
                <Ionicons
                    name="people-outline"
                    size={20}
                    color={colors.primaryColor}
                    style={styles.icon}
                />
            )}
            <Text style={[styles.text, textStyle]}>{label}</Text>
        </TouchableOpacity>
    );
}

const styles = StyleSheet.create({
    button: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        borderRadius: 8,
        backgroundColor: colors.primaryLight,
    },
    icon: {
        marginRight: 8,
    },
    text: {
        fontSize: 16,
        color: colors.primaryColor,
        fontWeight: '500',
    },
}); 