import React from 'react';
import { StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, SharedValue } from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';
import { useKeyboardVisibility } from '@/hooks/useKeyboardVisibility';
import { Z_INDEX } from '@/lib/constants';

interface FloatingActionButtonProps {
    onPress: () => void;
    icon?: keyof typeof Ionicons.glyphMap;
    customIcon?: React.ReactNode;
    iconSize?: number;
    animatedTranslateY?: SharedValue<number>;
    animatedOpacity?: SharedValue<number>;
    style?: any;
    bottomOffset?: number; // Optional custom bottom offset (overrides auto-detection)
}

export const FloatingActionButton: React.FC<FloatingActionButtonProps> = ({
    onPress,
    icon = 'add',
    customIcon,
    iconSize = 24,
    animatedTranslateY,
    animatedOpacity,
    style,
    bottomOffset,
}) => {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const isScreenNotMobile = useIsScreenNotMobile();
    const keyboardVisible = useKeyboardVisibility();

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

    const fabAnimatedStyle = (animatedTranslateY || animatedOpacity)
        ? useAnimatedStyle(() => {
                const opacity = animatedOpacity ? animatedOpacity.value : 1;
                return {
                    transform: animatedTranslateY ? [{ translateY: animatedTranslateY.value }] : [],
                    opacity: opacity,
                };
            })
        : undefined;

    // Determine positioning styles - position above bottom bar or safe area
    // Bottom bar is visible when: !isScreenNotMobile && !keyboardVisible
    const bottomBarVisible = !isScreenNotMobile && !keyboardVisible;
    const bottomBarHeight = bottomBarVisible ? 60 : 0; // Bottom bar height (only if visible)
    const marginFromBottom = 16; // Space between FAB and bottom bar/safe area
    const defaultBottom = bottomOffset !== undefined 
        ? bottomOffset 
        : bottomBarHeight + insets.bottom + marginFromBottom;
    
    const positionStyles = hasCustomPosition 
        ? extractPositionStyles(style)
        : { 
            position: 'absolute' as const, 
            bottom: defaultBottom, 
            right: 24, 
            zIndex: Z_INDEX.FLOATING_ACTION_BUTTON
          };

    // Base FAB styles (visual only, no positioning)
    const baseFabStyle = styles.fabBase;
    const nonPositionStyles = hasCustomPosition ? extractNonPositionStyles(style) : {};

    // Create style without shadows when animating opacity to prevent artifacts
    const fabStyle = animatedOpacity 
        ? [baseFabStyle, { backgroundColor: theme.colors.primary }, nonPositionStyles, { elevation: 0, shadowOpacity: 0 }]
        : [baseFabStyle, { backgroundColor: theme.colors.primary }, nonPositionStyles];

    const fabContent = (
        <TouchableOpacity
            style={fabStyle}
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

    if (animatedTranslateY || animatedOpacity) {
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
        overflow: 'hidden', // Prevent any visual artifacts from showing through
        backgroundColor: 'transparent', // Ensure no background bleed
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
