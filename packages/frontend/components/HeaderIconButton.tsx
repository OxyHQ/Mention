import React from 'react';
import { TouchableOpacity, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface HeaderIconButtonProps {
    onPress?: () => void;
    children: React.ReactNode;
    style?: StyleProp<ViewStyle>;
    disabled?: boolean;
}

export const HeaderIconButton: React.FC<HeaderIconButtonProps> = ({
    onPress,
    children,
    style,
    disabled = false,
}) => {
    const theme = useTheme();

    return (
        <TouchableOpacity
            style={[
                styles.button,
                {
                    backgroundColor: theme.colors.background,
                    borderColor: theme.colors.border,
                },
                style,
            ]}
            onPress={onPress}
            disabled={disabled}
            activeOpacity={0.7}
        >
            {children}
        </TouchableOpacity>
    );
};

const styles = StyleSheet.create({
    button: {
        padding: 8,
        borderRadius: 100,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
    },
});

