import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    ActivityIndicator,
    TouchableOpacity,
    Dimensions,
    Platform
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { HeaderIconButton } from '@/components/HeaderIconButton';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { statisticsService, UserStatistics } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import StatCard from '@/components/insights/StatCard';

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
    const { user, oxyServices } = useOxy();

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
        const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
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

    const formatNumber = (num: number): string => {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
        return num.toString();
    };

    if (loading) {
        return (
            <ThemedView style={styles.container}>
                <View style={{ paddingTop: insets.top }}>
                    <Header
                        options={{
                            title: 'Weekly Recap',
                            leftComponents: [
                                <HeaderIconButton
                                    key="back"
                                    onPress={() => router.back()}
                                >
                                    <BackArrowIcon size={20} color={theme.colors.text} />
                                </HeaderIconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />
                </View>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                </View>
            </ThemedView>
        );
    }

    if (!data) {
        return (
            <ThemedView style={styles.container}>
                <View style={{ paddingTop: insets.top }}>
                    <Header
                        options={{
                            title: 'Weekly Recap',
                            leftComponents: [
                                <HeaderIconButton
                                    key="back"
                                    onPress={() => router.back()}
                                >
                                    <BackArrowIcon size={20} color={theme.colors.text} />
                                </HeaderIconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />
                </View>
                <View style={styles.emptyContainer}>
                    <Ionicons name="bar-chart-outline" size={64} color={theme.colors.primary + '60'} />
                    <Text style={[styles.emptyText, { color: theme.colors.primary + '80' }]}>
                        No data available
                    </Text>
                </View>
            </ThemedView>
        );
    }

    const currentWeekDates = getWeekDates(0);
    const dateRange = formatDateRange(currentWeekDates.start, currentWeekDates.end);
    const avatarUri = user?.avatar ? oxyServices.getFileDownloadUrl(user.avatar as string, 'thumb') : undefined;

    const statCards = [
        {
            icon: 'document-text',
            iconColor: theme.colors.primary,
            title: 'Your activity',
            current: data.currentWeek.overview.totalPosts,
            previous: data.previousWeek.overview.totalPosts,
            unit: 'posts',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'interactions')
        },
        {
            icon: 'eye',
            iconColor: theme.colors.primary,
            title: 'Views',
            current: data.currentWeek.overview.totalViews,
            previous: data.previousWeek.overview.totalViews,
            unit: '',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'views')
        },
        {
            icon: 'chatbubble',
            iconColor: theme.colors.primary,
            title: 'Replies',
            current: data.currentWeek.interactions.replies,
            previous: data.previousWeek.interactions.replies,
            unit: '',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'replies')
        },
        {
            icon: 'person-add',
            iconColor: theme.colors.primary,
            title: 'New followers',
            current: data.newFollowers,
            previous: data.previousFollowers,
            unit: '',
            chartData: Array(7).fill(0)
        }
    ];

    return (
        <ThemedView style={styles.container}>
            {/* Header */}
            <View style={{ paddingTop: insets.top }}>
                <Header
                    options={{
                        title: 'Weekly Recap',
                        showBackButton: true,
                    }}
                />
            </View>

            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {/* Profile & Title Section */}
                <View style={styles.profileSection}>
                    <Avatar
                        source={avatarUri}
                        size={72}
                        label={user?.name?.[0] || user?.handle?.[0] || ''}
                    />
                    <Text style={[styles.title, { color: theme.colors.text }]}>Weekly recap</Text>
                    <Text style={[styles.subtitle, { color: theme.colors.textSecondary }]}>
                        Here's what happened last week between {dateRange}
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
                        formatNumber={formatNumber}
                    />
                ))}

                {/* Weekly Tip Section */}
                <View style={[styles.tipCard, { backgroundColor: theme.colors.primary + '08' }]}>
                    <View style={styles.tipHeader}>
                        <Ionicons name="bulb" size={18} color={theme.colors.primary} />
                        <Text style={[styles.tipTitle, { color: theme.colors.text }]}>This week's tip</Text>
                    </View>
                    <Text style={[styles.tipMainText, { color: theme.colors.text }]}>
                        Experiment with new content to find what works
                    </Text>
                    <Text style={[styles.tipDescription, { color: theme.colors.textSecondary }]}>
                        Trying new formats or adding media and tags could help your posts get more engagement.
                    </Text>
                    <TouchableOpacity style={styles.tipLink}>
                        <Text style={[styles.tipLinkText, { color: theme.colors.primary }]}>
                            See more tips
                        </Text>
                        <Ionicons name="chevron-forward" size={14} color={theme.colors.primary} />
                    </TouchableOpacity>
                </View>
            </ScrollView>
        </ThemedView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 24,
    },
    emptyText: {
        fontSize: 16,
        marginTop: 12,
    },
    scrollContent: {
        flex: 1,
        padding: 16,
    },
    profileSection: {
        alignItems: 'center',
        marginBottom: 24,
        marginTop: 8,
    },
    title: {
        fontSize: 24,
        fontWeight: '700',
        marginTop: 16,
        marginBottom: 8,
        letterSpacing: -0.3,
    },
    subtitle: {
        fontSize: 14,
        textAlign: 'center',
        paddingHorizontal: 20,
        lineHeight: 20,
    },
    // Tip Section
    tipCard: {
        borderRadius: 18,
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
    tipHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    tipTitle: {
        fontSize: 15,
        fontWeight: '700',
        marginLeft: 8,
        letterSpacing: -0.2,
    },
    tipMainText: {
        fontSize: 14,
        fontWeight: '700',
        marginBottom: 8,
        lineHeight: 20,
        letterSpacing: -0.2,
    },
    tipDescription: {
        fontSize: 12,
        lineHeight: 18,
        marginBottom: 12,
    },
    tipLink: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    tipLinkText: {
        fontSize: 12,
        fontWeight: '600',
        marginRight: 4,
    },
});

export default WeeklyRecapScreen;
