import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';

interface SectionHeaderProps {
    icon: string;
    title: string;
    iconColor?: string;
    titleColor?: string;
}

const SectionHeader: React.FC<SectionHeaderProps> = ({
    icon,
    title,
    iconColor,
    titleColor,
}) => {
    const theme = useTheme();
    const defaultIconColor = iconColor || theme.colors.primary;
    const defaultTitleColor = titleColor || theme.colors.primary;

    return (
        <View style={styles.container}>
            <Ionicons name={icon as any} size={20} color={defaultIconColor} />
            <Text style={[styles.title, { color: defaultTitleColor, marginLeft: 8 }]}>
                {title}
            </Text>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    title: {
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
});

export default SectionHeader;

