import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Platform } from 'react-native';

interface HeroCardProps {
    icon: string;
    iconColor?: string;
    title: string;
    titleColor?: string;
    value: string | number;
    subtitle?: string;
    subtitleColor?: string;
}

const HeroCard: React.FC<HeroCardProps> = ({
    icon,
    iconColor,
    title,
    titleColor,
    value,
    subtitle,
    subtitleColor,
}) => {
    const theme = useTheme();
    const defaultIconColor = iconColor || theme.colors.primary;
    const defaultTitleColor = titleColor || theme.colors.primary;
    const defaultSubtitleColor = subtitleColor || theme.colors.textSecondary;

    return (
        <View style={[styles.card, { backgroundColor: theme.colors.primary + '08' }]}>
            <View style={styles.header}>
                <Ionicons name={icon as any} size={24} color={defaultIconColor} />
                <Text style={[styles.title, { color: defaultTitleColor, marginLeft: 8 }]}>
                    {title}
                </Text>
            </View>
            <View style={styles.content}>
                <Text style={[styles.value, { color: '#000000' }]}>
                    {value}
                </Text>
                {subtitle && (
                    <Text style={[styles.subtitle, { color: defaultSubtitleColor }]}>
                        {subtitle}
                    </Text>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        ...Platform.select({
            ios: {
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.08,
                shadowRadius: 4,
            },
            android: {
                elevation: 2,
            },
        }),
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    title: {
        fontSize: 16,
        fontWeight: '600',
    },
    content: {
        alignItems: 'center',
    },
    value: {
        fontSize: 36,
        fontWeight: '900',
        letterSpacing: -0.5,
    },
    subtitle: {
        fontSize: 13,
        marginTop: 6,
        fontWeight: '500',
    },
});

export default HeroCard;

