import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    ScrollView,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { statisticsService, UserStatistics } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { Avatar } from '@oxyhq/bloom/avatar';
import StatCard from '@/components/insights/StatCard';
import { formatCompactNumber } from '@/utils/formatNumber';
import { logger } from '@/lib/logger';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';


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
    const [summary, setSummary] = useState<string | null>(null);
    const [summaryLoading, setSummaryLoading] = useState(true);

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

            // Fetch statistics for both weeks
            // Fetch 14 days total, then split into current week (last 7) and previous week (first 7)
            const [combinedStats, followerChanges, summaryResult] = await Promise.all([
                statisticsService.getUserStatistics(14),
                statisticsService.getFollowerChanges(14).catch(() => null),
                statisticsService.getWeeklySummary().catch(() => ({ summary: null })),
            ]);

            setSummary(summaryResult.summary);
            setSummaryLoading(false);

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
            logger.error('Error loading weekly recap', { error });
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
                    <Loading className="text-primary" size="large" />
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
                    <AnalyticsIcon size={64} color={theme.colors.text + '60'} />
                    <Text className="text-base mt-3 text-muted-foreground">
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
            icon: <ArticleIcon size={20} className="text-foreground" />,
            title: t('insights.weeklyRecap.yourActivity'),
            current: data.currentWeek.overview.totalPosts,
            previous: data.previousWeek.overview.totalPosts,
            unit: t('insights.weeklyRecap.posts'),
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'interactions')
        },
        {
            icon: <Ionicons name="eye" size={20} color={theme.colors.text} />,
            title: t('insights.weeklyRecap.views'),
            current: data.currentWeek.overview.totalViews,
            previous: data.previousWeek.overview.totalViews,
            unit: '',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'views')
        },
        {
            icon: <CommentIcon size={20} className="text-foreground" />,
            title: t('insights.weeklyRecap.replies'),
            current: data.currentWeek.interactions.replies,
            previous: data.previousWeek.interactions.replies,
            unit: '',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'replies')
        },
        {
            icon: <Ionicons name="person-add" size={20} color={theme.colors.text} />,
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
                    />
                    <Text className="text-2xl font-bold mt-4 mb-2 text-foreground" style={{ letterSpacing: -0.3 }}>
                        {t('insights.weeklyRecap.pageTitle')}
                    </Text>
                    {summaryLoading ? (
                        <View className="gap-2 px-5 w-full items-center mt-1">
                            <View className="h-3 rounded bg-muted-foreground/20 w-4/5" />
                            <View className="h-3 rounded bg-muted-foreground/20 w-3/5" />
                        </View>
                    ) : (
                        <Text className="text-sm text-center px-5 leading-5 text-muted-foreground">
                            {summary || dateRange}
                        </Text>
                    )}
                </View>

                {/* Stats Cards - Full Width, Stacked */}
                {statCards.map((card, index) => (
                    <StatCard
                        key={index}
                        icon={card.icon}
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

            </ScrollView>
        </ThemedView>
    );
};

export default WeeklyRecapScreen;
