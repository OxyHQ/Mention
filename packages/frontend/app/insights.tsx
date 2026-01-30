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
import Animated, { useAnimatedStyle, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { ThemedView } from '@/components/ThemedView';
import { statisticsService, UserStatistics, EngagementRatios } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { usePostsStore } from '@/stores/postsStore';
import PostItem from '@/components/Feed/PostItem';
import { UIPost } from '@mention/shared-types';
import MiniChart from '@/components/MiniChart';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import SectionHeader from '@/components/insights/SectionHeader';
import HeroCard from '@/components/insights/HeroCard';
import SummaryCard from '@/components/insights/SummaryCard';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { formatCompactNumber } from '@/utils/formatNumber';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { StatusBar } from 'expo-status-bar';
import SEO from '@/components/SEO';

const { width } = Dimensions.get('window');

const PERIOD_OPTIONS = [
    { labelKey: 'insights.period.7days', value: 7 },
    { labelKey: 'insights.period.30days', value: 30 },
    { labelKey: 'insights.period.90days', value: 90 }
];

interface PeriodButtonProps {
    option: { labelKey: string; value: number };
    isActive: boolean;
    onPress: () => void;
    theme: any;
    t: (key: string) => string;
}

const PeriodButton: React.FC<PeriodButtonProps> = ({ option, isActive, onPress, theme, t }) => {
    const animatedStyle = useAnimatedStyle(() => {
        return {
            backgroundColor: withSpring(
                isActive ? theme.colors.primary : 'transparent',
                {
                    damping: 30,
                    stiffness: 800,
                    mass: 0.3,
                }
            ),
        };
    });

    const textAnimatedStyle = useAnimatedStyle(() => {
        return {
            color: withSpring(
                isActive ? '#FFFFFF' : theme.colors.text,
                {
                    damping: 30,
                    stiffness: 800,
                    mass: 0.3,
                }
            ),
        };
    });

    return (
        <TouchableOpacity
            style={[
                styles.periodButton,
                isActive && styles.periodButtonActive,
            ]}
            onPress={onPress}
            activeOpacity={0.7}
        >
            <Animated.View style={[StyleSheet.absoluteFill, animatedStyle, styles.periodButtonBackground]} />
            <Animated.Text
                style={[
                    styles.periodButtonText,
                    textAnimatedStyle,
                    {
                        fontWeight: isActive ? '700' : '500'
                    }
                ]}
            >
                {t(option.labelKey)}
            </Animated.Text>
        </TouchableOpacity>
    );
};

const InsightsScreen: React.FC = () => {
    const { t } = useTranslation();
    const theme = useTheme();
    const { user } = useAuth();

    const [loading, setLoading] = useState(true);
    const [stats, setStats] = useState<UserStatistics | null>(null);
    const [engagementRatios, setEngagementRatios] = useState<EngagementRatios | null>(null);
    const [selectedPeriod, setSelectedPeriod] = useState(30);
    const [activeTab, setActiveTab] = useState<'overview' | 'engagement'>('overview');
    const [topPostsData, setTopPostsData] = useState<UIPost[]>([]);
    const [loadingTopPosts, setLoadingTopPosts] = useState(false);
    const [isLoadingPeriod, setIsLoadingPeriod] = useState(false);

    const { getPostById } = usePostsStore();

    const loadStatistics = useCallback(async (isPeriodChange = false) => {
        if (!user) return;

        try {
            if (isPeriodChange) {
                setIsLoadingPeriod(true);
            } else {
                setLoading(true);
            }
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
                        } catch (error: any) {
                            // Silently handle 404s and other errors - post may have been deleted
                            if (error?.response?.status !== 404) {
                                console.error(`Error loading post ${postInfo.postId}:`, error);
                            }
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
            setIsLoadingPeriod(false);
        }
    }, [selectedPeriod, user, getPostById]);

    useEffect(() => {
        // Only load on initial mount, period changes are handled by button press
        if (!stats && !engagementRatios) {
            loadStatistics();
        }
    }, []);


    const renderOverviewTab = () => {
        if (!stats) return null;

        return (
            <ScrollView 
                style={styles.scrollContent} 
                showsVerticalScrollIndicator={false}
            >
                {/* Period Selector - scrolls, appears between header and tabs */}
                <View style={[styles.periodSelectorContainer, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    {PERIOD_OPTIONS.map((option) => (
                        <PeriodButton
                            key={option.value}
                            option={option}
                            isActive={selectedPeriod === option.value}
                            onPress={() => {
                                if (selectedPeriod !== option.value) {
                                    setSelectedPeriod(option.value);
                                    loadStatistics(true);
                                }
                            }}
                            theme={theme}
                            t={t}
                        />
                    ))}
                </View>

                {/* Weekly Recap Banner */}
                <TouchableOpacity
                    style={[styles.weeklyRecapBanner, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}
                    onPress={() => router.push('/insights/weekly_recap')}
                    activeOpacity={0.8}
                >
                    <View style={styles.bannerContent}>
                        <View style={styles.bannerLeft}>
                            <Ionicons name="calendar" size={20} color={theme.colors.primary} />
                            <View style={styles.bannerTextContainer}>
                                <Text style={[styles.bannerTitle, { color: theme.colors.text }]}>{t('insights.weeklyRecap.ready')}</Text>
                                <Text style={[styles.bannerSubtitle, { color: theme.colors.textSecondary }]}>{t('insights.weeklyRecap.subtitle')}</Text>
                            </View>
                        </View>
                        <Ionicons name="chevron-forward" size={20} color={theme.colors.textSecondary} />
                    </View>
                </TouchableOpacity>

                {/* Summary Stats */}
                <View style={styles.summarySection}>
                    <SummaryCard
                        items={[
                            { value: stats.overview.totalPosts, label: t('insights.posts') },
                            { value: stats.overview.totalViews, label: t('insights.post.views') },
                            { value: stats.overview.totalInteractions, label: t('insights.post.interactions') },
                        ]}
                        chartData={stats.dailyBreakdown ? stats.dailyBreakdown.slice(-7).map(d => d.views) : undefined}
                        showChart={!!stats.dailyBreakdown && stats.dailyBreakdown.length > 0}
                    />
                </View>

                {/* Engagement Rate */}
                <View style={styles.engagementRateSection}>
                    <SectionHeader title={t('insights.post.engagementRate')} />
                    <View style={[styles.engagementRateCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        <View style={styles.engagementRateHeader}>
                            <Ionicons name="trending-up" size={20} color={theme.colors.primary} />
                            {stats.overview.totalViews > 0 && (
                                <Text style={[styles.engagementRateStat, { color: theme.colors.textSecondary }]}>
                                    {formatCompactNumber(stats.overview.totalViews)} {t('insights.post.views').toLowerCase()}
                                </Text>
                            )}
                        </View>
                        <Text style={[styles.engagementRateValue, { color: theme.colors.text }]}>
                            {stats.overview.engagementRate.toFixed(2)}%
                        </Text>
                        <Text style={[styles.engagementRateLabel, { color: theme.colors.textSecondary }]}>{t('insights.post.engagementRate')}</Text>
                        <View style={[styles.engagementRateStats, { borderTopColor: theme.colors.border }]}>
                            <View style={styles.engagementRateStatItem}>
                                <Text style={[styles.engagementRateStatValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(stats.overview.totalInteractions)}
                                </Text>
                                <Text style={[styles.engagementRateStatLabel, { color: theme.colors.textSecondary }]}>{t('insights.post.totalInteractions')}</Text>
                            </View>
                            {stats.overview.totalPosts > 0 && (
                                <View style={styles.engagementRateStatItem}>
                                    <Text style={[styles.engagementRateStatValue, { color: theme.colors.text }]}>
                                        {(stats.overview.averageEngagementPerPost).toFixed(1)}
                                    </Text>
                                    <Text style={[styles.engagementRateStatLabel, { color: theme.colors.textSecondary }]}>{t('insights.avgPerPost')}</Text>
                                </View>
                            )}
                        </View>
                    </View>
                </View>

                {/* Interactions */}
                <View style={styles.interactionsSection}>
                    <SectionHeader title={t('insights.post.interactions')} />
                    <View style={styles.interactionsGrid}>
                        <View style={[styles.interactionCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.interactionCardHeader}>
                                <Ionicons name="heart" size={20} color="#FF3040" />
                                {stats.interactions.likes > 0 && stats.overview.totalInteractions > 0 && (
                                    <Text style={[styles.interactionStat, { color: theme.colors.textSecondary }]}>
                                        {((stats.interactions.likes / stats.overview.totalInteractions) * 100).toFixed(1)}%
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                {formatCompactNumber(stats.interactions.likes)}
                            </Text>
                            <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>{t('insights.post.likes')}</Text>
                            {stats.overview.totalPosts > 0 && (
                                <Text style={[styles.interactionSubStat, { color: theme.colors.textSecondary }]}>
                                    {(stats.interactions.likes / stats.overview.totalPosts).toFixed(1)} {t('insights.perPost')}
                                </Text>
                            )}
                        </View>

                        <View style={[styles.interactionCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.interactionCardHeader}>
                                <Ionicons name="chatbubble" size={20} color={theme.colors.primary} />
                                {stats.interactions.replies > 0 && stats.overview.totalInteractions > 0 && (
                                    <Text style={[styles.interactionStat, { color: theme.colors.textSecondary }]}>
                                        {((stats.interactions.replies / stats.overview.totalInteractions) * 100).toFixed(1)}%
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                {formatCompactNumber(stats.interactions.replies)}
                            </Text>
                            <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>{t('insights.post.replies')}</Text>
                            {stats.overview.totalPosts > 0 && (
                                <Text style={[styles.interactionSubStat, { color: theme.colors.textSecondary }]}>
                                    {(stats.interactions.replies / stats.overview.totalPosts).toFixed(1)} {t('insights.perPost')}
                                </Text>
                            )}
                        </View>

                        <View style={[styles.interactionCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.interactionCardHeader}>
                                <Ionicons name="repeat" size={20} color={theme.colors.primary} />
                                {stats.interactions.reposts > 0 && stats.overview.totalInteractions > 0 && (
                                    <Text style={[styles.interactionStat, { color: theme.colors.textSecondary }]}>
                                        {((stats.interactions.reposts / stats.overview.totalInteractions) * 100).toFixed(1)}%
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                {formatCompactNumber(stats.interactions.reposts)}
                            </Text>
                            <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>{t('insights.post.reposts')}</Text>
                            {stats.overview.totalPosts > 0 && (
                                <Text style={[styles.interactionSubStat, { color: theme.colors.textSecondary }]}>
                                    {(stats.interactions.reposts / stats.overview.totalPosts).toFixed(1)} {t('insights.perPost')}
                                </Text>
                            )}
                        </View>

                        <View style={[styles.interactionCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.interactionCardHeader}>
                                <Ionicons name="share-social" size={20} color={theme.colors.primary} />
                                {stats.interactions.shares > 0 && stats.overview.totalInteractions > 0 && (
                                    <Text style={[styles.interactionStat, { color: theme.colors.textSecondary }]}>
                                        {((stats.interactions.shares / stats.overview.totalInteractions) * 100).toFixed(1)}%
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                {formatCompactNumber(stats.interactions.shares)}
                            </Text>
                            <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>{t('insights.post.shares')}</Text>
                            {stats.overview.totalPosts > 0 && (
                                <Text style={[styles.interactionSubStat, { color: theme.colors.textSecondary }]}>
                                    {(stats.interactions.shares / stats.overview.totalPosts).toFixed(1)} {t('insights.perPost')}
                                </Text>
                            )}
                        </View>
                    </View>
                </View>

                {/* Top Posts */}
                {stats.topPosts.length > 0 && (
                    <View style={styles.topPostsSection}>
                        <SectionHeader icon="trophy" title={t('insights.topPerformingPosts')} />
                        {loadingTopPosts ? (
                            <View style={styles.loadingPosts}>
                                <ActivityIndicator size="small" color={theme.colors.primary} />
                            </View>
                        ) : topPostsData.length > 0 ? (
                            topPostsData.map((post, index) => (
                                <View key={post.id} style={styles.postRowContainer}>
                                    <View style={[styles.postRankHeader, { backgroundColor: theme.colors.background }]}>
                                        <Text style={[styles.postRankTitle, { color: theme.colors.text }]}>
                                            #{index + 1}
                                        </Text>
                                    </View>
                                    <View style={[styles.postWrapper, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                                        <PostItem post={post} style={styles.postItemStyle} />
                                    </View>
                                </View>
                            ))
                        ) : (
                            <View style={styles.emptyPosts}>
                                <Ionicons name="document-outline" size={48} color={theme.colors.textSecondary} />
                                <Text style={[styles.emptyPostsText, { color: theme.colors.textSecondary }]}>
                                    {t('insights.unableToLoadPosts')}
                                </Text>
                            </View>
                        )}
                    </View>
                )}

                {/* Posts by Type */}
                {Object.keys(stats.postsByType).length > 0 && (
                    <View style={styles.typeSection}>
                        <SectionHeader title={t('insights.postsByType')} />
                        <View style={[styles.typeCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            {Object.entries(stats.postsByType).map(([type, count], index, array) => {
                                const totalPosts = stats.overview.totalPosts;
                                const percentage = totalPosts > 0 ? ((count / totalPosts) * 100).toFixed(1) : '0';
                                const getIconName = () => {
                                    if (type === 'text') return 'document-text';
                                    if (type === 'image') return 'image';
                                    if (type === 'video') return 'videocam';
                                    if (type === 'poll') return 'bar-chart';
                                    return 'document';
                                };
                                const getIconColor = () => {
                                    if (type === 'text') return theme.colors.primary;
                                    if (type === 'image') return '#10B981';
                                    if (type === 'video') return '#EF4444';
                                    if (type === 'poll') return '#F59E0B';
                                    return theme.colors.primary;
                                };
                                
                                return (
                                    <View key={type}>
                                        <View style={[
                                            styles.typeRow,
                                            index === 0 && styles.typeRowFirst,
                                            index === array.length - 1 && styles.typeRowLast
                                        ]}>
                                            <View style={styles.typeLeft}>
                                                <Ionicons 
                                                    name={getIconName() as any} 
                                                    size={20} 
                                                    color={getIconColor()} 
                                                />
                                                <Text style={[styles.typeLabel, { color: theme.colors.text, marginLeft: 12 }]}>
                                                    {t(`insights.postType.${type}`)}
                                                </Text>
                                            </View>
                                            <View style={styles.typeRight}>
                                                <Text style={[styles.typeValue, { color: theme.colors.text }]}>{count}</Text>
                                                <Text style={[styles.typePercentage, { color: theme.colors.textSecondary }]}>
                                                    {percentage}%
                                                </Text>
                                            </View>
                                        </View>
                                        {index < array.length - 1 && (
                                            <View style={[styles.typeDivider, { backgroundColor: theme.colors.border }]} />
                                        )}
                                    </View>
                                );
                            })}
                        </View>
                    </View>
                )}
            </ScrollView>
        );
    };

    const renderEngagementTab = () => {
        if (!engagementRatios) return null;

        return (
            <ScrollView 
                style={styles.scrollContent} 
                showsVerticalScrollIndicator={false}
            >
                {/* Period Selector - scrolls, appears between header and tabs */}
                <View style={[styles.periodSelectorContainer, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                    {PERIOD_OPTIONS.map((option) => (
                        <PeriodButton
                            key={option.value}
                            option={option}
                            isActive={selectedPeriod === option.value}
                            onPress={() => {
                                if (selectedPeriod !== option.value) {
                                    setSelectedPeriod(option.value);
                                    loadStatistics(true);
                                }
                            }}
                            theme={theme}
                            t={t}
                        />
                    ))}
                </View>

                {/* Overall Engagement */}
                <View style={styles.engagementRateSection}>
                    <SectionHeader title={t('insights.overallEngagement')} />
                    <View style={[styles.engagementRateCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        <View style={styles.engagementRateHeader}>
                            <Ionicons name="stats-chart" size={20} color={theme.colors.primary} />
                            {engagementRatios.totals.views > 0 && (
                                <Text style={[styles.engagementRateStat, { color: theme.colors.textSecondary }]}>
                                    {formatCompactNumber(engagementRatios.totals.views)} {t('insights.post.views').toLowerCase()}
                                </Text>
                            )}
                        </View>
                        <Text style={[styles.engagementRateValue, { color: theme.colors.text }]}>
                            {engagementRatios.ratios.engagementRate.toFixed(2)}%
                        </Text>
                        <Text style={[styles.engagementRateLabel, { color: theme.colors.textSecondary }]}>{t('insights.post.engagementRate')}</Text>
                        <View style={[styles.engagementRateStats, { borderTopColor: theme.colors.border }]}>
                            <View style={styles.engagementRateStatItem}>
                                <Text style={[styles.engagementRateStatValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(engagementRatios.totals.interactions)}
                                </Text>
                                <Text style={[styles.engagementRateStatLabel, { color: theme.colors.textSecondary }]}>{t('insights.post.totalInteractions')}</Text>
                            </View>
                            {engagementRatios.totals.posts > 0 && (
                                <View style={styles.engagementRateStatItem}>
                                    <Text style={[styles.engagementRateStatValue, { color: theme.colors.text }]}>
                                        {(engagementRatios.averages.engagementPerPost).toFixed(1)}
                                    </Text>
                                    <Text style={[styles.engagementRateStatLabel, { color: theme.colors.textSecondary }]}>{t('insights.avgPerPost')}</Text>
                                </View>
                            )}
                        </View>
                    </View>
                </View>

                {/* Engagement Ratios */}
                <View style={styles.ratiosSection}>
                    <SectionHeader title={t('insights.engagementRatios')} />
                    <View style={styles.ratiosGrid}>
                        <View style={[styles.ratioCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.ratioCardHeader}>
                                <Ionicons name="heart" size={20} color="#FF3040" />
                                {engagementRatios.totals.views > 0 && (
                                    <Text style={[styles.ratioStat, { color: theme.colors.textSecondary }]}>
                                        {((engagementRatios.totals.likes / engagementRatios.totals.views) * 100).toFixed(1)}% {t('insights.ofViews')}
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                                {engagementRatios.ratios.likeRate.toFixed(2)}%
                            </Text>
                            <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary }]}>{t('insights.likeRate')}</Text>
                        </View>

                        <View style={[styles.ratioCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.ratioCardHeader}>
                                <Ionicons name="chatbubble" size={20} color={theme.colors.primary} />
                                {engagementRatios.totals.views > 0 && (
                                    <Text style={[styles.ratioStat, { color: theme.colors.textSecondary }]}>
                                        {((engagementRatios.totals.replies / engagementRatios.totals.views) * 100).toFixed(1)}% {t('insights.ofViews')}
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                                {engagementRatios.ratios.replyRate.toFixed(2)}%
                            </Text>
                            <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary }]}>{t('insights.replyRate')}</Text>
                        </View>

                        <View style={[styles.ratioCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.ratioCardHeader}>
                                <Ionicons name="repeat" size={20} color={theme.colors.primary} />
                                {engagementRatios.totals.views > 0 && (
                                    <Text style={[styles.ratioStat, { color: theme.colors.textSecondary }]}>
                                        {((engagementRatios.totals.reposts / engagementRatios.totals.views) * 100).toFixed(1)}% {t('insights.ofViews')}
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                                {engagementRatios.ratios.repostRate.toFixed(2)}%
                            </Text>
                            <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary }]}>{t('insights.repostRate')}</Text>
                        </View>

                        <View style={[styles.ratioCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.ratioCardHeader}>
                                <Ionicons name="share-social" size={20} color={theme.colors.primary} />
                                {engagementRatios.totals.views > 0 && (
                                    <Text style={[styles.ratioStat, { color: theme.colors.textSecondary }]}>
                                        {((engagementRatios.totals.shares / engagementRatios.totals.views) * 100).toFixed(1)}% {t('insights.ofViews')}
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.ratioValue, { color: theme.colors.text }]}>
                                {engagementRatios.ratios.shareRate.toFixed(2)}%
                            </Text>
                            <Text style={[styles.ratioLabel, { color: theme.colors.textSecondary }]}>{t('insights.shareRate')}</Text>
                        </View>
                    </View>
                </View>

                {/* Averages */}
                <View style={styles.averagesSection}>
                    <SectionHeader title={t('insights.averages')} />
                    <View style={styles.averagesGrid}>
                        <View style={[styles.averageCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.averageCardHeader}>
                                <Ionicons name="eye" size={20} color={theme.colors.primary} />
                                {engagementRatios.totals.posts > 0 && (
                                    <Text style={[styles.averageStat, { color: theme.colors.textSecondary }]}>
                                        {engagementRatios.totals.posts} {t('insights.posts').toLowerCase()}
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.averageValue, { color: theme.colors.text }]}>
                                {formatCompactNumber(Math.round(engagementRatios.averages.viewsPerPost))}
                            </Text>
                            <Text style={[styles.averageLabel, { color: theme.colors.textSecondary }]}>{t('insights.viewsPerPost')}</Text>
                        </View>
                        <View style={[styles.averageCard, styles.averageCardLast, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.averageCardHeader}>
                                <Ionicons name="trending-up" size={20} color={theme.colors.primary} />
                                {engagementRatios.totals.posts > 0 && (
                                    <Text style={[styles.averageStat, { color: theme.colors.textSecondary }]}>
                                        {engagementRatios.totals.posts} {t('insights.posts').toLowerCase()}
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.averageValue, { color: theme.colors.text }]}>
                                {engagementRatios.averages.engagementPerPost.toFixed(1)}
                            </Text>
                            <Text style={[styles.averageLabel, { color: theme.colors.textSecondary }]}>{t('insights.engagementPerPost')}</Text>
                        </View>
                    </View>
                </View>

                {/* Totals Summary */}
                <View style={styles.totalsSection}>
                    <SectionHeader title={t('insights.totalActivity')} />
                    <SummaryCard
                        items={[
                            { value: engagementRatios.totals.posts, label: t('insights.posts') },
                            { value: engagementRatios.totals.views, label: t('insights.post.views') },
                            { value: engagementRatios.totals.interactions, label: t('insights.post.interactions') },
                        ]}
                    />
                </View>
            </ScrollView>
        );
    };

    return (
        <>
            <SEO
                title={t('seo.insights.title')}
                description={t('seo.insights.description')}
            />
            <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]} edges={["top"]}>
                <ThemedView style={{ flex: 1 }}>
                    <StatusBar style={theme.isDark ? "light" : "dark"} />
                
                {/* Header */}
                <Header
                    options={{
                        title: t('Insights'),
                        leftComponents: [
                            <IconButton variant="icon"
                                key="back"
                                onPress={() => router.back()}
                            >
                                <BackArrowIcon size={20} color={theme.colors.text} />
                            </IconButton>,
                        ],
                    }}
                    hideBottomBorder={true}
                    disableSticky={true}
                />

                {/* Tabs - sticky */}
                <View style={[styles.stickyTabBar, { borderBottomColor: theme.colors.border }]}>
                    <AnimatedTabBar
                        tabs={[
                            { id: 'overview', label: t('insights.tabs.overview') },
                            { id: 'engagement', label: t('insights.tabs.engagement') }
                        ]}
                        activeTabId={activeTab}
                        onTabPress={(tabId) => setActiveTab(tabId as 'overview' | 'engagement')}
                    />
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
        </SafeAreaView>
        </>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    periodSelectorContainer: {
        flexDirection: 'row',
        borderRadius: 15,
        borderWidth: 1,
        padding: 4,
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 20,
        overflow: 'hidden',
    },
    periodButton: {
        flex: 1,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 11,
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 38,
        overflow: 'hidden',
        position: 'relative',
    },
    periodButtonBackground: {
        borderRadius: 11,
    },
    periodButtonActive: {
        // Active styling handled via animation
    },
    periodButtonText: {
        fontSize: 14,
        fontWeight: '500',
        letterSpacing: -0.1,
        zIndex: 1,
    },
    stickyTabBar: {
        ...Platform.select({
            web: {
                position: 'sticky',
            },
            default: {
                position: 'relative',
            },
        }),
        top: 0,
        zIndex: 100,
        backgroundColor: 'transparent',
        borderBottomWidth: 0.5,
    },
    scrollContent: {
        flex: 1,
        paddingHorizontal: 16,
        paddingTop: 0,
        paddingBottom: 20,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    // Weekly Recap Banner
    weeklyRecapBanner: {
        borderRadius: 15,
        padding: 16,
        marginBottom: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    bannerContent: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    bannerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    bannerTextContainer: {
        marginLeft: 12,
        flex: 1,
    },
    bannerTitle: {
        fontSize: 16,
        fontWeight: '700',
        marginBottom: 4,
        letterSpacing: -0.2,
    },
    bannerSubtitle: {
        fontSize: 14,
        fontWeight: '500',
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
        fontWeight: '900',
        marginBottom: 2,
    },
    summaryLabel: {
        fontSize: 12,
        fontWeight: '500',
    },
    summaryChart: {
        marginTop: 16,
    },
    // Hero Card Section
    heroSection: {
        marginBottom: 16,
    },
    // Engagement Rate Section
    engagementRateSection: {
        marginBottom: 16,
    },
    engagementRateCard: {
        borderRadius: 15,
        padding: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    engagementRateHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    engagementRateStat: {
        fontSize: 15,
        fontWeight: '700',
    },
    engagementRateValue: {
        fontSize: 32,
        fontWeight: '900',
        marginBottom: 4,
    },
    engagementRateLabel: {
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 12,
    },
    engagementRateStats: {
        flexDirection: 'row',
        gap: 16,
        paddingTop: 12,
        borderTopWidth: 0.5,
    },
    engagementRateStatItem: {
        flex: 1,
    },
    engagementRateStatValue: {
        fontSize: 20,
        fontWeight: '900',
        marginBottom: 4,
    },
    engagementRateStatLabel: {
        fontSize: 13,
        fontWeight: '500',
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
        fontWeight: '900',
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
    interactionsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
    },
    interactionCard: {
        flex: 1,
        flexBasis: '48%',
        borderRadius: 15,
        padding: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    interactionCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    interactionStat: {
        fontSize: 15,
        fontWeight: '700',
    },
    interactionValue: {
        fontSize: 28,
        fontWeight: '900',
        marginBottom: 4,
    },
    interactionLabel: {
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 4,
    },
    interactionSubStat: {
        fontSize: 13,
        fontWeight: '600',
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
    postRowContainer: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        marginBottom: 12,
        gap: 12,
    },
    postRankHeader: {
        paddingHorizontal: 8,
        paddingTop: 16,
        minWidth: 40,
        alignItems: 'flex-start',
        ...Platform.select({
            web: {
                position: 'sticky',
            },
            default: {
                position: 'relative',
            },
        }),
        top: 0,
        left: 0,
        zIndex: 10,
    },
    postRankTitle: {
        fontSize: 24,
        fontWeight: 'bold',
    },
    postWrapper: {
        flex: 1,
        borderRadius: 15,
        overflow: 'hidden',
        borderWidth: 1,
    },
    postItemStyle: {
        borderBottomWidth: 0,
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
        borderRadius: 15,
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderWidth: 1,
        overflow: 'hidden',
    },
    typeRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 12,
    },
    typeRowFirst: {
        paddingTop: 0,
    },
    typeRowLast: {
        paddingBottom: 0,
    },
    typeLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
    },
    typeRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    typeLabel: {
        fontSize: 15,
        fontWeight: '700',
    },
    typeValue: {
        fontSize: 18,
        fontWeight: '900',
    },
    typePercentage: {
        fontSize: 14,
        fontWeight: '600',
        minWidth: 45,
        textAlign: 'right',
    },
    typeDivider: {
        height: 0.5,
        marginLeft: 32,
    },
    // Engagement Tab Styles
    ratiosSection: {
        marginBottom: 16,
    },
    ratiosGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 12,
    },
    ratioCard: {
        flex: 1,
        flexBasis: '48%',
        borderRadius: 15,
        padding: 16,
        borderWidth: 1,
        overflow: 'hidden',
    },
    ratioCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    ratioStat: {
        fontSize: 15,
        fontWeight: '700',
    },
    ratioLabel: {
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 4,
    },
    ratioValue: {
        fontSize: 28,
        fontWeight: '900',
        marginBottom: 4,
    },
    // Averages Section
    averagesSection: {
        marginBottom: 16,
    },
    averagesGrid: {
        flexDirection: 'row',
        gap: 12,
    },
    averageCard: {
        flex: 1,
        padding: 16,
        borderRadius: 15,
        borderWidth: 1,
        overflow: 'hidden',
    },
    averageCardLast: {
        // Removed marginRight, using gap instead
    },
    averageCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
    },
    averageStat: {
        fontSize: 15,
        fontWeight: '700',
    },
    averageLabel: {
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 4,
    },
    averageValue: {
        fontSize: 28,
        fontWeight: '900',
        marginBottom: 4,
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
        fontWeight: '900',
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

