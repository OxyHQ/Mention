import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';

interface SectionHeaderProps {
    icon?: string;
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
    const defaultIconColor = iconColor || theme.colors.text;
    const defaultTitleColor = titleColor || theme.colors.text;

    return (
        <View style={styles.container}>
            <Text style={[styles.title, { color: defaultTitleColor }]}>
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
        fontSize: 18,
        fontWeight: 'bold',
    },
});

export default SectionHeader;

