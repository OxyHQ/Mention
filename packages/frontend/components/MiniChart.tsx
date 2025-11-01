import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface MiniChartProps {
    values: number[];
    labels?: string[];
    showLabels?: boolean;
    height?: number;
    barColor?: string;
    todayColor?: string;
    emptyColor?: string;
    labelColor?: string;
    todayLabelColor?: string;
}

const MiniChart: React.FC<MiniChartProps> = ({
    values,
    labels,
    showLabels = true,
    height = 32,
    barColor,
    todayColor,
    emptyColor,
    labelColor,
    todayLabelColor,
}) => {
    const theme = useTheme();
    
    // Use provided colors or theme defaults
    const defaultBarColor = barColor || theme.colors.primary + '40';
    const defaultTodayColor = todayColor || theme.colors.primary;
    const defaultEmptyColor = emptyColor || theme.colors.primary + '20';
    const defaultLabelColor = labelColor || theme.colors.primary + '60';
    const defaultTodayLabelColor = todayLabelColor || theme.colors.primary;
    
    // Ensure we always have 7 values
    const chartValues = values.length >= 7 ? values.slice(-7) : [...values, ...Array(7 - values.length).fill(0)];
    
    // Find today's index for weekly charts (7 days)
    let todayIndex = -1;
    if (chartValues.length === 7) {
        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const currentDay = today.getDay();
        // Calculate Monday of current week
        const diff = currentDay === 0 ? -6 : 1 - currentDay; // Monday is day 1
        const monday = new Date(today);
        monday.setDate(today.getDate() + diff);
        
        for (let i = 0; i < 7; i++) {
            const date = new Date(monday);
            date.setDate(monday.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];
            if (dateStr === todayStr) {
                todayIndex = i;
                break;
            }
        }
    }
    
    const hasData = chartValues.some(v => v > 0);
    const maxValue = Math.max(...chartValues, 1);
    
    // Use provided labels or generate default day labels
    const dayLabels = labels || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const displayLabels = dayLabels.slice(0, 7);
    
    return (
        <View>
            <View style={[styles.chart, { height }]}>
                {chartValues.map((value, i) => {
                    const heightPercent = maxValue > 0 ? (value / maxValue) * 100 : 0;
                    const isToday = i === todayIndex;
                    const isEmpty = !hasData || value === 0;
                    
                    return (
                        <View key={i} style={styles.chartBarContainer}>
                            <View
                                style={[
                                    styles.chartBar,
                                    {
                                        height: isEmpty ? 2 : `${Math.max(heightPercent, 5)}%`,
                                        backgroundColor: isEmpty 
                                            ? defaultEmptyColor 
                                            : isToday 
                                                ? defaultTodayColor 
                                                : defaultBarColor,
                                    }
                                ]}
                            />
                        </View>
                    );
                })}
            </View>
            {showLabels && (
                <View style={styles.chartLabels}>
                    {displayLabels.map((label, i) => {
                        const isToday = i === todayIndex;
                        return (
                            <Text 
                                key={i} 
                                style={[
                                    styles.chartLabel, 
                                    { color: isToday ? defaultTodayLabelColor : defaultLabelColor }
                                ]}
                            >
                                {label}
                            </Text>
                        );
                    })}
                </View>
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    chart: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        marginBottom: 8,
        paddingHorizontal: 4,
    },
    chartBarContainer: {
        flex: 1,
        height: '100%',
        justifyContent: 'flex-end',
        marginHorizontal: 2,
    },
    chartBar: {
        width: '100%',
        minHeight: 2,
        borderRadius: 6,
    },
    chartLabels: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
    },
    chartLabel: {
        flex: 1,
        fontSize: 10,
        textAlign: 'center',
        fontWeight: '500',
    },
});

export default MiniChart;

