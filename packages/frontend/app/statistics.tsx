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
import { formatCompactNumber } from '@/utils/formatNumber';

const { width } = Dimensions.get('window');

const PERIOD_OPTIONS = [
    { label: '7 Days', value: 7 },
    { label: '30 Days', value: 30 },
    { label: '90 Days', value: 90 }
];

const InsightsScreen: React.FC = () => {
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


    const renderOverviewTab = () => {
        if (!stats) return null;

        return (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {/* Summary Stats */}
                <View style={styles.summarySection}>
                    <View style={[styles.summaryCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <View style={styles.summaryRow}>
                            <View style={styles.summaryItem}>
                                <Text style={[styles.summaryValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(stats.overview.totalPosts)}
                                </Text>
                                <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>Posts</Text>
                            </View>
                            <View style={styles.summaryDivider} />
                            <View style={styles.summaryItem}>
                                <Text style={[styles.summaryValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(stats.overview.totalViews)}
                                </Text>
                                <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>Views</Text>
                            </View>
                            <View style={styles.summaryDivider} />
                            <View style={styles.summaryItem}>
                                <Text style={[styles.summaryValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(stats.overview.totalInteractions)}
                                </Text>
                                <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>Interactions</Text>
                            </View>
                        </View>
                    </View>
                </View>

                {/* Engagement Rate - Hero Card */}
                <View style={[styles.heroCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <View style={styles.heroHeader}>
                        <Ionicons name="trending-up" size={24} color={theme.colors.primary} />
                        <Text style={[styles.heroTitle, { color: theme.colors.text }]}>Engagement Rate</Text>
                    </View>
                    <View style={styles.heroContent}>
                        <Text style={[styles.heroValue, { color: theme.colors.primary }]}>
                            {stats.overview.engagementRate.toFixed(2)}%
                        </Text>
                        <Text style={[styles.heroSubtext, { color: theme.colors.textSecondary }]}>
                            {formatCompactNumber(stats.overview.totalInteractions)} total interactions
                        </Text>
                    </View>
                </View>

                {/* Interactions */}
                <View style={styles.interactionsSection}>
                    <View style={styles.sectionHeaderRow}>
                        <Ionicons name="heart" size={20} color={theme.colors.primary} />
                        <Text style={[styles.sectionHeader, { color: theme.colors.text, marginLeft: 8 }]}>
                            Interactions
                        </Text>
                    </View>
                    <View style={[styles.interactionsCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <View style={styles.interactionsRow}>
                            <View style={styles.interactionItem}>
                                <View style={styles.interactionIconWrapper}>
                                    <View style={[styles.interactionIconBg, { backgroundColor: 'rgba(255, 48, 64, 0.15)' }]}>
                                        <Ionicons name="heart" size={18} color="#FF3040" />
                                    </View>
                                </View>
                                <View style={styles.interactionContent}>
                                    <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                        {formatCompactNumber(stats.interactions.likes)}
                                    </Text>
                                    <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>Likes</Text>
                                    {stats.interactions.likes > 0 && stats.overview.totalInteractions > 0 && (
                                        <Text style={[styles.interactionPercent, { color: theme.colors.textSecondary }]}>
                                            {((stats.interactions.likes / stats.overview.totalInteractions) * 100).toFixed(1)}%
                                        </Text>
                                    )}
                                </View>
                            </View>

                            <View style={styles.interactionItem}>
                                <View style={styles.interactionIconWrapper}>
                                    <View style={[styles.interactionIconBg, { backgroundColor: 'rgba(59, 130, 246, 0.15)' }]}>
                                        <Ionicons name="chatbubble" size={18} color="#3B82F6" />
                                    </View>
                                </View>
                                <View style={styles.interactionContent}>
                                    <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                        {formatCompactNumber(stats.interactions.replies)}
                                    </Text>
                                    <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>Replies</Text>
                                    {stats.interactions.replies > 0 && stats.overview.totalInteractions > 0 && (
                                        <Text style={[styles.interactionPercent, { color: theme.colors.textSecondary }]}>
                                            {((stats.interactions.replies / stats.overview.totalInteractions) * 100).toFixed(1)}%
                                        </Text>
                                    )}
                                </View>
                            </View>
                        </View>

                        <View style={[styles.interactionsDivider, { backgroundColor: theme.colors.border }]} />

                        <View style={styles.interactionsRow}>
                            <View style={styles.interactionItem}>
                                <View style={styles.interactionIconWrapper}>
                                    <View style={[styles.interactionIconBg, { backgroundColor: 'rgba(16, 185, 129, 0.15)' }]}>
                                        <Ionicons name="repeat" size={18} color="#10B981" />
                                    </View>
                                </View>
                                <View style={styles.interactionContent}>
                                    <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                        {formatCompactNumber(stats.interactions.reposts)}
                                    </Text>
                                    <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>Reposts</Text>
                                    {stats.interactions.reposts > 0 && stats.overview.totalInteractions > 0 && (
                                        <Text style={[styles.interactionPercent, { color: theme.colors.textSecondary }]}>
                                            {((stats.interactions.reposts / stats.overview.totalInteractions) * 100).toFixed(1)}%
                                        </Text>
                                    )}
                                </View>
                            </View>

                            <View style={styles.interactionItem}>
                                <View style={styles.interactionIconWrapper}>
                                    <View style={[styles.interactionIconBg, { backgroundColor: 'rgba(139, 92, 246, 0.15)' }]}>
                                        <Ionicons name="share-social" size={18} color="#8B5CF6" />
                                    </View>
                                </View>
                                <View style={styles.interactionContent}>
                                    <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                        {formatCompactNumber(stats.interactions.shares)}
                                    </Text>
                                    <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>Shares</Text>
                                    {stats.interactions.shares > 0 && stats.overview.totalInteractions > 0 && (
                                        <Text style={[styles.interactionPercent, { color: theme.colors.textSecondary }]}>
                                            {((stats.interactions.shares / stats.overview.totalInteractions) * 100).toFixed(1)}%
                                        </Text>
                                    )}
                                </View>
                            </View>
                        </View>
                    </View>
                </View>

                {/* Top Posts */}
                {stats.topPosts.length > 0 && (
                    <View style={styles.topPostsSection}>
                        <View style={styles.sectionHeaderRow}>
                            <Ionicons name="trophy" size={20} color={theme.colors.primary} />
                            <Text style={[styles.sectionHeader, { color: theme.colors.text, marginLeft: 8 }]}>
                                Top Performing Posts
                            </Text>
                        </View>
                        {loadingTopPosts ? (
                            <View style={styles.loadingPosts}>
                                <ActivityIndicator size="small" color={theme.colors.primary} />
                            </View>
                        ) : topPostsData.length > 0 ? (
                            topPostsData.map((post, index) => (
                                <View key={post.id} style={styles.postWrapper}>
                                    <View style={[
                                        styles.postRankBadge,
                                        index === 0 && styles.postRankBadgeGold,
                                        index === 1 && styles.postRankBadgeSilver,
                                        index === 2 && styles.postRankBadgeBronze
                                    ]}>
                                        <Ionicons 
                                            name={index === 0 ? "trophy" : index === 1 ? "medal" : "ribbon"} 
                                            size={14} 
                                            color="#FFFFFF" 
                                        />
                                        <Text style={[styles.rankBadgeText, { marginLeft: 4 }]}>
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
                                <Ionicons name="document-outline" size={48} color={theme.colors.textSecondary} />
                                <Text style={[styles.emptyPostsText, { color: theme.colors.textSecondary }]}>
                                    Unable to load posts
                                </Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Posts by Type */}
                {Object.keys(stats.postsByType).length > 0 && (
                    <View style={styles.typeSection}>
                        <View style={styles.sectionHeaderRow}>
                            <Ionicons name="grid" size={20} color={theme.colors.primary} />
                            <Text style={[styles.sectionHeader, { color: theme.colors.text, marginLeft: 8 }]}>
                                Posts by Type
                            </Text>
                        </View>
                        <View style={[styles.typeCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                            {Object.entries(stats.postsByType).map(([type, count], index, array) => (
                                <View key={type}>
                                    <View style={styles.typeRow}>
                                        <View style={styles.typeLeft}>
                                            <Ionicons 
                                                name={
                                                    type === 'text' ? 'document-text' :
                                                    type === 'image' ? 'image' :
                                                    type === 'video' ? 'videocam' :
                                                    type === 'poll' ? 'bar-chart' : 'document'
                                                } 
                                                size={18} 
                                                color={theme.colors.textSecondary} 
                                            />
                                            <Text style={[styles.typeLabel, { color: theme.colors.textSecondary, marginLeft: 8 }]}>
                                                {type.charAt(0).toUpperCase() + type.slice(1)}
                                            </Text>
                                        </View>
                                        <Text style={[styles.typeValue, { color: theme.colors.text }]}>{count}</Text>
                                    </View>
                                    {index < array.length - 1 && (
                                        <View style={[styles.typeDivider, { backgroundColor: theme.colors.border }]} />
                                    )}
                                </View>
                            ))}
                        </View>
                    </View>
                )}
            </ScrollView>
        );
    };

    const renderEngagementTab = () => {
        if (!engagementRatios) return null;

        return (
            <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
                {/* Overall Engagement */}
                <View style={[styles.heroCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                    <View style={styles.heroHeader}>
                        <Ionicons name="stats-chart" size={24} color={theme.colors.primary} />
                        <Text style={[styles.heroTitle, { color: theme.colors.text }]}>Overall Engagement</Text>
                    </View>
                    <View style={styles.heroContent}>
                        <Text style={[styles.heroValue, { color: theme.colors.primary }]}>
                            {engagementRatios.ratios.engagementRate.toFixed(2)}%
                        </Text>
                        <Text style={[styles.heroSubtext, { color: theme.colors.textSecondary }]}>
                            {formatCompactNumber(engagementRatios.totals.interactions)} total interactions
                        </Text>
                    </View>
                </View>

                {/* Engagement Ratios */}
                <View style={styles.ratiosSection}>
                    <Text style={[styles.sectionHeader, { color: theme.colors.text }]}>Engagement Ratios</Text>
                    <View style={styles.ratiosGrid}>
                        <View style={[styles.ratioCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                            <View style={styles.ratioHeader}>
                                <Ionicons name="heart" size={18} color="#FF3040" />
                                <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary, marginLeft: 8 }]}>Like Rate</Text>
                            </View>
                            <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                                {engagementRatios.ratios.likeRate.toFixed(2)}%
                            </Text>
                        </View>

                        <View style={[styles.ratioCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                            <View style={styles.ratioHeader}>
                                <Ionicons name="chatbubble" size={18} color="#3B82F6" />
                                <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary, marginLeft: 8 }]}>Reply Rate</Text>
                            </View>
                            <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                                {engagementRatios.ratios.replyRate.toFixed(2)}%
                            </Text>
                        </View>

                        <View style={[styles.ratioCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                            <View style={styles.ratioHeader}>
                                <Ionicons name="repeat" size={18} color="#10B981" />
                                <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary, marginLeft: 8 }]}>Repost Rate</Text>
                            </View>
                            <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                                {engagementRatios.ratios.repostRate.toFixed(2)}%
                            </Text>
                        </View>

                        <View style={[styles.ratioCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                            <View style={styles.ratioHeader}>
                                <Ionicons name="share-social" size={18} color="#8B5CF6" />
                                <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary, marginLeft: 8 }]}>Share Rate</Text>
                            </View>
                            <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                                {engagementRatios.ratios.shareRate.toFixed(2)}%
                            </Text>
                        </View>
                    </View>
                </View>

                {/* Averages */}
                <View style={styles.averagesSection}>
                    <Text style={[styles.sectionHeader, { color: theme.colors.text }]}>Averages</Text>
                    <View style={styles.averagesGrid}>
                        <View style={[styles.averageCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                            <View style={styles.averageHeader}>
                                <Ionicons name="eye" size={20} color={theme.colors.primary} />
                                <Text style={[styles.averageLabel, { color: theme.colors.textSecondary, marginLeft: 8 }]}>
                                    Views per Post
                                </Text>
                            </View>
                            <Text style={[styles.averageValue, { color: theme.colors.text }]}>
                                {engagementRatios.averages.viewsPerPost.toFixed(0)}
                            </Text>
                        </View>
                        <View style={[styles.averageCard, styles.averageCardLast, { backgroundColor: theme.colors.backgroundSecondary }]}>
                            <View style={styles.averageHeader}>
                                <Ionicons name="trending-up" size={20} color={theme.colors.primary} />
                                <Text style={[styles.averageLabel, { color: theme.colors.textSecondary, marginLeft: 8 }]}>
                                    Engagement per Post
                                </Text>
                            </View>
                            <Text style={[styles.averageValue, { color: theme.colors.text }]}>
                                {engagementRatios.averages.engagementPerPost.toFixed(1)}
                            </Text>
                        </View>
                    </View>
                </View>

                {/* Totals Summary */}
                <View style={styles.totalsSection}>
                    <Text style={[styles.sectionHeader, { color: theme.colors.text }]}>Total Activity</Text>
                    <View style={[styles.totalsCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                        <View style={styles.totalsRow}>
                            <View style={styles.totalItem}>
                                <Text style={[styles.totalValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(engagementRatios.totals.posts)}
                                </Text>
                                <Text style={[styles.totalLabel, { color: theme.colors.textSecondary }]}>Posts</Text>
                            </View>
                            <View style={styles.totalDivider} />
                            <View style={styles.totalItem}>
                                <Text style={[styles.totalValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(engagementRatios.totals.views)}
                                </Text>
                                <Text style={[styles.totalLabel, { color: theme.colors.textSecondary }]}>Views</Text>
                            </View>
                            <View style={styles.totalDivider} />
                            <View style={styles.totalItem}>
                                <Text style={[styles.totalValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(engagementRatios.totals.interactions)}
                                </Text>
                                <Text style={[styles.totalLabel, { color: theme.colors.textSecondary }]}>Interactions</Text>
                            </View>
                        </View>
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
                <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Insights</Text>
                <View style={styles.headerRight} />
            </View>

            {/* Period Selector */}
            <View style={[styles.periodSelector, { backgroundColor: theme.colors.backgroundSecondary }]}>
                {PERIOD_OPTIONS.map(option => (
                    <TouchableOpacity
                        key={option.value}
                        style={[
                            styles.periodButton,
                            selectedPeriod === option.value && [
                                styles.periodButtonActive,
                                { backgroundColor: theme.colors.primary }
                            ]
                        ]}
                        onPress={() => setSelectedPeriod(option.value)}
                    >
                        <Text
                            style={[
                                styles.periodButtonText,
                                {
                                    color: selectedPeriod === option.value
                                        ? '#FFFFFF'
                                        : theme.colors.textSecondary,
                                    fontWeight: selectedPeriod === option.value ? '600' : '500'
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
                        activeTab === 'overview' && [
                            styles.activeTab,
                            { borderBottomColor: theme.colors.primary }
                        ]
                    ]}
                    onPress={() => setActiveTab('overview')}
                >
                    <Ionicons 
                        name={activeTab === 'overview' ? 'grid' : 'grid-outline'} 
                        size={18} 
                        color={activeTab === 'overview' ? theme.colors.primary : theme.colors.textSecondary} 
                    />
                    <Text
                        style={[
                            styles.tabText,
                            {
                                color: activeTab === 'overview' ? theme.colors.primary : theme.colors.textSecondary,
                                marginLeft: 6
                            }
                        ]}
                    >
                        Overview
                    </Text>
                </TouchableOpacity>
                <TouchableOpacity
                    style={[
                        styles.tab,
                        activeTab === 'engagement' && [
                            styles.activeTab,
                            { borderBottomColor: theme.colors.primary }
                        ]
                    ]}
                    onPress={() => setActiveTab('engagement')}
                >
                    <Ionicons 
                        name={activeTab === 'engagement' ? 'stats-chart' : 'stats-chart-outline'} 
                        size={18} 
                        color={activeTab === 'engagement' ? theme.colors.primary : theme.colors.textSecondary} 
                    />
                    <Text
                        style={[
                            styles.tabText,
                            {
                                color: activeTab === 'engagement' ? theme.colors.primary : theme.colors.textSecondary,
                                marginLeft: 6
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
        marginLeft: -8,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '700',
        letterSpacing: -0.3,
    },
    headerRight: {
        width: 40,
    },
    periodSelector: {
        flexDirection: 'row',
        paddingHorizontal: 16,
        paddingVertical: 10,
    },
    periodButton: {
        paddingHorizontal: 16,
        paddingVertical: 6,
        borderRadius: 18,
        backgroundColor: 'transparent',
        marginRight: 6,
    },
    periodButtonActive: {
        boxShadow: '0px 2px 4px 0px rgba(0, 0, 0, 0.1)',
        elevation: 3,
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
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 12,
        borderBottomWidth: 2,
        borderBottomColor: 'transparent',
    },
    activeTab: {
        borderBottomWidth: 2,
    },
    tabText: {
        fontSize: 14,
        fontWeight: '600',
    },
    scrollContent: {
        flex: 1,
        padding: 12,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    // Summary Section
    summarySection: {
        marginBottom: 16,
    },
    summaryCard: {
        borderRadius: 12,
        padding: 16,
        boxShadow: '0px 1px 4px 0px rgba(0, 0, 0, 0.08)',
        elevation: 2,
    },
    summaryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
    },
    summaryItem: {
        alignItems: 'center',
        flex: 1,
    },
    summaryDivider: {
        width: 1,
        height: 32,
        backgroundColor: 'rgba(0, 0, 0, 0.1)',
    },
    summaryValue: {
        fontSize: 20,
        fontWeight: '700',
        marginBottom: 2,
    },
    summaryLabel: {
        fontSize: 12,
        fontWeight: '500',
    },
    // Hero Card
    heroCard: {
        borderRadius: 12,
        padding: 16,
        marginBottom: 16,
        boxShadow: '0px 1px 4px 0px rgba(0, 0, 0, 0.08)',
        elevation: 2,
    },
    heroHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    heroTitle: {
        fontSize: 16,
        fontWeight: '600',
        marginLeft: 8,
    },
    heroContent: {
        alignItems: 'center',
    },
    heroValue: {
        fontSize: 36,
        fontWeight: '700',
        letterSpacing: -0.5,
    },
    heroSubtext: {
        fontSize: 13,
        marginTop: 6,
        fontWeight: '500',
    },
    // Interactions Section
    interactionsSection: {
        marginBottom: 16,
    },
    interactionsCard: {
        borderRadius: 12,
        padding: 16,
        boxShadow: '0px 1px 4px 0px rgba(0, 0, 0, 0.08)',
        elevation: 2,
    },
    interactionsRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    interactionsDivider: {
        height: 1,
        marginVertical: 12,
    },
    interactionItem: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    interactionIconWrapper: {
        marginRight: 12,
    },
    interactionIconBg: {
        width: 36,
        height: 36,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    interactionContent: {
        flex: 1,
    },
    interactionValue: {
        fontSize: 18,
        fontWeight: '700',
        marginBottom: 2,
    },
    interactionLabel: {
        fontSize: 12,
        fontWeight: '500',
        marginBottom: 2,
    },
    interactionPercent: {
        fontSize: 10,
        fontWeight: '500',
    },
    // Overview Section
    overviewSection: {
        marginBottom: 24,
    },
    sectionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 12,
    },
    sectionHeader: {
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: -0.2,
    },
    overviewGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginHorizontal: -6,
    },
    statCard: {
        width: (width - 64) / 2,
        padding: 20,
        borderRadius: 16,
        alignItems: 'center',
        marginHorizontal: 6,
        marginBottom: 12,
        boxShadow: '0px 1px 4px 0px rgba(0, 0, 0, 0.08)',
        elevation: 2,
    },
    statIconContainer: {
        width: 48,
        height: 48,
        borderRadius: 24,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 12,
    },
    statValue: {
        fontSize: 28,
        fontWeight: '700',
        marginBottom: 4,
    },
    statLabel: {
        fontSize: 13,
        fontWeight: '500',
    },
    // Top Posts Section
    topPostsSection: {
        marginBottom: 16,
    },
    postWrapper: {
        marginBottom: 12,
        position: 'relative',
        borderRadius: 10,
        overflow: 'hidden',
    },
    postRankBadge: {
        position: 'absolute',
        top: 8,
        left: 8,
        zIndex: 10,
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        borderRadius: 12,
        paddingHorizontal: 8,
        paddingVertical: 4,
        flexDirection: 'row',
        alignItems: 'center',
    },
    postRankBadgeGold: {
        backgroundColor: 'rgba(255, 215, 0, 0.9)',
    },
    postRankBadgeSilver: {
        backgroundColor: 'rgba(192, 192, 192, 0.9)',
    },
    postRankBadgeBronze: {
        backgroundColor: 'rgba(205, 127, 50, 0.9)',
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
        padding: 24,
        alignItems: 'center',
    },
    emptyPosts: {
        padding: 24,
        alignItems: 'center',
    },
    emptyPostsText: {
        fontSize: 14,
        fontWeight: '500',
    },
    // Type Section
    typeSection: {
        marginBottom: 16,
    },
    typeCard: {
        borderRadius: 12,
        padding: 12,
        boxShadow: '0px 1px 4px 0px rgba(0, 0, 0, 0.08)',
        elevation: 2,
    },
    typeRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 10,
    },
    typeLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    typeLabel: {
        fontSize: 14,
        fontWeight: '500',
    },
    typeValue: {
        fontSize: 16,
        fontWeight: '700',
    },
    typeDivider: {
        height: 1,
        marginLeft: 28,
    },
    // Engagement Tab Styles
    ratiosSection: {
        marginBottom: 16,
    },
    ratiosGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginHorizontal: -4,
    },
    ratioCard: {
        width: (width - 48) / 2,
        padding: 14,
        borderRadius: 12,
        marginHorizontal: 4,
        marginBottom: 8,
        boxShadow: '0px 1px 4px 0px rgba(0, 0, 0, 0.08)',
        elevation: 2,
    },
    ratioHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 10,
    },
    ratioLabel: {
        fontSize: 12,
        fontWeight: '500',
    },
    ratioValue: {
        fontSize: 24,
        fontWeight: '700',
    },
    // Averages Section
    averagesSection: {
        marginBottom: 16,
    },
    averagesGrid: {
        flexDirection: 'row',
    },
    averageCard: {
        flex: 1,
        padding: 16,
        borderRadius: 12,
        marginRight: 8,
        boxShadow: '0px 1px 4px 0px rgba(0, 0, 0, 0.08)',
        elevation: 2,
    },
    averageCardLast: {
        marginRight: 0,
    },
    averageHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 10,
    },
    averageLabel: {
        fontSize: 13,
        fontWeight: '500',
    },
    averageValue: {
        fontSize: 22,
        fontWeight: '700',
    },
    // Totals Section
    totalsSection: {
        marginBottom: 16,
    },
    totalsCard: {
        borderRadius: 12,
        padding: 16,
        boxShadow: '0px 1px 4px 0px rgba(0, 0, 0, 0.08)',
        elevation: 2,
    },
    totalsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
    },
    totalItem: {
        alignItems: 'center',
        flex: 1,
    },
    totalDivider: {
        width: 1,
        height: 32,
        backgroundColor: 'rgba(0, 0, 0, 0.1)',
    },
    totalValue: {
        fontSize: 18,
        fontWeight: '700',
        marginBottom: 2,
    },
    totalLabel: {
        fontSize: 12,
        fontWeight: '500',
    },
    // Legacy styles (kept for compatibility)
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
});

export default InsightsScreen;

