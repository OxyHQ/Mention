import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    ActivityIndicator,
    TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { statisticsService, PostInsights } from '@/services/statisticsService';
import SectionHeader from '@/components/insights/SectionHeader';
import SummaryCard from '@/components/insights/SummaryCard';

interface PostInsightsSheetProps {
    postId: string | null;
    onClose: () => void;
}

const PostInsightsSheet: React.FC<PostInsightsSheetProps> = ({ postId, onClose }) => {
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

    const formatNumber = (num: number): string => {
        if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
        if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
        return num.toString();
    };

    if (loading) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.card }]}>
                <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
                    <Text style={[styles.title, { color: theme.colors.text }]}>Post Insights</Text>
                    <TouchableOpacity onPress={onClose}>
                        <Ionicons name="close" size={24} color={theme.colors.text} />
                    </TouchableOpacity>
                </View>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.colors.primary} />
                </View>
            </View>
        );
    }

    if (!insights) {
        return (
            <View style={[styles.container, { backgroundColor: theme.colors.card }]}>
                <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
                    <Text style={[styles.title, { color: theme.colors.text }]}>Post Insights</Text>
                    <TouchableOpacity onPress={onClose}>
                        <Ionicons name="close" size={24} color={theme.colors.text} />
                    </TouchableOpacity>
                </View>
                <View style={styles.emptyContainer}>
                    <Ionicons name="bar-chart-outline" size={64} color={theme.colors.textSecondary} />
                    <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                        No insights available
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.card }]}>
            <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
                <Text style={[styles.title, { color: theme.colors.text }]}>Post Insights</Text>
                <TouchableOpacity onPress={onClose}>
                    <Ionicons name="close" size={24} color={theme.colors.text} />
                </TouchableOpacity>
            </View>

            <ScrollView 
                style={styles.content} 
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.contentContainer}
            >
                {/* Summary Stats */}
                <View style={styles.summarySection}>
                    <SummaryCard
                        items={[
                            { value: insights.stats.views, label: 'Views' },
                            { value: insights.stats.likes, label: 'Likes' },
                            { value: insights.engagement.totalInteractions, label: 'Interactions' },
                        ]}
                    />
                </View>

                {/* Engagement Rate */}
                <View style={styles.engagementRateSection}>
                    <SectionHeader title="Engagement Rate" />
                    <View style={[styles.engagementRateCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                        <View style={styles.engagementRateHeader}>
                            <Ionicons name="trending-up" size={20} color={theme.colors.primary} />
                            {insights.stats.views > 0 && (
                                <Text style={[styles.engagementRateStat, { color: theme.colors.textSecondary }]}>
                                    {formatNumber(insights.stats.views)} views
                                </Text>
                            )}
                        </View>
                        <Text style={[styles.engagementRateValue, { color: theme.colors.text }]}>
                            {insights.engagement.engagementRate.toFixed(2)}%
                        </Text>
                        <Text style={[styles.engagementRateLabel, { color: theme.colors.textSecondary }]}>Engagement Rate</Text>
                        <View style={[styles.engagementRateStats, { borderTopColor: theme.colors.border }]}>
                            <View style={styles.engagementRateStatItem}>
                                <Text style={[styles.engagementRateStatValue, { color: theme.colors.text }]}>
                                    {formatNumber(insights.engagement.totalInteractions)}
                                </Text>
                                <Text style={[styles.engagementRateStatLabel, { color: theme.colors.textSecondary }]}>Total interactions</Text>
                            </View>
                            {insights.engagement.reach > 0 && (
                                <View style={styles.engagementRateStatItem}>
                                    <Text style={[styles.engagementRateStatValue, { color: theme.colors.text }]}>
                                        {formatNumber(insights.engagement.reach)}
                                    </Text>
                                    <Text style={[styles.engagementRateStatLabel, { color: theme.colors.textSecondary }]}>Reach</Text>
                                </View>
                            )}
                        </View>
                    </View>
                </View>

                {/* Interactions */}
                <View style={styles.interactionsSection}>
                    <SectionHeader title="Interactions" />
                    <View style={styles.interactionsGrid}>
                        <View style={[styles.interactionCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.interactionCardHeader}>
                                <Ionicons name="heart" size={20} color="#FF3040" />
                                {insights.stats.likes > 0 && insights.engagement.totalInteractions > 0 && (
                                    <Text style={[styles.interactionStat, { color: theme.colors.textSecondary }]}>
                                        {((insights.stats.likes / insights.engagement.totalInteractions) * 100).toFixed(1)}%
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                {formatNumber(insights.stats.likes)}
                            </Text>
                            <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>Likes</Text>
                        </View>

                        <View style={[styles.interactionCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.interactionCardHeader}>
                                <Ionicons name="chatbubble" size={20} color={theme.colors.primary} />
                                {insights.stats.replies > 0 && insights.engagement.totalInteractions > 0 && (
                                    <Text style={[styles.interactionStat, { color: theme.colors.textSecondary }]}>
                                        {((insights.stats.replies / insights.engagement.totalInteractions) * 100).toFixed(1)}%
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                {formatNumber(insights.stats.replies)}
                            </Text>
                            <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>Replies</Text>
                        </View>

                        <View style={[styles.interactionCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <View style={styles.interactionCardHeader}>
                                <Ionicons name="repeat" size={20} color={theme.colors.primary} />
                                {insights.stats.reposts > 0 && insights.engagement.totalInteractions > 0 && (
                                    <Text style={[styles.interactionStat, { color: theme.colors.textSecondary }]}>
                                        {((insights.stats.reposts / insights.engagement.totalInteractions) * 100).toFixed(1)}%
                                    </Text>
                                )}
                            </View>
                            <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                {formatNumber(insights.stats.reposts)}
                            </Text>
                            <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>Reposts</Text>
                        </View>

                        {insights.stats.shares > 0 && (
                            <View style={[styles.interactionCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                                <View style={styles.interactionCardHeader}>
                                    <Ionicons name="share-social" size={20} color={theme.colors.primary} />
                                    {insights.engagement.totalInteractions > 0 && (
                                        <Text style={[styles.interactionStat, { color: theme.colors.textSecondary }]}>
                                            {((insights.stats.shares / insights.engagement.totalInteractions) * 100).toFixed(1)}%
                                        </Text>
                                    )}
                                </View>
                                <Text style={[styles.interactionValue, { color: theme.colors.text }]}>
                                    {formatNumber(insights.stats.shares)}
                                </Text>
                                <Text style={[styles.interactionLabel, { color: theme.colors.textSecondary }]}>Shares</Text>
                            </View>
                        )}
                    </View>
                </View>

                {/* Additional Stats */}
                {insights.stats.quotes > 0 && (
                    <View style={styles.additionalSection}>
                        <SectionHeader title="Quotes" />
                        <View style={[styles.additionalCard, { backgroundColor: theme.colors.card, borderColor: theme.colors.border }]}>
                            <Text style={[styles.additionalValue, { color: theme.colors.text }]}>
                                {formatNumber(insights.stats.quotes)}
                            </Text>
                            <Text style={[styles.additionalLabel, { color: theme.colors.textSecondary }]}>Total quotes</Text>
                        </View>
                    </View>
                )}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
        paddingTop: 16,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingBottom: 16,
        borderBottomWidth: StyleSheet.hairlineWidth,
    },
    title: {
        fontSize: 20,
        fontWeight: 'bold',
    },
    content: {
        flex: 1,
    },
    contentContainer: {
        paddingHorizontal: 16,
        paddingTop: 16,
        paddingBottom: 20,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 48,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingVertical: 48,
    },
    emptyText: {
        marginTop: 16,
        fontSize: 16,
    },
    summarySection: {
        marginBottom: 16,
    },
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
    },
    additionalSection: {
        marginBottom: 16,
    },
    additionalCard: {
        borderRadius: 15,
        padding: 16,
        borderWidth: 1,
        alignItems: 'center',
    },
    additionalValue: {
        fontSize: 32,
        fontWeight: '900',
        marginBottom: 4,
    },
    additionalLabel: {
        fontSize: 15,
        fontWeight: '700',
    },
});

export default PostInsightsSheet;

