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
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { statisticsService, UserStatistics } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import Avatar from '@/components/Avatar';
import MiniChart from '@/components/MiniChart';

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
            
            // Calculate days for each week
            const daysDiff = Math.ceil((currentWeekDates.end.getTime() - currentWeekDates.start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
            const prevDaysDiff = Math.ceil((previousWeekDates.end.getTime() - previousWeekDates.start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

            // Fetch statistics for both weeks
            const [currentWeekStats, previousWeekStats] = await Promise.all([
                statisticsService.getUserStatistics(daysDiff),
                statisticsService.getUserStatistics(prevDaysDiff + daysDiff).then(stats => {
                    // Extract previous week data from the combined period
                    return {
                        ...stats,
                        overview: {
                            ...stats.overview,
                            // Approximate previous week data (simplified)
                            totalPosts: Math.max(0, stats.overview.totalPosts - stats.overview.totalPosts * 0.5),
                            totalViews: Math.max(0, stats.overview.totalViews - stats.overview.totalViews * 0.5),
                            totalInteractions: Math.max(0, stats.overview.totalInteractions - stats.overview.totalInteractions * 0.5),
                        },
                        interactions: {
                            ...stats.interactions,
                            replies: Math.max(0, stats.interactions.replies - stats.interactions.replies * 0.5),
                        }
                    };
                })
            ]);

            // Placeholder for follower data (would need API endpoint)
            const newFollowers = 0;
            const previousFollowers = 0;

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

    const darkenColor = (color: string, amount: number = 0.3): string => {
        // Handle colors with opacity (like "#FF000080")
        if (color.length === 9) {
            // Extract RGB and alpha
            const hex = color.substring(0, 7);
            const alpha = color.substring(7, 9);
            
            // Parse RGB values
            const r = parseInt(hex.substring(1, 3), 16);
            const g = parseInt(hex.substring(3, 5), 16);
            const b = parseInt(hex.substring(5, 7), 16);
            
            // Darken by reducing RGB values
            const darkenedR = Math.max(0, Math.floor(r * (1 - amount)));
            const darkenedG = Math.max(0, Math.floor(g * (1 - amount)));
            const darkenedB = Math.max(0, Math.floor(b * (1 - amount)));
            
            // Convert back to hex with alpha
            return `#${darkenedR.toString(16).padStart(2, '0')}${darkenedG.toString(16).padStart(2, '0')}${darkenedB.toString(16).padStart(2, '0')}${alpha}`;
        }
        
        // Handle standard hex colors (like "#FF0000")
        const hex = color.replace('#', '');
        
        // Parse RGB values
        const r = parseInt(hex.substring(0, 2), 16);
        const g = parseInt(hex.substring(2, 4), 16);
        const b = parseInt(hex.substring(4, 6), 16);
        
        // Darken by reducing RGB values
        const darkenedR = Math.max(0, Math.floor(r * (1 - amount)));
        const darkenedG = Math.max(0, Math.floor(g * (1 - amount)));
        const darkenedB = Math.max(0, Math.floor(b * (1 - amount)));
        
        // Convert back to hex
        return `#${darkenedR.toString(16).padStart(2, '0')}${darkenedG.toString(16).padStart(2, '0')}${darkenedB.toString(16).padStart(2, '0')}`;
    };

    const getChangeIcon = (current: number, previous: number) => {
        if (current > previous) return 'chevron-up';
        if (current < previous) return 'chevron-down';
        return 'remove';
    };

    const getChangeColor = (current: number, previous: number) => {
        if (current > previous) {
            // Use theme color for positive change
            return theme.colors.primary;
        }
        if (current < previous) {
            // Use theme color with lower opacity for decrease
            return theme.colors.primary + '70';
        }
        // Use theme color with very low opacity for neutral
        return theme.colors.primary + '50';
    };


    if (loading) {
        return (
            <ThemedView style={styles.container}>
                <View style={{ paddingTop: insets.top }}>
                    <Header
                        options={{
                            title: 'Weekly Recap',
                            showBackButton: true,
                        }}
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
                            showBackButton: true,
                        }}
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
            iconBg: theme.colors.primary + '20',
            iconColor: theme.colors.primary,
            title: 'Your activity',
            current: data.currentWeek.overview.totalPosts,
            previous: data.previousWeek.overview.totalPosts,
            unit: 'posts',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'interactions')
        },
        {
            icon: 'eye',
            iconBg: theme.colors.primary + '20',
            iconColor: theme.colors.primary,
            title: 'Views',
            current: data.currentWeek.overview.totalViews,
            previous: data.previousWeek.overview.totalViews,
            unit: '',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'views')
        },
        {
            icon: 'chatbubble',
            iconBg: theme.colors.primary + '20',
            iconColor: theme.colors.primary,
            title: 'Replies',
            current: data.currentWeek.interactions.replies,
            previous: data.previousWeek.interactions.replies,
            unit: '',
            chartData: getCurrentWeekData(data.currentWeek.dailyBreakdown || [], 'replies')
        },
        {
            icon: 'person-add',
            iconBg: theme.colors.primary + '20',
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
                {statCards.map((card, index) => {
                    const changeIcon = getChangeIcon(card.current, card.previous);
                    const changeColor = getChangeColor(card.current, card.previous);
                    const dayLabels = getDayLabels();

                    return (
                        <View key={index} style={[styles.statCard, { backgroundColor: theme.colors.primary + '08' }]}>
                            <View style={styles.statCardTop}>
                                <View style={styles.statCardTitleRow}>
                                    <Ionicons name={card.icon as any} size={20} color={card.iconColor} style={styles.statIcon} />
                                    <Text style={[styles.statCardTitle, { color: card.iconColor }]}>
                                        {card.title}
                                    </Text>
                                </View>
                            </View>
                            <View style={styles.statCardContent}>
                                <Text style={[styles.statCardValue, { color: '#000000' }]}>
                                    {formatNumber(card.current)}{card.unit ? ` ${card.unit}` : ''}
                                </Text>
                                <View style={styles.previousRow}>
                                    <Text style={[styles.previousText, { color: card.iconColor }]}>
                                        Previous: {formatNumber(card.previous)}{card.unit ? ` ${card.unit}` : ''}
                                    </Text>
                                </View>
                                <View style={styles.chartContainer}>
                                    <MiniChart
                                        values={card.chartData}
                                        labels={dayLabels}
                                        showLabels={true}
                                        height={32}
                                    />
                                </View>
                            </View>
                        </View>
                    );
                })}

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
    // Stats Cards - Full Width, Stacked
    statCard: {
        width: '100%',
        padding: 16,
        borderRadius: 16,
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
    statCardTop: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    statCardTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    statIcon: {
        marginRight: 10,
    },
    statCardContent: {
        flex: 1,
    },
    statCardTitle: {
        fontSize: 13,
        fontWeight: '500',
    },
    statCardValue: {
        fontSize: 32,
        fontWeight: '900',
        marginBottom: 8,
        letterSpacing: -0.3,
    },
    previousRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    previousText: {
        fontSize: 12,
    },
    chartContainer: {
        width: '100%',
        marginTop: 12,
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
