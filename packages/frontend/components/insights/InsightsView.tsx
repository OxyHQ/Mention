import React, { useState, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Platform,
    type ViewStyle,
    type TextStyle
} from 'react-native';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Loading } from '@oxyhq/bloom/loading';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme, type Theme } from '@oxyhq/bloom/theme';
import { insightsService } from '@/services/insightsService';
import { useTranslation } from 'react-i18next';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services/ui/client';
import { usePostsStore } from '@/stores/postsStore';
import PostItem from '@/components/Feed/PostItem';
import type { HydratedPost } from '@mention/shared-types';
import MiniChart from '@/components/MiniChart';
import AnimatedTabBar from '@/components/common/AnimatedTabBar';
import { EmptyState } from '@/components/common/EmptyState';
import { formatCompactNumber } from '@/utils/formatNumber';
import { asViewStyle, asTextStyle } from '@/types/webStyles';
import { logger } from '@oxyhq/core/logger';
import { HeartIcon } from '@/assets/icons/heart-icon';
import { CommentIcon } from '@/assets/icons/comment-icon';
import { BoostIcon } from '@/assets/icons/boost-icon';
import { ShareIcon } from '@/assets/icons/share-icon';
import { CalendarIcon } from '@/assets/icons/calendar-icon';
import { ChevronRightIcon } from '@/assets/icons/chevron-right-icon';
import { ArticleIcon } from '@/assets/icons/article-icon';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { MediaIcon } from '@/assets/icons/media-icon';
import { Video } from '@/assets/icons/video-icon';
import { PollIcon } from '@/assets/icons/poll-icon';
import { AnalyticsIcon } from '@/assets/icons/analytics-icon';

const PERIOD_OPTIONS = [
    { labelKey: 'insights.period.7days', value: 7 },
    { labelKey: 'insights.period.30days', value: 30 },
    { labelKey: 'insights.period.90days', value: 90 }
];

// `position: 'sticky'` is a valid react-native-web value absent from RN's native
// position union — author it through the shared extended View/Text styles (same
// pattern as SideBar) and bridge to the RN style types, rather than an `as any` cast.
const webStickyViewStyle: ViewStyle = asViewStyle({ position: 'sticky' });
const webStickyRankStyle: TextStyle = asTextStyle({ position: 'sticky', top: 12 });

// WEB hands scroll to the shared panel/document (no nested scroller that would
// break sticky rails + window scroll restoration); NATIVE keeps a ScrollView as
// the tab's scroller — the standard RN idiom.
const IS_WEB = Platform.OS === 'web';

// Reusable stat row
interface StatRowProps {
    icon: React.ReactNode;
    label: string;
    value: string | number;
    sub?: string;
    showDivider?: boolean;
}

const StatRow: React.FC<StatRowProps & { theme: Theme }> = ({ icon, label, value, sub, showDivider = true }) => (
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
    theme: Theme;
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

export interface InsightsViewProps {
    /**
     * The account the numbers are ABOUT. Absent ⇒ the signed-in viewer, which is
     * every use this screen had before channels got a page of their own.
     *
     * A channel can never be signed in as, so its operators reach its numbers
     * only by naming it here. The server independently decides whether this
     * viewer may — an id put here by a caller who does not operate the account is
     * refused, never silently answered with the viewer's own figures.
     */
    accountId?: string;
}

/**
 * The Insights dashboard — period selector, overview and engagement tabs.
 *
 * Owns everything below the screen header so that the two routes rendering it
 * differ only in whose numbers they ask for and what their header says: the
 * viewer's own at `/insights`, and a channel's at `/c/<handle>/insights`. There
 * is deliberately one implementation; a second analytics surface would be a
 * second set of definitions for "engagement rate" waiting to disagree.
 *
 * ## The weekly recap belongs to a PERSON, so it appears only for one
 *
 * The recap row is rendered only when there is no `accountId`. It is not a
 * missing feature for channels: `/statistics/weekly-summary` takes no account and
 * writes a second-person retrospective ("your week") in the reader's own
 * language, over a screen showing the reader's own avatar. Offered on a channel
 * it would either address one operator as though the channel's week were theirs,
 * or link to a page answering about the wrong subject entirely.
 *
 * Hiding the row is therefore the honest shape rather than a stub: affordance ⊆
 * permission — the app never offers a row the server will refuse or misanswer.
 */
export const InsightsView: React.FC<InsightsViewProps> = ({ accountId }) => {
    const { t } = useTranslation();
    const theme = useTheme();
    const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();

    const [selectedPeriod, setSelectedPeriod] = useState(30);
    const [activeTab, setActiveTab] = useState<'overview' | 'engagement'>('overview');

    const { getPostById } = usePostsStore();

    // Stats + engagement + hydrated top posts for the selected period. Keyed on
    // the auth identity, the SUBJECT and the period so it fires only once the
    // session lands, auto-re-runs when `user?.id` arrives after SSO restore, and
    // never serves one account's figures under another's name. `keepPreviousData`
    // keeps the previous period on screen while a new one loads, matching the
    // original background-prefetch smoothness. Gated on `canUsePrivateApi` since
    // /statistics/* are private endpoints.
    const { data, isLoading, isError, refetch } = useQuery({
        queryKey: viewerQueryKeys.insights(user?.id, accountId, selectedPeriod),
        queryFn: async () => {
            const [stats, engagement] = await Promise.all([
                insightsService.getAccountInsights(selectedPeriod, { accountId }),
                insightsService.getEngagementRatios(selectedPeriod, { accountId })
            ]);

            let topPosts: HydratedPost[] = [];
            if (stats.topPosts && stats.topPosts.length > 0) {
                const posts = await Promise.all(
                    stats.topPosts.slice(0, 5).map((postInfo) =>
                        getPostById(postInfo.postId).catch((error: unknown) => {
                            const status = (error as { response?: { status?: number } })?.response?.status;
                            if (status !== 404) {
                                logger.error(`Error loading post ${postInfo.postId}`, error);
                            }
                            return null;
                        })
                    )
                );
                topPosts = posts.filter((p): p is HydratedPost => p !== null);
            }

            return { stats, engagement, topPosts };
        },
        enabled: canUsePrivateApi,
        placeholderData: keepPreviousData,
    });

    const stats = data?.stats ?? null;
    const engagementRatios = data?.engagement ?? null;
    const topPostsData = data?.topPosts ?? [];

    const handlePeriodChange = useCallback((val: number) => {
        if (val !== selectedPeriod) setSelectedPeriod(val);
    }, [selectedPeriod]);

    const renderOverviewTab = () => {
        if (!stats) return null;

        const totalPosts = stats.overview.totalPosts;
        const perPost = (n: number) => totalPosts > 0 ? `${(n / totalPosts).toFixed(1)}/post` : undefined;

        const body = (
            <>
                <PeriodSelector selected={selectedPeriod} onSelect={handlePeriodChange} theme={theme} t={t} />

                {/* Weekly Recap link — the viewer's own insights only. See the note above. */}
                {!accountId && (
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
                )}

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
                <StatRow icon={<BoostIcon size={18} className="text-foreground" />} label={t('insights.post.boosts')} value={stats.interactions.boosts} sub={perPost(stats.interactions.boosts)} theme={theme} />
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
                                    <Text className="text-xl font-extrabold w-8 pt-3.5 text-muted-foreground" style={webStickyRankStyle}>
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
            </>
        );

        return IS_WEB ? (
            <View style={styles.scrollContent}>{body}</View>
        ) : (
            <ScrollView className="flex-1" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
                {body}
            </ScrollView>
        );
    };

    const renderEngagementTab = () => {
        if (!engagementRatios) return null;

        const body = (
            <>
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
                <StatRow icon={<BoostIcon size={18} className="text-foreground" />} label={t('insights.boostRate')} value={`${engagementRatios.ratios.boostRate.toFixed(2)}%`} theme={theme} />
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
            </>
        );

        return IS_WEB ? (
            <View style={styles.scrollContent}>{body}</View>
        ) : (
            <ScrollView className="flex-1" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
                {body}
            </ScrollView>
        );
    };

    return (
        <>
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

            {isPrivateApiPending || isLoading ? (
                <View className="flex-1 justify-center items-center">
                    <Loading className="text-primary" size="large" />
                </View>
            ) : !canUsePrivateApi ? (
                <OxyAuthPrompt
                    label={t('insights.signInRequired', { defaultValue: 'Sign in to see your insights' })}
                    description={t('insights.signInRequiredDesc', { defaultValue: 'Your posts, views, and engagement stats will appear here once you sign in.' })}
                />
            ) : isError ? (
                // A failed read must SAY so. Both tab bodies return `null` when
                // their data is missing, so without this branch a refusal or an
                // outage paints an empty panel under a working period selector —
                // indistinguishable from an account that genuinely has no
                // activity, and far worse than an honest error, because there is
                // nothing to retry and nothing to report.
                //
                // The reachable refusal is narrow but real: the affordance and the
                // API resolve membership through two different Oxy reads —
                // `listAccounts` (effective, so an INHERITED membership counts) on
                // the client, `listAccounts/:id/members` (direct rows only) on the
                // server. A member whose role cascades from an ancestor account is
                // therefore offered the screen and refused the data. That gap is
                // known and lives in the shared publish-as authority rather than
                // here; what this branch owes such a reader is a plain statement
                // that the numbers could not be loaded.
                <EmptyState
                    error={{
                        title: t('insights.unavailable.title', { defaultValue: 'Insights unavailable' }),
                        message: t('insights.unavailable.message', {
                            defaultValue: 'These insights could not be loaded. You may not have access to this account, or the service may be temporarily unavailable.',
                        }),
                        onRetry: async () => {
                            await refetch();
                        },
                    }}
                />
            ) : (
                activeTab === 'overview' ? renderOverviewTab() : renderEngagementTab()
            )}
        </>
    );
};

const styles = StyleSheet.create({
    stickyTabBar: {
        ...(Platform.OS === 'web'
            ? webStickyViewStyle
            : { position: 'relative' as const }),
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

export default InsightsView;
