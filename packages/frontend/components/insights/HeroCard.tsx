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
        <View style={[styles.card, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            <View style={styles.content}>
                <Text style={[styles.value, { color: theme.colors.text }]}>
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
        borderRadius: 15,
        padding: 16,
        marginBottom: 16,
        borderWidth: 1,
        overflow: 'hidden',
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

