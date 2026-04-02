import React, { useEffect, useState, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Platform
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { ThemedView } from '@/components/ThemedView';
import { statisticsService, UserStatistics, EngagementRatios } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { usePostsStore } from '@/stores/postsStore';
import PostItem from '@/components/Feed/PostItem';
import { HydratedPost } from '@mention/shared-types';
import MiniChart from '@/components/MiniChart';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { formatCompactNumber } from '@/utils/formatNumber';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { StatusBar } from 'expo-status-bar';
import SEO from '@/components/SEO';
import { logger } from '@/lib/logger';
import { HeartIcon } from '@/assets/icons/heart-icon';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { RepostIcon } from '@/assets/icons/repost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { MediaIcon } from '@/assets/icons/media-icon';
import { Video } from '@/assets/icons/video-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';

const PERIOD_OPTIONS = [
    { labelKey: 'insights.period.7days', value: 7 },
    { labelKey: 'insights.period.30days', value: 30 },
    { labelKey: 'insights.period.90days', value: 90 }
];

// Reusable stat row
interface StatRowProps {
    icon: React.ReactNode;
    label: string;
    value: string | number;
    sub?: string;
    showDivider?: boolean;
}

const StatRow: React.FC<StatRowProps & { theme: any }> = ({ icon, label, value, sub, showDivider = true, theme }) => (
    <View>
        <View className="flex-row items-center justify-between py-3">
            <View className="flex-row items-center gap-3">
                {icon}
                <Text className="text-[15px] font-medium text-foreground">{label}</Text>
            </View>
            <View className="flex-row items-center gap-2.5">
                <Text className="text-base font-bold text-foreground">
                    {typeof value === 'number' ? formatCompactNumber(value) : value}
                </Text>
                {sub && (
                    <Text className="text-[13px] font-medium min-w-[40px] text-right text-muted-foreground">{sub}</Text>
                )}
            </View>
        </View>
        {showDivider && <View style={styles.rowDivider} className="bg-border" />}
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
    const safeBack = useSafeBack();

    const [loading, setLoading] = useState(true);
    const [selectedPeriod, setSelectedPeriod] = useState(30);
    const [activeTab, setActiveTab] = useState<'overview' | 'engagement'>('overview');
    const [cache, setCache] = useState<Record<number, { stats: UserStatistics; engagement: EngagementRatios; topPosts: HydratedPost[] }>>({});

    const { getPostById } = usePostsStore();

    const stats = cache[selectedPeriod]?.stats ?? null;
    const engagementRatios = cache[selectedPeriod]?.engagement ?? null;
    const topPostsData = cache[selectedPeriod]?.topPosts ?? [];

    const loadPeriod = useCallback(async (period: number) => {
        if (!user) return;

        try {
            const [statsData, engagementData] = await Promise.all([
                statisticsService.getUserStatistics(period),
                statisticsService.getEngagementRatios(period)
            ]);

            let topPosts: HydratedPost[] = [];
            if (statsData.topPosts && statsData.topPosts.length > 0) {
                try {
                    const postsPromises = statsData.topPosts.slice(0, 5).map(async (postInfo) => {
                        try {
                            return await getPostById(postInfo.postId);
                        } catch (error: any) {
                            if (error?.response?.status !== 404) {
                                logger.error(`Error loading post ${postInfo.postId}`, { error });
                            }
                            return null;
                        }
                    });
                    const posts = await Promise.all(postsPromises);
                    topPosts = posts.filter((p): p is HydratedPost => p !== null);
                } catch (error) {
                    logger.error('Error loading top posts', { error });
                }
            }

            setCache(prev => ({ ...prev, [period]: { stats: statsData, engagement: engagementData, topPosts } }));
        } catch (error) {
            logger.error('Error loading statistics', { error });
        }
    }, [user, getPostById]);

    useEffect(() => {
        if (!user) return;

        const loadAll = async () => {
            setLoading(true);
            // Load selected period first, then others in background
            await loadPeriod(30);
            setLoading(false);
            // Pre-fetch remaining periods
            Promise.all([loadPeriod(7), loadPeriod(90)]);
        };

        loadAll();
    }, [user, loadPeriod]);

    const handlePeriodChange = useCallback((val: number) => {
        if (val !== selectedPeriod) setSelectedPeriod(val);
    }, [selectedPeriod]);

    const renderOverviewTab = () => {
        if (!stats) return null;

        const totalPosts = stats.overview.totalPosts;
        const perPost = (n: number) => totalPosts > 0 ? `${(n / totalPosts).toFixed(1)}/post` : undefined;

        return (
            <ScrollView className="flex-1" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
                <PeriodSelector selected={selectedPeriod} onSelect={handlePeriodChange} theme={theme} t={t} />

                {/* Weekly Recap link */}
                <TouchableOpacity
                    style={[styles.recapRow, { borderBottomColor: theme.colors.border }]}
                    onPress={() => router.push('/insights/weekly_recap')}
                    activeOpacity={0.7}
                >
                    <View className="flex-row items-center gap-2.5">
                        <CalendarIcon size={18} className="text-foreground" />
                        <Text className="text-[15px] font-semibold text-foreground">{t('insights.weeklyRecap.ready')}</Text>
                    </View>
                    <ChevronRightIcon size={18} className="text-muted-foreground" />
                </TouchableOpacity>

                {/* Top-line metrics */}
                <View className="flex-row items-center py-5">
                    <View className="flex-1 items-center">
                        <Text className="text-2xl font-extrabold tracking-tight text-foreground">
                            {formatCompactNumber(stats.overview.totalPosts)}
                        </Text>
                        <Text className="text-xs font-medium mt-0.5 text-muted-foreground">
                            {t('insights.posts')}
                        </Text>
                    </View>
                    <View style={styles.topMetricDivider} className="bg-border" />
                    <View className="flex-1 items-center">
                        <Text className="text-2xl font-extrabold tracking-tight text-foreground">
                            {formatCompactNumber(stats.overview.totalViews)}
                        </Text>
                        <Text className="text-xs font-medium mt-0.5 text-muted-foreground">
                            {t('insights.post.views')}
                        </Text>
                    </View>
                    <View style={styles.topMetricDivider} className="bg-border" />
                    <View className="flex-1 items-center">
                        <Text className="text-2xl font-extrabold tracking-tight text-foreground">
                            {stats.overview.engagementRate.toFixed(1)}%
                        </Text>
                        <Text className="text-xs font-medium mt-0.5 text-muted-foreground">
                            {t('insights.post.engagementRate')}
                        </Text>
                    </View>
                </View>

                {/* Mini chart */}
                {stats.dailyBreakdown && stats.dailyBreakdown.length > 0 && (
                    <View className="mb-4">
                        <MiniChart
                            values={stats.dailyBreakdown.slice(-7).map(d => d.views)}
                            showLabels={true}
                            height={40}
                        />
                    </View>
                )}

                {/* Interactions */}
                <Text className="text-[15px] font-bold mb-1 mt-2 text-foreground">
                    {t('insights.post.interactions')}
                </Text>

                <StatRow icon={<HeartIcon size={18} className="text-foreground" />} label={t('insights.post.likes')} value={stats.interactions.likes} sub={perPost(stats.interactions.likes)} theme={theme} />
                <StatRow icon={<CommentIcon size={18} className="text-foreground" />} label={t('insights.post.replies')} value={stats.interactions.replies} sub={perPost(stats.interactions.replies)} theme={theme} />
                <StatRow icon={<RepostIcon size={18} className="text-foreground" />} label={t('insights.post.reposts')} value={stats.interactions.reposts} sub={perPost(stats.interactions.reposts)} theme={theme} />
                <StatRow icon={<ShareIcon size={18} className="text-foreground" />} label={t('insights.post.shares')} value={stats.interactions.shares} sub={perPost(stats.interactions.shares)} showDivider={false} theme={theme} />

                {/* Posts by Type */}
                {Object.keys(stats.postsByType).length > 0 && (
                    <>
                        <Text className="text-[15px] font-bold mb-1 mt-6 text-foreground">
                            {t('insights.postsByType')}
                        </Text>
                        {Object.entries(stats.postsByType).map(([type, count], index, array) => {
                            const pct = totalPosts > 0 ? `${((count / totalPosts) * 100).toFixed(0)}%` : undefined;
                            const iconMap: Record<string, React.ReactNode> = {
                                text: <ArticleIcon size={18} className="text-foreground" />,
                                image: <MediaIcon size={18} className="text-foreground" />,
                                video: <Video size={18} className="text-foreground" />,
                                poll: <PollIcon size={18} className="text-foreground" />,
                            };
                            return (
                                <StatRow
                                    key={type}
                                    icon={iconMap[type] || <ArticleIcon size={18} className="text-foreground" />}
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
                        <Text className="text-[15px] font-bold mb-1 mt-6 text-foreground">
                            {t('insights.topPerformingPosts')}
                        </Text>
                        {topPostsData.length > 0 ? (
                            topPostsData.map((post, index) => (
                                <View key={post.id} style={[styles.topPostRow, index < topPostsData.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border }]}>
                                    <Text className="text-xl font-extrabold w-8 pt-3.5 text-muted-foreground" style={{ position: 'sticky' as any, top: 12 }}>
                                        {index + 1}
                                    </Text>
                                    <View className="flex-1">
                                        <PostItem post={post} style={styles.topPostItem} />
                                    </View>
                                </View>
                            ))
                        ) : (
                            <Text className="text-sm font-medium py-4 text-muted-foreground">
                                {t('insights.unableToLoadPosts')}
                            </Text>
                        )}
                    </>
                )}

                <View className="h-10" />
            </ScrollView>
        );
    };

    const renderEngagementTab = () => {
        if (!engagementRatios) return null;

        return (
            <ScrollView className="flex-1" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
                <PeriodSelector selected={selectedPeriod} onSelect={handlePeriodChange} theme={theme} t={t} />

                {/* Top-line */}
                <View className="flex-row items-center py-5">
                    <View className="flex-1 items-center">
                        <Text className="text-2xl font-extrabold tracking-tight text-foreground">
                            {engagementRatios.ratios.engagementRate.toFixed(1)}%
                        </Text>
                        <Text className="text-xs font-medium mt-0.5 text-muted-foreground">
                            {t('insights.post.engagementRate')}
                        </Text>
                    </View>
                    <View style={styles.topMetricDivider} className="bg-border" />
                    <View className="flex-1 items-center">
                        <Text className="text-2xl font-extrabold tracking-tight text-foreground">
                            {formatCompactNumber(engagementRatios.totals.interactions)}
                        </Text>
                        <Text className="text-xs font-medium mt-0.5 text-muted-foreground">
                            {t('insights.post.interactions')}
                        </Text>
                    </View>
                    <View style={styles.topMetricDivider} className="bg-border" />
                    <View className="flex-1 items-center">
                        <Text className="text-2xl font-extrabold tracking-tight text-foreground">
                            {engagementRatios.averages.engagementPerPost.toFixed(1)}
                        </Text>
                        <Text className="text-xs font-medium mt-0.5 text-muted-foreground">
                            {t('insights.avgPerPost')}
                        </Text>
                    </View>
                </View>

                {/* Rates */}
                <Text className="text-[15px] font-bold mb-1 mt-2 text-foreground">
                    {t('insights.engagementRatios')}
                </Text>

                <StatRow icon={<HeartIcon size={18} className="text-foreground" />} label={t('insights.likeRate')} value={`${engagementRatios.ratios.likeRate.toFixed(2)}%`} theme={theme} />
                <StatRow icon={<CommentIcon size={18} className="text-foreground" />} label={t('insights.replyRate')} value={`${engagementRatios.ratios.replyRate.toFixed(2)}%`} theme={theme} />
                <StatRow icon={<RepostIcon size={18} className="text-foreground" />} label={t('insights.repostRate')} value={`${engagementRatios.ratios.repostRate.toFixed(2)}%`} theme={theme} />
                <StatRow icon={<ShareIcon size={18} className="text-foreground" />} label={t('insights.shareRate')} value={`${engagementRatios.ratios.shareRate.toFixed(2)}%`} showDivider={false} theme={theme} />

                {/* Averages */}
                <Text className="text-[15px] font-bold mb-1 mt-6 text-foreground">
                    {t('insights.averages')}
                </Text>

                <StatRow icon={<Ionicons name="eye" size={18} color={theme.colors.text} />} label={t('insights.viewsPerPost')} value={formatCompactNumber(Math.round(engagementRatios.averages.viewsPerPost))} sub={`${engagementRatios.totals.posts} ${t('insights.posts').toLowerCase()}`} theme={theme} />
                <StatRow icon={<AnalyticsIcon size={18} className="text-foreground" />} label={t('insights.engagementPerPost')} value={engagementRatios.averages.engagementPerPost.toFixed(1)} showDivider={false} theme={theme} />

                {/* Totals */}
                <Text className="text-[15px] font-bold mb-1 mt-6 text-foreground">
                    {t('insights.totalActivity')}
                </Text>

                <StatRow icon={<ArticleIcon size={18} className="text-foreground" />} label={t('insights.posts')} value={engagementRatios.totals.posts} theme={theme} />
                <StatRow icon={<Ionicons name="eye" size={18} color={theme.colors.text} />} label={t('insights.post.views')} value={engagementRatios.totals.views} theme={theme} />
                <StatRow icon={<Ionicons name="flash" size={18} color={theme.colors.text} />} label={t('insights.post.interactions')} value={engagementRatios.totals.interactions} showDivider={false} theme={theme} />

                <View className="h-10" />
            </ScrollView>
        );
    };

    return (
        <>
            <SEO
                title={t('seo.insights.title')}
                description={t('seo.insights.description')}
            />
            <SafeAreaView className="flex-1 bg-background" edges={["top"]}>
                <ThemedView className="flex-1">
                    <StatusBar style={theme.isDark ? "light" : "dark"} />

                    <Header
                        options={{
                            title: t('Insights'),
                            leftComponents: [
                                <IconButton variant="icon" key="back" onPress={() => safeBack()}>
                                    <BackArrowIcon size={20} className="text-foreground" />
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
                        <View className="flex-1 justify-center items-center">
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
    scrollContent: {
        paddingHorizontal: 20,
    },
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
    recapRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    topMetricDivider: {
        width: 0.5,
        height: 28,
    },
    rowDivider: {
        height: StyleSheet.hairlineWidth,
    },
    topPostRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingVertical: 4,
    },
    topPostItem: {
        borderBottomWidth: 0,
    },
});

export default InsightsScreen;
