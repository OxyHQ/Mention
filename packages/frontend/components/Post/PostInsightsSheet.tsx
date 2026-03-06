import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
} from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { CloseIcon } from '@/assets/icons/close-icon';
import { statisticsService, PostInsights } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';
import { formatCompactNumber } from '@/utils/formatNumber';

interface PostInsightsSheetProps {
    postId: string | null;
    onClose: () => void;
}

interface StatRowProps {
    icon: string;
    iconColor: string;
    label: string;
    value: number;
    percentage?: string;
    showDivider?: boolean;
    theme: any;
}

const StatRow: React.FC<StatRowProps> = ({ icon, iconColor, label, value, percentage, showDivider = true, theme }) => (
    <View>
        <View style={styles.statRow}>
            <View style={styles.statRowLeft}>
                <Ionicons name={icon as any} size={18} color={iconColor} />
                <Text style={[styles.statRowLabel, { color: theme.colors.text }]}>{label}</Text>
            </View>
            <View style={styles.statRowRight}>
                <Text style={[styles.statRowValue, { color: theme.colors.text }]}>
                    {formatCompactNumber(value)}
                </Text>
                {percentage && (
                    <Text style={[styles.statRowPct, { color: theme.colors.textSecondary }]}>
                        {percentage}
                    </Text>
                )}
            </View>
        </View>
        {showDivider && <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />}
    </View>
);

const PostInsightsSheet: React.FC<PostInsightsSheetProps> = ({ postId, onClose }) => {
    const { t } = useTranslation();
    const theme = useTheme();

    const [loading, setLoading] = useState(false);
    const [insights, setInsights] = useState<PostInsights | null>(null);

    useEffect(() => {
        if (postId) {
            loadInsights();
        } else {
            setInsights(null);
        }
    }, [postId]);

    const loadInsights = async () => {
        if (!postId) return;

        try {
            setLoading(true);
            const data = await statisticsService.getPostInsights(postId);
            setInsights(data);
        } catch (error) {
            console.error('Error loading post insights:', error);
        } finally {
            setLoading(false);
        }
    };

    const headerEl = (
        <Header
            options={{
                title: t('insights.post.title'),
                rightComponents: [
                    <IconButton variant="icon" key="close" onPress={onClose}>
                        <CloseIcon size={20} color={theme.colors.text} />
                    </IconButton>,
                ],
            }}
            hideBottomBorder={true}
            disableSticky={true}
        />
    );

    if (loading) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
                {headerEl}
                <View style={styles.loadingContainer}>
                    <Loading size="large" />
                </View>
            </View>
        );
    }

    if (!insights) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
                {headerEl}
                <EmptyState
                    title={t('insights.post.noInsightsAvailable')}
                    icon={{ name: 'bar-chart-outline', size: 48 }}
                />
            </View>
        );
    }

    const totalInteractions = insights.engagement.totalInteractions;
    const pct = (n: number) => totalInteractions > 0 ? `${((n / totalInteractions) * 100).toFixed(1)}%` : undefined;

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
            {headerEl}

            <ScrollView
                style={styles.content}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.contentContainer}
            >
                {/* Top-line metrics */}
                <View style={styles.topMetrics}>
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {formatCompactNumber(insights.stats.views)}
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.post.views')}
                        </Text>
                    </View>
                    <View style={[styles.topMetricDivider, { backgroundColor: theme.colors.border }]} />
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {insights.engagement.engagementRate.toFixed(1)}%
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.post.engagementRate')}
                        </Text>
                    </View>
                    <View style={[styles.topMetricDivider, { backgroundColor: theme.colors.border }]} />
                    <View style={styles.topMetricItem}>
                        <Text style={[styles.topMetricValue, { color: theme.colors.text }]}>
                            {formatCompactNumber(totalInteractions)}
                        </Text>
                        <Text style={[styles.topMetricLabel, { color: theme.colors.textSecondary }]}>
                            {t('insights.post.interactions')}
                        </Text>
                    </View>
                </View>

                {/* Breakdown */}
                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>
                    {t('insights.post.interactions')}
                </Text>

                <StatRow icon="heart" iconColor="#FF3040" label={t('insights.post.likes')} value={insights.stats.likes} percentage={pct(insights.stats.likes)} theme={theme} />
                <StatRow icon="chatbubble" iconColor={theme.colors.primary} label={t('insights.post.replies')} value={insights.stats.replies} percentage={pct(insights.stats.replies)} theme={theme} />
                <StatRow icon="repeat" iconColor={theme.colors.primary} label={t('insights.post.reposts')} value={insights.stats.reposts} percentage={pct(insights.stats.reposts)} theme={theme} />
                {insights.stats.shares > 0 && (
                    <StatRow icon="share-social" iconColor={theme.colors.primary} label={t('insights.post.shares')} value={insights.stats.shares} percentage={pct(insights.stats.shares)} theme={theme} />
                )}
                {insights.stats.quotes > 0 && (
                    <StatRow icon="chatbox-ellipses" iconColor={theme.colors.primary} label={t('insights.post.quotes')} value={insights.stats.quotes} percentage={pct(insights.stats.quotes)} showDivider={false} theme={theme} />
                )}

                {insights.engagement.reach > 0 && (
                    <>
                        <Text style={[styles.sectionTitle, styles.sectionTitleSpaced, { color: theme.colors.text }]}>
                            {t('insights.post.reach')}
                        </Text>
                        <StatRow icon="people" iconColor={theme.colors.primary} label={t('insights.post.reach')} value={insights.engagement.reach} showDivider={false} theme={theme} />
                    </>
                )}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    content: {
        flex: 1,
    },
    contentContainer: {
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 24,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 48,
    },
    topMetrics: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingVertical: 16,
        marginBottom: 8,
    },
    topMetricItem: {
        flex: 1,
        alignItems: 'center',
    },
    topMetricValue: {
        fontSize: 22,
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
    sectionTitle: {
        fontSize: 15,
        fontWeight: '700',
        marginBottom: 12,
        marginTop: 4,
    },
    sectionTitleSpaced: {
        marginTop: 20,
    },
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
    statRowPct: {
        fontSize: 13,
        fontWeight: '500',
        minWidth: 40,
        textAlign: 'right',
    },
    divider: {
        height: StyleSheet.hairlineWidth,
    },
});

export default PostInsightsSheet;
