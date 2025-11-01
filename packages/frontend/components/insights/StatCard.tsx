import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import MiniChart from '@/components/MiniChart';

interface StatCardProps {
    icon: string;
    iconColor?: string;
    title: string;
    value: number;
    previous?: number;
    unit?: string;
    chartData?: number[];
    chartLabels?: string[];
    showChart?: boolean;
    formatNumber?: (num: number) => string;
}

const StatCard: React.FC<StatCardProps> = ({
    icon,
    iconColor,
    title,
    value,
    previous,
    unit,
    chartData = [],
    chartLabels,
    showChart = false,
    formatNumber = (num) => num.toString(),
}) => {
    const theme = useTheme();
    const defaultIconColor = iconColor || theme.colors.primary;
    const dayLabels = chartLabels || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    return (
        <View style={[styles.card, { backgroundColor: theme.colors.primary + '08' }]}>
            <View style={styles.header}>
                <View style={styles.titleRow}>
                    <Ionicons name={icon as any} size={20} color={defaultIconColor} style={styles.icon} />
                    <Text style={[styles.title, { color: defaultIconColor }]}>
                        {title}
                    </Text>
                </View>
            </View>
            <View style={styles.content}>
                <Text style={[styles.value, { color: '#000000' }]}>
                    {formatNumber(value)}{unit ? ` ${unit}` : ''}
                </Text>
                {previous !== undefined && (
                    <View style={styles.previousRow}>
                        <Text style={[styles.previousText, { color: defaultIconColor }]}>
                            Previous: {formatNumber(previous)}{unit ? ` ${unit}` : ''}
                        </Text>
                    </View>
                )}
                {showChart && chartData.length > 0 && (
                    <View style={styles.chartContainer}>
                        <MiniChart
                            values={chartData}
                            labels={dayLabels}
                            showLabels={true}
                            height={32}
                        />
                    </View>
                )}
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        borderRadius: 12,
        padding: 16,
        marginBottom: 12,
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
        marginBottom: 12,
    },
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    icon: {
        marginRight: 8,
    },
    title: {
        fontSize: 14,
        fontWeight: '600',
    },
    content: {
        gap: 8,
    },
    value: {
        fontSize: 28,
        fontWeight: '900',
        letterSpacing: -0.5,
    },
    previousRow: {
        marginTop: 4,
    },
    previousText: {
        fontSize: 12,
        fontWeight: '500',
    },
    chartContainer: {
        marginTop: 8,
    },
});

export default StatCard;

