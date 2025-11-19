import React, { useCallback } from 'react';
import {
    View,
    StyleSheet,
    ViewStyle,
    TextStyle,
    Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';
import { ThemedText } from './ThemedText';
import { TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Layout Header Component
 * 
 * A flexible header component based on social-app's Layout.Header pattern.
 * Reused and adapted for Mention's theme system.
 */

interface HeaderOuterProps {
    children: React.ReactNode;
    noBottomBorder?: boolean;
    sticky?: boolean;
    style?: ViewStyle;
}

/**
 * Outer container for header - provides layout and styling
 */
export function HeaderOuter({
    children,
    noBottomBorder = false,
    sticky = true,
    style,
}: HeaderOuterProps) {
    const theme = useTheme();

    return (
        <View
            style={[
                styles.outer,
                {
                    backgroundColor: theme.colors.background,
                    borderBottomColor: theme.colors.border,
                    borderBottomWidth: noBottomBorder ? 0 : StyleSheet.hairlineWidth,
                    ...(sticky && Platform.OS === 'web' && {
                        position: 'sticky' as const,
                        top: 0,
                        zIndex: 100,
                    }),
                },
                style,
            ]}>
            {children}
        </View>
    );
}

interface HeaderContentProps {
    children?: React.ReactNode;
    align?: 'left' | 'center';
}

/**
 * Content area in header - contains title/subtitle
 */
export function HeaderContent({
    children,
    align = 'left',
}: HeaderContentProps) {
    return (
        <View
            style={[
                styles.content,
                {
                    alignItems: align === 'center' ? 'center' : 'flex-start',
                },
            ]}>
            {children}
        </View>
    );
}

interface HeaderSlotProps {
    children?: React.ReactNode;
    style?: ViewStyle;
}

/**
 * Slot for buttons/icons on the sides of header
 */
export function HeaderSlot({ children, style }: HeaderSlotProps) {
    return (
        <View style={[styles.slot, style]}>
            {children}
        </View>
    );
}

interface HeaderBackButtonProps {
    onPress?: () => void;
    style?: ViewStyle;
}

/**
 * Back button component
 */
export function HeaderBackButton({
    onPress,
    style,
}: HeaderBackButtonProps) {
    const router = useRouter();
    const theme = useTheme();

    const handlePress = useCallback(() => {
        if (onPress) {
            onPress();
        } else if (router.canGoBack()) {
            router.back();
        }
    }, [onPress, router]);

    return (
        <HeaderSlot>
            <TouchableOpacity
                onPress={handlePress}
                style={[styles.backButton, style]}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons
                    name="arrow-back"
                    size={24}
                    color={theme.colors.text}
                />
            </TouchableOpacity>
        </HeaderSlot>
    );
}

interface HeaderTitleTextProps {
    children: React.ReactNode;
    style?: TextStyle;
}

/**
 * Title text component
 */
export function HeaderTitleText({
    children,
    style,
}: HeaderTitleTextProps) {
    return (
        <ThemedText
            style={[
                styles.titleText,
                style,
            ]}>
            {children}
        </ThemedText>
    );
}

interface HeaderSubtitleTextProps {
    children: React.ReactNode;
    style?: TextStyle;
}

/**
 * Subtitle text component
 */
export function HeaderSubtitleText({
    children,
    style,
}: HeaderSubtitleTextProps) {
    const theme = useTheme();

    return (
        <ThemedText
            style={[
                styles.subtitleText,
                { color: theme.colors.textSecondary },
                style,
            ]}>
            {children}
        </ThemedText>
    );
}

const styles = StyleSheet.create({
    outer: {
        width: '100%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
        minHeight: Platform.select({
            ios: 48,
            default: 52,
        }),
        paddingVertical: 8,
    },
    content: {
        flex: 1,
        justifyContent: 'center',
        minHeight: 40,
    },
    slot: {
        width: 40,
        alignItems: 'center',
        justifyContent: 'center',
    },
    backButton: {
        padding: 4,
        borderRadius: 8,
    },
    titleText: {
        fontSize: Platform.select({
            ios: 17,
            default: 18,
            web: 20,
        }),
        fontWeight: '700',
        lineHeight: 22,
    },
    subtitleText: {
        fontSize: 14,
        lineHeight: 18,
        marginTop: 2,
    },
});

// Compound component pattern - export as Header object
export const Header = {
    Outer: HeaderOuter,
    Content: HeaderContent,
    Slot: HeaderSlot,
    BackButton: HeaderBackButton,
    TitleText: HeaderTitleText,
    SubtitleText: HeaderSubtitleText,
};

