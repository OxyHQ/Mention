import React from 'react';
import { StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { useAnimatedStyle, SharedValue } from 'react-native-reanimated';
import { useTheme } from '@/hooks/useTheme';

interface FloatingActionButtonProps {
    onPress: () => void;
    icon?: keyof typeof Ionicons.glyphMap;
    iconSize?: number;
    animatedTranslateY?: SharedValue<number>;
    style?: any;
}

export const FloatingActionButton: React.FC<FloatingActionButtonProps> = ({
    onPress,
    icon = 'add',
    iconSize = 24,
    animatedTranslateY,
    style,
}) => {
    const theme = useTheme();

    const fabAnimatedStyle = animatedTranslateY
        ? useAnimatedStyle(() => {
              return {
                  transform: [{ translateY: animatedTranslateY.value }],
              };
          })
        : undefined;

    // Check if custom style includes position - if so, don't apply default absolute positioning
    const hasCustomPosition = style && typeof style === 'object' && ('position' in style);
    const fabStyle = hasCustomPosition 
        ? [styles.fabBase, { backgroundColor: theme.colors.primary }, style]
        : [styles.fab, { backgroundColor: theme.colors.primary }, style];

    const fabContent = (
        <TouchableOpacity
            style={fabStyle}
            onPress={onPress}
            activeOpacity={0.8}
        >
            <Ionicons name={icon} size={iconSize} color={theme.colors.card} />
        </TouchableOpacity>
    );

    if (animatedTranslateY) {
        return <Animated.View style={fabAnimatedStyle}>{fabContent}</Animated.View>;
    }

    return fabContent;
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
    fab: {
        position: 'absolute',
        bottom: 24,
        right: 24,
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

