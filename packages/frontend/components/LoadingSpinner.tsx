/**
 * LoadingSpinner Component
 * 
 * Displays an animated loading spinner with optional text.
 * Used throughout the application to indicate loading states.
 * 
 * @module components/LoadingSpinner
 */

import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';

import { Loading } from '@/assets/icons/loading-icon';
import { useTheme } from '@/hooks/useTheme';

// ============================================================================
// Types
// ============================================================================

interface LoadingSpinnerProps {
    /** Size of the spinner in pixels */
    size?: number;
    /** Color of the spinner (defaults to theme primary) */
    color?: string;
    /** Optional text to display below spinner */
    text?: string;
    /** Custom style for the text */
    textStyle?: TextStyle;
    /** Custom style for the container */
    style?: ViewStyle;
    /** Whether to show text (default: true) */
    showText?: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_SIZE = 24;
const TEXT_MARGIN_TOP = 8;
const TEXT_FONT_SIZE = 14;
const TEXT_FONT_FAMILY = 'Inter-Medium';

// ============================================================================
// Component
// ============================================================================

/**
 * LoadingSpinner Component
 * 
 * Renders an animated loading spinner with optional text label.
 * Automatically uses theme colors if no color prop is provided.
 * 
 * @param props - Component props
 * @returns The loading spinner component
 */
const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
    size = DEFAULT_SIZE,
    color,
    text,
    textStyle,
    style,
    showText = true,
}) => {
    const theme = useTheme();

    // ========================================================================
    // Memoized Values
    // ========================================================================

    /**
     * Spinner color - uses provided color or theme primary
     */
    const spinnerColor = useMemo(
        () => color ?? theme.colors.primary,
        [color, theme.colors.primary],
    );

    /**
     * Text color - uses provided color or theme secondary text
     */
    const textColor = useMemo(
        () => color ?? theme.colors.textSecondary,
        [color, theme.colors.textSecondary],
    );

    /**
     * Text style with theme color
     */
    const computedTextStyle = useMemo<TextStyle[]>(
        () => [styles.text, { color: textColor }, textStyle],
        [textColor, textStyle],
    );

    // ========================================================================
    // Render
    // ========================================================================

    return (
        <View style={[styles.container, style]}>
            <Loading
                size={size}
                color={spinnerColor}
            />
            {showText && text && (
                <Text style={computedTextStyle}>
                    {text}
                </Text>
            )}
        </View>
    );
};

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    text: {
        marginTop: TEXT_MARGIN_TOP,
        fontSize: TEXT_FONT_SIZE,
        fontFamily: TEXT_FONT_FAMILY,
        textAlign: 'center',
    },
});

// ============================================================================
// Exports
// ============================================================================

export default React.memo(LoadingSpinner);
