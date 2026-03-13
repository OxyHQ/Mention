import React from 'react';
import { View, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
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
    const { t } = useTranslation();
    const theme = useTheme();
    const defaultIconColor = iconColor || theme.colors.primary;
    const dayLabels = chartLabels || [
        t('insights.weeklyRecap.days.mon'),
        t('insights.weeklyRecap.days.tue'),
        t('insights.weeklyRecap.days.wed'),
        t('insights.weeklyRecap.days.thu'),
        t('insights.weeklyRecap.days.fri'),
        t('insights.weeklyRecap.days.sat'),
        t('insights.weeklyRecap.days.sun')
    ];

    return (
        <View className="bg-card border border-border rounded-[15px] p-4 mb-3 overflow-hidden">
            <View className="mb-3">
                <View className="flex-row items-center">
                    <Ionicons name={icon as any} size={20} color={defaultIconColor} style={{ marginRight: 8 }} />
                    <Text className="text-foreground text-sm font-semibold">
                        {title}
                    </Text>
                </View>
            </View>
            <View className="gap-2">
                <Text
                    className="text-foreground font-black"
                    style={{ fontSize: 28, letterSpacing: -0.5 }}
                >
                    {formatNumber(value)}{unit ? ` ${unit}` : ''}
                </Text>
                {previous !== undefined && (
                    <View className="mt-1">
                        <Text className="text-muted-foreground text-xs font-medium">
                            {t('insights.weeklyRecap.previous')}: {formatNumber(previous)}{unit ? ` ${unit}` : ''}
                        </Text>
                    </View>
                )}
                {showChart && chartData.length > 0 && (
                    <View className="mt-2">
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

export default StatCard;
