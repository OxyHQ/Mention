import React, { useEffect, useState, useMemo, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Platform
} from 'react-native';
import { Loading } from '@/components/ui/Loading';
import Animated, { useAnimatedStyle, withSpring } from 'react-native-reanimated';
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
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { formatCompactNumber } from '@/utils/formatNumber';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { StatusBar } from 'expo-status-bar';
import SEO from '@/components/SEO';

const PERIOD_OPTIONS = [
    { labelKey: 'insights.period.7days', value: 7 },
    { labelKey: 'insights.period.30days', value: 30 },
    { labelKey: 'insights.period.90days', value: 90 }
];

// Reusable stat row
interface StatRowProps {
    icon: string;
    iconColor: string;
    label: string;
    value: string | number;
    sub?: string;
    showDivider?: boolean;
}

const StatRow: React.FC<StatRowProps & { theme: any }> = ({ icon, iconColor, label, value, sub, showDivider = true, theme }) => (
    <View>
        <View style={styles.statRow}>
            <View style={styles.statRowLeft}>
                <Ionicons name={icon as any} size={18} color={iconColor} />
                <Text style={[styles.statRowLabel, { color: theme.colors.text }]}>{label}</Text>
            </View>
            <View style={styles.statRowRight}>
                <Text style={[styles.statRowValue, { color: theme.colors.text }]}>
                    {typeof value === 'number' ? formatCompactNumber(value) : value}
                </Text>
                {sub && (
                    <Text style={[styles.statRowSub, { color: theme.colors.textSecondary }]}>{sub}</Text>
                )}
            </View>
        </View>
        {showDivider && <View style={[styles.rowDivider, { backgroundColor: theme.colors.border }]} />}
    </View>
);

// Period pill selector
interface PeriodSelectorProps {
    selected: number;
    onSelect: (val: number) => void;
    theme: any;
    t: (key: string) => string;
}

const PeriodSelector: React.FC<PeriodSelectorProps> = ({ selected, onSelect, theme, t }) => (
    <View style={[styles.periodRow, { borderBottomColor: theme.colors.border }]}>
        {PERIOD_OPTIONS.map((opt) => {
            const active = selected === opt.value;
            return (
                <TouchableOpacity
                    key={opt.value}
                    style={[styles.periodPill, active && { backgroundColor: theme.colors.text }]}
                    onPress={() => onSelect(opt.value)}
                    activeOpacity={0.7}
                >
                    <Text style={[styles.periodPillText, { color: active ? theme.colors.background : theme.colors.textSecondary }, active && styles.periodPillTextActive]}>
                        {t(opt.labelKey)}
                    </Text>
                </TouchableOpacity>
            );
        })}
    </View>
);

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

            if (statsData.topPosts && statsData.topPosts.length > 0) {
                setLoadingTopPosts(true);
                try {
                    const postsPromises = statsData.topPosts.slice(0, 5).map(async (postInfo) => {
                        try {
                            return await getPostById(postInfo.postId);
                        } catch (error: any) {
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
        }
    }, [selectedPeriod, user, getPostById]);

    useEffect(() => {
        loadStatistics();
    }, [selectedPeriod]);

    const handlePeriodChange = useCallback((val: number) => {
        if (val !== selectedPeriod) setSelectedPeriod(val);
    }, [selectedPeriod]);

    const renderOverviewTab = () => {
        if (!stats) return null;

        const totalPosts = stats.overview.totalPosts;
        const perPost = (n: number) => totalPosts > 0 ? `${(n / totalPosts).toFixed(1)}/post` : undefined;

        return (
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
                <PeriodSelector selected={selectedPeriod} onSelect={handlePeriodChange} theme={theme} t={t} />

                {/* Weekly Recap link */}
                <TouchableOpacity
                    style={[styles.recapRow, { borderBottomColor: theme.colors.border }]}
                    onPress={() => router.push('/insights/weekly_recap')}
                    activeOpacity={0.7}
                >
                    <View style={styles.recapLeft}>
                        <Ionicons name="calendar" size={18} color={theme.colors.primary} />
                        <Text style={[styles.recapText, { color: theme.colors.text }]}>{t('insights.weeklyRecap.ready')}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>

                {/* Top-line metrics */}
                <View style={styles.topMetrics}>
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {formatCompactNumber(stats.overview.totalPosts)}
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.posts')}
                        </Text>
                    </View>
                    <View style={[styles.topMetricDivider, { backgroundColor: theme.colors.border }]} />
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {formatCompactNumber(stats.overview.totalViews)}
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.post.views')}
                        </Text>
                    </View>
                    <View style={[styles.topMetricDivider, { backgroundColor: theme.colors.border }]} />
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {stats.overview.engagementRate.toFixed(1)}%
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.post.engagementRate')}
                        </Text>
                    </View>
                </View>

                {/* Mini chart */}
                {stats.dailyBreakdown && stats.dailyBreakdown.length > 0 && (
                    <View style={styles.chartContainer}>
                        <MiniChart
                            values={stats.dailyBreakdown.slice(-7).map(d => d.views)}
                            showLabels={true}
                            height={40}
                        />
                    </View>
                )}

                {/* Interactions */}
                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                    {t('insights.post.interactions')}
                </Text>

                <StatRow icon="heart" iconColor="#FF3040" label={t('insights.post.likes')} value={stats.interactions.likes} sub={perPost(stats.interactions.likes)} theme={theme} />
                <StatRow icon="chatbubble" iconColor={theme.colors.primary} label={t('insights.post.replies')} value={stats.interactions.replies} sub={perPost(stats.interactions.replies)} theme={theme} />
                <StatRow icon="repeat" iconColor={theme.colors.primary} label={t('insights.post.reposts')} value={stats.interactions.reposts} sub={perPost(stats.interactions.reposts)} theme={theme} />
                <StatRow icon="share-social" iconColor={theme.colors.primary} label={t('insights.post.shares')} value={stats.interactions.shares} sub={perPost(stats.interactions.shares)} showDivider={false} theme={theme} />

                {/* Posts by Type */}
                {Object.keys(stats.postsByType).length > 0 && (
                    <>
                        <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.text }]}>
                            {t('insights.postsByType')}
                        </Text>
                        {Object.entries(stats.postsByType).map(([type, count], index, array) => {
                            const pct = totalPosts > 0 ? `${((count / totalPosts) * 100).toFixed(0)}%` : undefined;
                            const iconMap: Record<string, string> = { text: 'document-text', image: 'image', video: 'videocam', poll: 'bar-chart' };
                            const colorMap: Record<string, string> = { text: theme.colors.primary, image: '#10B981', video: '#EF4444', poll: '#F59E0B' };
                            return (
                                <StatRow
                                    key={type}
                                    icon={iconMap[type] || 'document'}
                                    iconColor={colorMap[type] || theme.colors.primary}
                                    label={t(`insights.postType.${type}`)}
                                    value={count}
                                    sub={pct}
                                    showDivider={index < array.length - 1}
                                    theme={theme}
                                />
                            );
                        })}
                    </>
                )}

                {/* Top Posts */}
                {stats.topPosts.length > 0 && (
                    <>
                        <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.text }]}>
                            {t('insights.topPerformingPosts')}
                        </Text>
                        {loadingTopPosts ? (
                            <View style={styles.loadingPosts}>
                                <Loading size="small" style={{ flex: undefined }} />
                            </View>
                        ) : topPostsData.length > 0 ? (
                            topPostsData.map((post, index) => (
                                <View key={post.id} style={[styles.topPostRow, index < topPostsData.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border }]}>
                                    <Text style={[styles.topPostRank, { color: theme.colors.textSecondary }]}>
                                        {index + 1}
                                    </Text>
                                    <View style={styles.topPostContent}>
                                        <PostItem post={post} style={styles.topPostItem} />
                                    </View>
                                </View>
                            ))
                        ) : (
                            <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                                {t('insights.unableToLoadPosts')}
                            </Text>
                        )}
                    </>
                )}

                <View style={styles.bottomSpacer} />
            </ScrollView>
        );
    };

    const renderEngagementTab = () => {
        if (!engagementRatios) return null;

        return (
            <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
                <PeriodSelector selected={selectedPeriod} onSelect={handlePeriodChange} theme={theme} t={t} />

                {/* Top-line */}
                <View style={styles.topMetrics}>
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {engagementRatios.ratios.engagementRate.toFixed(1)}%
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.post.engagementRate')}
                        </Text>
                    </View>
                    <View style={[styles.topMetricDivider, { backgroundColor: theme.colors.border }]} />
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {formatCompactNumber(engagementRatios.totals.interactions)}
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.post.interactions')}
                        </Text>
                    </View>
                    <View style={[styles.topMetricDivider, { backgroundColor: theme.colors.border }]} />
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {engagementRatios.averages.engagementPerPost.toFixed(1)}
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.avgPerPost')}
                        </Text>
                    </View>
                </View>

                {/* Rates */}
                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                    {t('insights.engagementRatios')}
                </Text>

                <StatRow icon="heart" iconColor="#FF3040" label={t('insights.likeRate')} value={`${engagementRatios.ratios.likeRate.toFixed(2)}%`} theme={theme} />
                <StatRow icon="chatbubble" iconColor={theme.colors.primary} label={t('insights.replyRate')} value={`${engagementRatios.ratios.replyRate.toFixed(2)}%`} theme={theme} />
                <StatRow icon="repeat" iconColor={theme.colors.primary} label={t('insights.repostRate')} value={`${engagementRatios.ratios.repostRate.toFixed(2)}%`} theme={theme} />
                <StatRow icon="share-social" iconColor={theme.colors.primary} label={t('insights.shareRate')} value={`${engagementRatios.ratios.shareRate.toFixed(2)}%`} showDivider={false} theme={theme} />

                {/* Averages */}
                <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.text }]}>
                    {t('insights.averages')}
                </Text>

                <StatRow icon="eye" iconColor={theme.colors.primary} label={t('insights.viewsPerPost')} value={formatCompactNumber(Math.round(engagementRatios.averages.viewsPerPost))} sub={`${engagementRatios.totals.posts} ${t('insights.posts').toLowerCase()}`} theme={theme} />
                <StatRow icon="trending-up" iconColor={theme.colors.primary} label={t('insights.engagementPerPost')} value={engagementRatios.averages.engagementPerPost.toFixed(1)} showDivider={false} theme={theme} />

                {/* Totals */}
                <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.text }]}>
                    {t('insights.totalActivity')}
                </Text>

                <StatRow icon="document-text" iconColor={theme.colors.primary} label={t('insights.posts')} value={engagementRatios.totals.posts} theme={theme} />
                <StatRow icon="eye" iconColor={theme.colors.primary} label={t('insights.post.views')} value={engagementRatios.totals.views} theme={theme} />
                <StatRow icon="flash" iconColor={theme.colors.primary} label={t('insights.post.interactions')} value={engagementRatios.totals.interactions} showDivider={false} theme={theme} />

                <View style={styles.bottomSpacer} />
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

                    <Header
                        options={{
                            title: t('Insights'),
                            leftComponents: [
                                <IconButton variant="icon" key="back" onPress={() => router.back()}>
                                    <BackArrowIcon size={20} color={theme.colors.text} />
                                </IconButton>,
                            ],
                        }}
                        hideBottomBorder={true}
                        disableSticky={true}
                    />

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

                    {loading ? (
                        <View style={styles.loadingContainer}>
                            <Loading size="large" />
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
    stickyTabBar: {
        ...Platform.select({
            web: { position: 'sticky' as any },
            default: { position: 'relative' },
        }),
        top: 0,
        zIndex: 100,
        backgroundColor: 'transparent',
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    scroll: {
        flex: 1,
    },
    scrollContent: {
        paddingHorizontal: 20,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    // Period selector
    periodRow: {
        flexDirection: 'row',
        gap: 8,
        paddingVertical: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
        marginBottom: 4,
    },
    periodPill: {
        paddingHorizontal: 14,
        paddingVertical: 6,
        borderRadius: 16,
    },
    periodPillText: {
        fontSize: 13,
        fontWeight: '500',
    },
    periodPillTextActive: {
        fontWeight: '700',
    },
    // Weekly recap link
    recapRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    recapLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    recapText: {
        fontSize: 15,
        fontWeight: '600',
    },
    // Top-line metrics
    topMetrics: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 20,
    },
    topMetricItem: {
        flex: 1,
        alignItems: 'center',
    },
    topMetricValue: {
        fontSize: 24,
        fontWeight: '800',
        letterSpacing: -0.3,
    },
    topMetricLabel: {
        fontSize: 12,
        fontWeight: '500',
        marginTop: 2,
    },
    topMetricDivider: {
        width: 0.5,
        height: 28,
    },
    // Chart
    chartContainer: {
        marginBottom: 16,
    },
    // Section
    sectionTitle: {
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 4,
        marginTop: 8,
    },
    sectionTitleSpaced: {
        marginTop: 24,
    },
    // Stat rows
    statRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 12,
    },
    statRowLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    statRowRight: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    statRowLabel: {
        fontSize: 15,
        fontWeight: '500',
    },
    statRowValue: {
        fontSize: 16,
        fontWeight: '700',
    },
    statRowSub: {
        fontSize: 13,
        fontWeight: '500',
        minWidth: 40,
        textAlign: 'right',
    },
    rowDivider: {
        height: StyleSheet.hairlineWidth,
    },
    // Top posts
    topPostRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 4,
    },
    topPostRank: {
        fontSize: 14,
        fontWeight: '700',
        width: 24,
        paddingTop: 14,
    },
    topPostContent: {
        flex: 1,
    },
    topPostItem: {
        borderBottomWidth: 0,
    },
    loadingPosts: {
        padding: 24,
        alignItems: 'center',
    },
    emptyText: {
        fontSize: 14,
        fontWeight: '500',
        paddingVertical: 16,
    },
    bottomSpacer: {
        height: 40,
    },
});

export default InsightsScreen;
