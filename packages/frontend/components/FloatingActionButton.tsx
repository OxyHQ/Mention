import React from 'react';
import { StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, SharedValue } from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';

interface FloatingActionButtonProps {
    onPress: () => void;
    icon?: keyof typeof Ionicons.glyphMap;
    customIcon?: React.ReactNode;
    iconSize?: number;
    animatedTranslateY?: SharedValue<number>;
    style?: any;
}

export const FloatingActionButton: React.FC<FloatingActionButtonProps> = ({
    onPress,
    icon = 'add',
    customIcon,
    iconSize = 24,
    animatedTranslateY,
    style,
}) => {
    const theme = useTheme();

    // Check if custom style includes position
    const hasCustomPosition = style && typeof style === 'object' && ('position' in style);
    
    // Extract positioning styles (position, bottom, right, left, top, zIndex)
    const extractPositionStyles = (styleObj: any) => {
        if (!styleObj || typeof styleObj !== 'object') return {};
        // Handle both object and array of styles
        const styles = Array.isArray(styleObj) ? styleObj : [styleObj];
        const merged = Object.assign({}, ...styles.filter(s => s && typeof s === 'object'));
        const { position, bottom, right, left, top, zIndex } = merged;
        return { position, bottom, right, left, top, zIndex };
    };

    // Extract non-positioning styles (everything except position-related)
    const extractNonPositionStyles = (styleObj: any) => {
        if (!styleObj || typeof styleObj !== 'object') return {};
        // Handle both object and array of styles
        const styles = Array.isArray(styleObj) ? styleObj : [styleObj];
        const merged = Object.assign({}, ...styles.filter(s => s && typeof s === 'object'));
        const { position, bottom, right, left, top, zIndex, ...rest } = merged;
        return rest;
    };

    const fabAnimatedStyle = animatedTranslateY
        ? useAnimatedStyle(() => {
              return {
                  transform: [{ translateY: animatedTranslateY.value }],
              };
          })
        : undefined;

    // Determine positioning styles
    const positionStyles = hasCustomPosition 
        ? extractPositionStyles(style)
        : { position: 'absolute' as const, bottom: 24, right: 24, zIndex: 1000 };

    // Base FAB styles (visual only, no positioning)
    const baseFabStyle = styles.fabBase;
    const nonPositionStyles = hasCustomPosition ? extractNonPositionStyles(style) : {};

    const fabContent = (
        <TouchableOpacity
            style={[baseFabStyle, { backgroundColor: theme.colors.primary }, nonPositionStyles]}
            onPress={onPress}
            activeOpacity={0.8}
        >
            {customIcon ? (
                customIcon
            ) : (
                <Ionicons name={icon} size={iconSize} color={theme.colors.card} />
            )}
        </TouchableOpacity>
    );

    if (animatedTranslateY) {
        // When animating, wrap in Animated.View and apply positioning to wrapper
        return (
            <Animated.View style={[positionStyles, fabAnimatedStyle]}>
                {fabContent}
            </Animated.View>
        );
    }

    // When not animating, apply positioning directly to TouchableOpacity
    return (
        <TouchableOpacity
            style={[baseFabStyle, { backgroundColor: theme.colors.primary }, positionStyles, nonPositionStyles]}
            onPress={onPress}
            activeOpacity={0.8}
        >
            {customIcon ? (
                customIcon
            ) : (
                <Ionicons name={icon} size={iconSize} color={theme.colors.card} />
            )}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    fabBase: {
        width: 56,
        height: 56,
        borderRadius: 28,
        justifyContent: 'center',
        alignItems: 'center',
        elevation: 8,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        ...Platform.select({
            ios: {
                shadowColor: '#000',
            },
            android: {
                shadowColor: '#000',
            },
        }),
    },
});
