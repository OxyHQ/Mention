import React, { useEffect, useState, useMemo, useCallback } from 'react';
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
import { statisticsService, UserStatistics, EngagementRatios } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxyhq/services';
import { usePostsStore } from '@/stores/postsStore';
import PostItem from '@/components/Feed/PostItem';
import { UIPost } from '@mention/shared-types';

const { width } = Dimensions.get('window');

const PERIOD_OPTIONS = [
    { label: '7 Days', value: 7 },
    { label: '30 Days', value: 30 },
    { label: '90 Days', value: 90 }
];

const StatisticsScreen: React.FC = () => {
    const { t } = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const { user } = useOxy();

    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState<UserStatistics | null>(null);
    const [engagementRatios, setEngagementRatios] = useState<EngagementRatios | null>(null);
    const [selectedPeriod, setSelectedPeriod] = useState(30);
    const [activeTab, setActiveTab] = useState<'overview' | 'engagement'>('overview');
    const [topPostsData, setTopPostsData] = useState<UIPost[]>([]);
    const [loadingTopPosts, setLoadingTopPosts] = useState(false);

    const { getPostById } = usePostsStore();

    const loadStatistics = useCallback(async () => {
        if (!user) return;

        try {
            setLoading(true);
            const [statsData, engagementData] = await Promise.all([
                statisticsService.getUserStatistics(selectedPeriod),
                statisticsService.getEngagementRatios(selectedPeriod)
            ]);
            setStats(statsData);
            setEngagementRatios(engagementData);

            // Load top posts data
            if (statsData.topPosts && statsData.topPosts.length > 0) {
                setLoadingTopPosts(true);
                try {
                    const postsPromises = statsData.topPosts.slice(0, 5).map(async (postInfo) => {
                        try {
                            return await getPostById(postInfo.postId);
                        } catch (error) {
                            console.error(`Error loading post ${postInfo.postId}:`, error);
                            return null;
                        }
                    });
                    const posts = await Promise.all(postsPromises);
                    setTopPostsData(posts.filter((p): p is UIPost => p !== null));
                } catch (error) {
                    console.error('Error loading top posts:', error);
                } finally {
                    setLoadingTopPosts(false);
                }
            } else {
                setTopPostsData([]);
            }
        } catch (error) {
            console.error('Error loading statistics:', error);
        } finally {
            setLoading(false);
        }
    }, [selectedPeriod, user, getPostById]);

    useEffect(() => {
        loadStatistics();
    }, [loadStatistics]);

    const formatNumber = (num: number): string => {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
        return num.toString();
    };

    const renderOverviewTab = () => {
        if (!stats) return null;

        return (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {/* Overview Cards */}
                <View style={styles.overviewGrid}>
                    <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Ionicons name="eye-outline" size={24} color={theme.colors.primary} />
                        <Text style={[styles.statValue, { color: theme.colors.text }]}>
                            {formatNumber(stats.overview.totalViews)}
                        </Text>
                        <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Views</Text>
                    </View>

                    <View style={[styles.statCard, styles.statCardLast, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Ionicons name="heart-outline" size={24} color="#FF3040" />
                        <Text style={[styles.statValue, { color: theme.colors.text }]}>
                            {formatNumber(stats.interactions.likes)}
                        </Text>
                        <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Likes</Text>
                    </View>

                    <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Ionicons name="chatbubble-outline" size={24} color={theme.colors.primary} />
                        <Text style={[styles.statValue, { color: theme.colors.text }]}>
                            {formatNumber(stats.interactions.replies)}
                        </Text>
                        <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Replies</Text>
                    </View>

                    <View style={[styles.statCard, styles.statCardLast, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Ionicons name="repeat-outline" size={24} color="#10B981" />
                        <Text style={[styles.statValue, { color: theme.colors.text }]}>
                            {formatNumber(stats.interactions.reposts)}
                        </Text>
                        <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Reposts</Text>
                    </View>
                </View>

                {/* Engagement Rate */}
                <View style={[styles.section, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Engagement Rate</Text>
                    <View style={styles.engagementContainer}>
                        <Text style={[styles.engagementValue, { color: theme.colors.primary }]}>
                            {stats.overview.engagementRate.toFixed(2)}%
                        </Text>
                        <Text style={[styles.engagementLabel, { color: theme.colors.textSecondary }]}>
                            {formatNumber(stats.overview.totalInteractions)} interactions
                        </Text>
                    </View>
                </View>

                {/* Top Posts */}
                {stats.topPosts.length > 0 && (
                    <View style={styles.section}>
                        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Top Performing Posts</Text>
                        {loadingTopPosts ? (
                            <View style={styles.loadingPosts}>
                                <ActivityIndicator size="small" color={theme.colors.primary} />
                            </View>
                        ) : topPostsData.length > 0 ? (
                            topPostsData.map((post, index) => (
                                <View key={post.id} style={styles.postWrapper}>
                                    <View style={styles.postRankBadge}>
                                        <Text style={styles.rankBadgeText}>
                                            #{index + 1}
                                        </Text>
                                    </View>
                                    <View style={styles.postContainer}>
                                        <PostItem post={post} />
                                    </View>
                                </View>
                            ))
                        ) : (
                            <View style={styles.emptyPosts}>
                                <Text style={[styles.emptyPostsText, { color: theme.colors.textSecondary }]}>
                                    Unable to load posts
                                </Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Posts by Type */}
                {Object.keys(stats.postsByType).length > 0 && (
                    <View style={styles.section}>
                        <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Posts by Type</Text>
                        {Object.entries(stats.postsByType).map(([type, count]) => (
                            <View key={type} style={styles.typeRow}>
                                <Text style={[styles.typeLabel, { color: theme.colors.textSecondary }]}>
                                    {type.charAt(0).toUpperCase() + type.slice(1)}
                                </Text>
                                <Text style={[styles.typeValue, { color: theme.colors.text }]}>{count}</Text>
                            </View>
                        ))}
                    </View>
                )}
            </ScrollView>
        );
    };

    const renderEngagementTab = () => {
        if (!engagementRatios) return null;

        return (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {/* Engagement Ratios */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Engagement Ratios</Text>

                    <View style={[styles.ratioCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary }]}>Overall Engagement</Text>
                        <Text style={[styles.ratioValue, { color: theme.colors.primary }]}>
                            {engagementRatios.ratios.engagementRate.toFixed(2)}%
                        </Text>
                    </View>

                    <View style={[styles.ratioCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary }]}>Like Rate</Text>
                        <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                            {engagementRatios.ratios.likeRate.toFixed(2)}%
                        </Text>
                    </View>

                    <View style={[styles.ratioCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary }]}>Reply Rate</Text>
                        <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                            {engagementRatios.ratios.replyRate.toFixed(2)}%
                        </Text>
                    </View>

                    <View style={[styles.ratioCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary }]}>Repost Rate</Text>
                        <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                            {engagementRatios.ratios.repostRate.toFixed(2)}%
                        </Text>
                    </View>
                </View>

                {/* Averages */}
                <View style={styles.section}>
                    <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Averages</Text>
                    <View style={[styles.averageCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Text style={[styles.averageLabel, { color: theme.colors.textSecondary }]}>
                            Views per Post
                        </Text>
                        <Text style={[styles.averageValue, { color: theme.colors.text }]}>
                            {engagementRatios.averages.viewsPerPost.toFixed(0)}
                        </Text>
                    </View>
                    <View style={[styles.averageCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <Text style={[styles.averageLabel, { color: theme.colors.textSecondary }]}>
                            Engagement per Post
                        </Text>
                        <Text style={[styles.averageValue, { color: theme.colors.text }]}>
                            {engagementRatios.averages.engagementPerPost.toFixed(1)}
                        </Text>
                    </View>
                </View>
            </ScrollView>
        );
    };

    return (
        <ThemedView style={styles.container}>
            {/* Header */}
            <View style={[styles.header, { paddingTop: insets.top, backgroundColor: theme.colors.background }]}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
                    <Ionicons name="arrow-back" size={24} color={theme.colors.text} />
                </TouchableOpacity>
                <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Statistics</Text>
                <View style={styles.headerRight} />
            </View>

            {/* Period Selector */}
            <View style={[styles.periodSelector, { backgroundColor: theme.colors.backgroundSecondary }]}>
                {PERIOD_OPTIONS.map(option => (
                    <TouchableOpacity
                        key={option.value}
                        style={[
                            styles.periodButton,
                            selectedPeriod === option.value && { backgroundColor: theme.colors.primary }
                        ]}
                        onPress={() => setSelectedPeriod(option.value)}
                    >
                        <Text
                            style={[
                                styles.periodButtonText,
                                {
                                    color: selectedPeriod === option.value
                                        ? '#FFFFFF'
                                        : theme.colors.textSecondary
                                }
                            ]}
                        >
                            {option.label}
                        </Text>
                    </TouchableOpacity>
                ))}
            </View>

            {/* Tabs */}
            <View style={[styles.tabs, { backgroundColor: theme.colors.backgroundSecondary }]}>
                <TouchableOpacity
                    style={[
                        styles.tab,
                        activeTab === 'overview' && styles.activeTab,
                        activeTab === 'overview' && { borderBottomColor: theme.colors.primary }
                    ]}
                    onPress={() => setActiveTab('overview')}
                >
                    <Text
                        style={[
                            styles.tabText,
                            {
                                color: activeTab === 'overview' ? theme.colors.primary : theme.colors.textSecondary
                            }
                        ]}
                    >
                        Overview
                    </Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[
                        styles.tab,
                        activeTab === 'engagement' && styles.activeTab,
                        activeTab === 'engagement' && { borderBottomColor: theme.colors.primary }
                    ]}
                    onPress={() => setActiveTab('engagement')}
                >
                    <Text
                        style={[
                            styles.tabText,
                            {
                                color: activeTab === 'engagement' ? theme.colors.primary : theme.colors.textSecondary
                            }
                        ]}
                    >
                        Engagement
                    </Text>
                </TouchableOpacity>
            </View>

            {/* Content */}
            {loading ? (
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                </View>
            ) : (
                activeTab === 'overview' ? renderOverviewTab() : renderEngagementTab()
            )}
        </ThemedView>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(0, 0, 0, 0.1)',
    },
    backButton: {
        padding: 8,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
    },
    headerRight: {
        width: 40,
    },
    periodSelector: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    periodButton: {
        paddingHorizontal: 16,
        paddingVertical: 6,
        borderRadius: 16,
        marginRight: 8,
    },
    periodButtonText: {
        fontSize: 14,
        fontWeight: '500',
    },
    tabs: {
        flexDirection: 'row',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(0, 0, 0, 0.1)',
    },
    tab: {
        flex: 1,
        paddingVertical: 12,
        alignItems: 'center',
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    activeTab: {
        borderBottomWidth: 2,
    },
    tabText: {
        fontSize: 16,
        fontWeight: '600',
    },
    scrollContent: {
        flex: 1,
        padding: 16,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    overviewGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginBottom: 24,
    },
    statCard: {
        width: (width - 44) / 2,
        padding: 16,
        borderRadius: 12,
        alignItems: 'center',
        marginRight: 12,
        marginBottom: 12,
    },
    statCardLast: {
        marginRight: 0,
    },
    statValue: {
        fontSize: 24,
        fontWeight: '700',
        marginTop: 8,
    },
    statLabel: {
        fontSize: 12,
        fontWeight: '500',
        marginTop: 8,
    },
    section: {
        marginBottom: 24,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 8,
    },
    engagementContainer: {
        alignItems: 'center',
        paddingVertical: 16,
    },
    engagementValue: {
        fontSize: 36,
        fontWeight: '700',
    },
    engagementLabel: {
        fontSize: 14,
        marginTop: 4,
    },
    postWrapper: {
        marginBottom: 16,
        position: 'relative',
    },
    postRankBadge: {
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 10,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        borderRadius: 12,
        paddingHorizontal: 8,
        paddingVertical: 4,
    },
    rankBadgeText: {
        fontSize: 12,
        fontWeight: '700',
        color: '#FFFFFF',
    },
    postContainer: {
        marginTop: 0,
    },
    loadingPosts: {
        padding: 20,
        alignItems: 'center',
    },
    emptyPosts: {
        padding: 20,
        alignItems: 'center',
    },
    emptyPostsText: {
        fontSize: 14,
    },
    postItem: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: 12,
        borderRadius: 8,
        marginBottom: 8,
    },
    postRank: {
        width: 32,
        alignItems: 'center',
    },
    rankNumber: {
        fontSize: 14,
        fontWeight: '600',
    },
    postStats: {
        flex: 1,
        flexDirection: 'row',
        marginLeft: 12,
    },
    postStatRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginRight: 16,
    },
    postStatText: {
        fontSize: 14,
        fontWeight: '500',
    },
    typeRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingVertical: 8,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: 'rgba(0, 0, 0, 0.1)',
    },
    typeLabel: {
        fontSize: 14,
    },
    typeValue: {
        fontSize: 14,
        fontWeight: '600',
    },
    ratioCard: {
        padding: 16,
        borderRadius: 8,
        marginBottom: 12,
    },
    ratioLabel: {
        fontSize: 14,
        marginBottom: 4,
    },
    ratioValue: {
        fontSize: 24,
        fontWeight: '700',
    },
    averageCard: {
        padding: 16,
        borderRadius: 8,
        marginBottom: 12,
    },
    averageLabel: {
        fontSize: 14,
        marginBottom: 4,
    },
    averageValue: {
        fontSize: 20,
        fontWeight: '600',
    },
});

export default StatisticsScreen;

