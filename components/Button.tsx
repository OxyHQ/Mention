import { colors } from '@/styles/colors';
import React from 'react';
import { StyleSheet, ViewStyle, TouchableOpacity, Text } from 'react-native';

interface ButtonProps {
    onPress: () => void;
    onLongPress?: () => void;
    children: React.ReactNode;
    disabled?: boolean;
    style?: React.CSSProperties | ViewStyle;
    className?: string;
}

const Button: React.FC<ButtonProps> = ({ onPress, onLongPress, children, disabled = false, style, className }) => {
    return (
        <TouchableOpacity onPress={onPress} onLongPress={onLongPress} disabled={disabled} className={className} style={[styles.button, style]}>
            <Text style={styles.buttonText}>{children}</Text>
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    button: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: colors.primaryColor,
        color: colors.primaryLight,
        borderRadius: 35,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonText: {
        color: colors.primaryLight,
        fontSize: 16,
        fontWeight: '600',
    },
});

export default Button;