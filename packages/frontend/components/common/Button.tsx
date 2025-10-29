import React from 'react';
import { TouchableOpacity, Text, StyleSheet, ViewStyle, TextStyle, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface ButtonProps {
    onPress: () => void;
    children: React.ReactNode;
    variant?: 'primary' | 'secondary';
    style?: ViewStyle;
    textStyle?: TextStyle;
    disabled?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
    onPress,
    children,
    variant = 'primary',
    style,
    textStyle,
    disabled = false,
}) => {
    const theme = useTheme();

    const buttonStyle = [
        styles.button,
        variant === 'primary' && { backgroundColor: theme.colors.primary },
        variant === 'secondary' && {
            backgroundColor: 'transparent',
            borderWidth: 1,
            borderColor: theme.colors.border,
        },
        disabled && styles.disabled,
        style,
    ];

    const textStyleCombined = [
        styles.buttonText,
        variant === 'primary' && { color: theme.colors.card },
        variant === 'secondary' && { color: theme.colors.text },
        textStyle,
    ];

    return (
        <TouchableOpacity
            style={buttonStyle}
            onPress={onPress}
            activeOpacity={0.8}
            disabled={disabled}
        >
            <Text style={textStyleCombined}>{children}</Text>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    button: {
        borderRadius: 20,
        paddingVertical: 8,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
        flexDirection: 'row',
    },
    buttonText: {
        fontSize: 15,
        fontWeight: Platform.OS === 'web' ? 'bold' : '600',
    },
    disabled: {
        opacity: 0.5,
    },
});
