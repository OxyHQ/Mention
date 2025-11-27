import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { Platform } from 'react-native';
import MiniChart from '@/components/MiniChart';
import { formatCompactNumber } from '@/utils/formatNumber';

interface SummaryItem {
    value: number;
    label: string;
    formatNumber?: (num: number) => string;
}

interface SummaryCardProps {
    items: SummaryItem[];
    chartData?: number[];
    showChart?: boolean;
}

const SummaryCard: React.FC<SummaryCardProps> = ({
    items,
    chartData,
    showChart = false,
}) => {
    const theme = useTheme();


    return (
        <View style={[styles.card, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
            <View style={styles.row}>
                {items.map((item, index) => (
                    <React.Fragment key={index}>
                        <View style={styles.item}>
                            <Text style={[styles.value, { color: theme.colors.text }]}>
                                {(item.formatNumber || formatCompactNumber)(item.value)}
                            </Text>
                            <Text style={[styles.label, { color: theme.colors.textSecondary }]}>
                                {item.label}
                            </Text>
                        </View>
                        {index < items.length - 1 && (
                            <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />
                        )}
                    </React.Fragment>
                ))}
            </View>
            {showChart && chartData && chartData.length > 0 && (
                <View style={styles.chart}>
                    <MiniChart
                        values={chartData}
                        showLabels={true}
                        height={40}
                    />
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        borderRadius: 15,
        padding: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
    },
    item: {
        alignItems: 'center',
        flex: 1,
    },
    divider: {
        width: 0.5,
        height: 32,
    },
    value: {
        fontSize: 20,
        fontWeight: '900',
        marginBottom: 2,
    },
    label: {
        fontSize: 12,
        fontWeight: '500',
    },
    chart: {
        marginTop: 16,
    },
});

export default SummaryCard;

