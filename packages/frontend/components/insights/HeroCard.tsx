import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface HeroCardProps {
    value: string | number;
    subtitle?: string;
    subtitleColor?: string;
}

const HeroCard: React.FC<HeroCardProps> = ({
    value,
    subtitle,
    subtitleColor,
}) => {
    const theme = useTheme();
    const defaultSubtitleColor = subtitleColor || theme.colors.textSecondary;

    return (
        <View style={styles.container}>
            <Text style={[styles.value, { color: theme.colors.text }]}>
                {value}
            </Text>
            {subtitle && (
                <Text style={[styles.subtitle, { color: defaultSubtitleColor }]}>
                    {subtitle}
                </Text>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        paddingVertical: 16,
        marginBottom: 8,
    },
    value: {
        fontSize: 36,
        fontWeight: '800',
        letterSpacing: -0.5,
    },
    subtitle: {
        fontSize: 13,
        marginTop: 4,
        fontWeight: '500',
    },
});

export default HeroCard;
