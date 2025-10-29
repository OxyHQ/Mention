import React from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import { Loading } from '@/assets/icons/loading-icon';
import { colors } from '@/styles/colors';
import { useTheme } from '@/hooks/useTheme';

interface LoadingSpinnerProps {
    size?: number;
    color?: string;
    text?: string;
    textStyle?: TextStyle;
    style?: ViewStyle;
    showText?: boolean;
}

const LoadingSpinner: React.FC<LoadingSpinnerProps> = ({
    size = 24,
    color,
    text,
    textStyle,
    style,
    showText = true,
}) => {
    const theme = useTheme();
    const spinnerColor = color || theme.colors.primary;
    const textColor = color || theme.colors.textSecondary;

    return (
        <View style={[styles.container, style]}>
            <Loading size={size} color={spinnerColor} />
            {showText && text && <Text style={[styles.text, { color: textColor }, textStyle]}>{text}</Text>}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    text: {
        marginTop: 8,
        fontSize: 14,
        fontFamily: 'Inter-Medium',
        textAlign: 'center',
    },
});

export default React.memo(LoadingSpinner);
