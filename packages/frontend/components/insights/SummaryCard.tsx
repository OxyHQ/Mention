import React from 'react';
import { View, Text } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
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
        <View className="py-3">
            <View className="flex-row items-center justify-around">
                {items.map((item, index) => (
                    <React.Fragment key={index}>
                        <View className="items-center flex-1">
                            <Text className="text-foreground text-xl font-extrabold mb-0.5">
                                {(item.formatNumber || formatCompactNumber)(item.value)}
                            </Text>
                            <Text className="text-muted-foreground text-xs font-medium">
                                {item.label}
                            </Text>
                        </View>
                        {index < items.length - 1 && (
                            <View
                                className="bg-border"
                                style={{ width: 0.5, height: 28 }}
                            />
                        )}
                    </React.Fragment>
                ))}
            </View>
            {showChart && chartData && chartData.length > 0 && (
                <View className="mt-4">
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

export default SummaryCard;
