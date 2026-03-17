import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    ScrollView,
    TouchableOpacity,
    Dimensions,
} from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { statisticsService, UserStatistics } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import StatCard from '@/components/insights/StatCard';
import { formatCompactNumber } from '@/utils/formatNumber';

const { width } = Dimensions.get('window');

interface WeeklyRecapData {
    currentWeek: UserStatistics;
    previousWeek: UserStatistics;
    newFollowers: number;
    previousFollowers: number;
}

const WeeklyRecapScreen: React.FC = () => {
    const { t } = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { user } = useAuth();
    const safeBack = useSafeBack();

    const [loading, setLoading] = useState(true);
    const [data, setData] = useState<WeeklyRecapData | null>(null);

    const getWeekDates = (weekOffset: number = 0) => {
        const today = new Date();
        const currentDay = today.getDay();
        const diff = today.getDate() - currentDay + (currentDay === 0 ? -6 : 1); // Monday
        const monday = new Date(today.setDate(diff));
        monday.setDate(monday.getDate() - (weekOffset * 7));
        const sunday = new Date(monday);
        sunday.setDate(sunday.getDate() + 6);

        return { start: monday, end: sunday };
    };

    const getDayLabels = () => {
        const weekDates = getWeekDates(0);
        const days = [
            t('insights.weeklyRecap.days.mon'),
            t('insights.weeklyRecap.days.tue'),
            t('insights.weeklyRecap.days.wed'),
            t('insights.weeklyRecap.days.thu'),
            t('insights.weeklyRecap.days.fri'),
            t('insights.weeklyRecap.days.sat'),
            t('insights.weeklyRecap.days.sun')
        ];
        const labels = [];

        for (let i = 0; i < 7; i++) {
            const date = new Date(weekDates.start);
            date.setDate(date.getDate() + i);
            const dayIndex = date.getDay();
            // Convert Sunday (0) to index 6, and shift others
            const adjustedIndex = dayIndex === 0 ? 6 : dayIndex - 1;
            labels.push(days[adjustedIndex]);
        }

        return labels;
    };

    const getCurrentWeekData = (data: UserStatistics['dailyBreakdown'], field: 'views' | 'replies' | 'interactions'): number[] => {
        if (!data || data.length === 0) return Array(7).fill(0);

        const weekDates = getWeekDates(0);
        const weekData = Array(7).fill(0);

        // Create a map of dates to values
        const dataMap = new Map<string, number>();
        data.forEach(day => {
            const dateStr = day.date.split('T')[0]; // Get just the date part
            const value = day[field] || 0;
            dataMap.set(dateStr, value);
        });

        // Map each day of the week to its value
        for (let i = 0; i < 7; i++) {
            const date = new Date(weekDates.start);
            date.setDate(date.getDate() + i);
            const dateStr = date.toISOString().split('T')[0];
            weekData[i] = dataMap.get(dateStr) || 0;
        }

        return weekData;
    };

    const formatDateRange = (start: Date, end: Date) => {
        const startMonth = start.toLocaleDateString('en-US', { month: 'short' });
        const startDay = start.getDate();
        const endMonth = end.toLocaleDateString('en-US', { month: 'short' });
        const endDay = end.getDate();

        if (startMonth === endMonth) {
            return `${startMonth} ${startDay} - ${endDay}`;
        }
        return `${startMonth} ${startDay} - ${endMonth} ${endDay}`;
    };

    const loadWeeklyRecap = useCallback(async () => {
        if (!user) return;

        try {
            setLoading(true);
            const currentWeekDates = getWeekDates(0);
            const previousWeekDates = getWeekDates(1);

            // Calculate days for each week (7 days per week)
            const daysDiff = 7;
            const prevDaysDiff = 7;

            // Fetch statistics for both weeks
            // Fetch 14 days total, then split into current week (last 7) and previous week (first 7)
            const [combinedStats, followerChanges] = await Promise.all([
                statisticsService.getUserStatistics(14), // Get last 14 days
                statisticsService.getFollowerChanges(14).catch(() => null), // Get last 14 days for follower changes
            ]);

            // Split daily breakdown into current and previous weeks
            const dailyBreakdown = combinedStats.dailyBreakdown || [];
            const previousWeekBreakdown = dailyBreakdown.slice(0, 7); // First 7 days (older)
            const currentWeekBreakdown = dailyBreakdown.slice(-7); // Last 7 days (newer)

            // Calculate current week stats from daily breakdown
            const currentWeekStats: UserStatistics = {
                ...combinedStats,
                dailyBreakdown: currentWeekBreakdown,
                overview: {
                    ...combinedStats.overview,
                    totalPosts: combinedStats.overview.totalPosts, // Will be filtered by date range if API supports it
                    totalViews: currentWeekBreakdown.reduce((sum, day) => sum + day.views, 0),
                    totalInteractions: currentWeekBreakdown.reduce((sum, day) => sum + day.interactions, 0),
                    engagementRate: combinedStats.overview.engagementRate,
                    averageEngagementPerPost: combinedStats.overview.averageEngagementPerPost,
                },
                interactions: {
                    likes: currentWeekBreakdown.reduce((sum, day) => sum + day.likes, 0),
                    replies: currentWeekBreakdown.reduce((sum, day) => sum + day.replies, 0),
                    reposts: currentWeekBreakdown.reduce((sum, day) => sum + day.reposts, 0),
                    shares: combinedStats.interactions.shares, // Shares might not be in daily breakdown
                },
            };

            // Calculate previous week stats from daily breakdown
            const previousWeekStats: UserStatistics = {
                ...combinedStats,
                dailyBreakdown: previousWeekBreakdown,
                overview: {
                    ...combinedStats.overview,
                    totalPosts: combinedStats.overview.totalPosts, // Will be filtered by date range if API supports it
                    totalViews: previousWeekBreakdown.reduce((sum, day) => sum + day.views, 0),
                    totalInteractions: previousWeekBreakdown.reduce((sum, day) => sum + day.interactions, 0),
                    engagementRate: combinedStats.overview.engagementRate,
                    averageEngagementPerPost: combinedStats.overview.averageEngagementPerPost,
                },
                interactions: {
                    likes: previousWeekBreakdown.reduce((sum, day) => sum + day.likes, 0),
                    replies: previousWeekBreakdown.reduce((sum, day) => sum + day.replies, 0),
                    reposts: previousWeekBreakdown.reduce((sum, day) => sum + day.reposts, 0),
                    shares: combinedStats.interactions.shares, // Shares might not be in daily breakdown
                },
            };

            // Extract follower data from followerChanges if available
            let newFollowers = 0;
            let previousFollowers = 0;

            if (followerChanges && followerChanges.followerChanges) {
                const changes = followerChanges.followerChanges;
                // Current week followers (last 7 days)
                const currentWeekChanges = changes.slice(-7);
                newFollowers = currentWeekChanges.reduce((sum, change) => sum + Math.max(0, change.change), 0);

                // Previous week followers (days 8-14)
                const previousWeekChanges = changes.slice(0, 7);
                previousFollowers = previousWeekChanges.reduce((sum, change) => sum + Math.max(0, change.change), 0);
            }

            setData({
                currentWeek: currentWeekStats,
                previousWeek: previousWeekStats,
                newFollowers,
                previousFollowers
            });
        } catch (error) {
            console.error('Error loading weekly recap:', error);
        } finally {
            setLoading(false);
        }
    }, [user]);

    useEffect(() => {
        loadWeeklyRecap();
    }, [loadWeeklyRecap]);


    if (loading) {
        return (
            <ThemedView className="flex-1">
                <View style={{ paddingTop: insets.top }}>
                    <Header
                        options={{
                            title: t('insights.weeklyRecap.title'),
                            leftComponents: [
                                <IconButton variant="icon"
                                    key="back"
                                    onPress={() => safeBack()}
                                >
                                    <BackArrowIcon size={20} className="text-foreground" />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />
                </View>
                <View className="flex-1 items-center justify-center">
                    <Loading size="large" />
                </View>
            </ThemedView>
        );
    }

    if (!data) {
        return (
            <ThemedView className="flex-1">
                <View style={{ paddingTop: insets.top }}>
                    <Header
                        options={{
                            title: t('insights.weeklyRecap.title'),
                            leftComponents: [
                                <IconButton variant="icon"
                                    key="back"
                                    onPress={() => safeBack()}
                                >
                                    <BackArrowIcon size={20} className="text-foreground" />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />
                </View>
                <View className="flex-1 items-center justify-center p-6">
                    <Ionicons name="bar-chart-outline" size={64} color={theme.colors.primary + '60'} />
                    <Text className="text-base mt-3" style={{ color: theme.colors.primary + '80' }}>
                        {t('insights.weeklyRecap.noDataAvailable')}
                    </Text>
                </View>
            </ThemedView>
        );
    }

    const currentWeekDates = getWeekDates(0);
    const dateRange = formatDateRange(currentWeekDates.start, currentWeekDates.end);
    const avatarUri = user?.avatar;

    const statCards = [
        {
            icon: 'document-text',
            iconColor: theme.colors.primary,
            title: t('insights.weeklyRecap.yourActivity'),
            current: data.currentWeek.overview.totalPosts,
            previous: data.previousWeek.overview.totalPosts,
            unit: t('insights.weeklyRecap.posts'),
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'interactions')
        },
        {
            icon: 'eye',
            iconColor: theme.colors.primary,
            title: t('insights.weeklyRecap.views'),
            current: data.currentWeek.overview.totalViews,
            previous: data.previousWeek.overview.totalViews,
            unit: '',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'views')
        },
        {
            icon: 'chatbubble',
            iconColor: theme.colors.primary,
            title: t('insights.weeklyRecap.replies'),
            current: data.currentWeek.interactions.replies,
            previous: data.previousWeek.interactions.replies,
            unit: '',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'replies')
        },
        {
            icon: 'person-add',
            iconColor: theme.colors.primary,
            title: t('insights.weeklyRecap.newFollowers'),
            current: data.newFollowers,
            previous: data.previousFollowers,
            unit: '',
            chartData: Array(7).fill(0)
        }
    ];

    return (
        <ThemedView className="flex-1">
            {/* Header */}
            <View style={{ paddingTop: insets.top }}>
                <Header
                    options={{
                        title: t('insights.weeklyRecap.title'),
                        showBackButton: true,
                    }}
                />
            </View>

            <ScrollView className="flex-1 px-4 pb-5" showsVerticalScrollIndicator={false}>
                {/* Profile & Title Section */}
                <View className="items-center mb-6 mt-2">
                    <Avatar
                        source={avatarUri}
                        size={72}
                        label={(typeof user?.name === 'string' ? user.name[0] : null) || (typeof user?.handle === 'string' ? user.handle[0] : null) || ''}
                    />
                    <Text className="text-2xl font-bold mt-4 mb-2 text-foreground" style={{ letterSpacing: -0.3 }}>
                        {t('insights.weeklyRecap.pageTitle')}
                    </Text>
                    <Text className="text-sm text-center px-5 leading-5 text-muted-foreground">
                        {t('insights.weeklyRecap.subtitleText', { dateRange })}
                    </Text>
                </View>

                {/* Stats Cards - Full Width, Stacked */}
                {statCards.map((card, index) => (
                    <StatCard
                        key={index}
                        icon={card.icon}
                        iconColor={card.iconColor}
                        title={card.title}
                        value={card.current}
                        previous={card.previous}
                        unit={card.unit}
                        chartData={card.chartData}
                        chartLabels={getDayLabels()}
                        showChart={true}
                        formatNumber={formatCompactNumber}
                    />
                ))}

                {/* Weekly Tip Section */}
                <View className="rounded-[15px] p-4 mb-4 border overflow-hidden bg-card border-border">
                    <View className="flex-row items-center mb-3">
                        <Ionicons name="bulb" size={18} color={theme.colors.primary} />
                        <Text className="text-[15px] font-bold ml-2 text-foreground" style={{ letterSpacing: -0.2 }}>
                            {t('insights.weeklyRecap.thisWeeksTip')}
                        </Text>
                    </View>
                    <Text className="text-sm font-bold mb-2 leading-5 text-foreground" style={{ letterSpacing: -0.2 }}>
                        {t('insights.weeklyRecap.tipMainText')}
                    </Text>
                    <Text className="text-xs leading-[18px] mb-3 text-muted-foreground">
                        {t('insights.weeklyRecap.tipDescription')}
                    </Text>
                    <TouchableOpacity className="flex-row items-center">
                        <Text className="text-xs font-semibold mr-1 text-primary">
                            {t('insights.weeklyRecap.seeMoreTips')}
                        </Text>
                        <Ionicons name="chevron-forward" size={14} color={theme.colors.primary} />
                    </TouchableOpacity>
                </View>
            </ScrollView>
        </ThemedView>
    );
};

export default WeeklyRecapScreen;
