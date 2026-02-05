import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Modal,
    Platform
} from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/hooks/useTheme';
import { statisticsService, PostInsights } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/formatNumber';

interface PostInsightsModalProps {
    visible: boolean;
    postId: string | null;
    onClose: () => void;
}

const PostInsightsModal: React.FC<PostInsightsModalProps> = ({ visible, postId, onClose }) => {
    const { t } = useTranslation();
    const theme = useTheme();
    const insets = useSafeAreaInsets();

    const [loading, setLoading] = useState(false);
    const [insights, setInsights] = useState<PostInsights | null>(null);

    useEffect(() => {
        if (visible && postId) {
            loadInsights();
        } else {
            setInsights(null);
        }
    }, [visible, postId]);

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

    return (
        <Modal
            visible={visible}
            animationType="slide"
            presentationStyle="pageSheet"
            onRequestClose={onClose}
        >
            <View style={[styles.container, { backgroundColor: theme.colors.background, paddingTop: insets.top }]}>
                {/* Header */}
                <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
                    <TouchableOpacity onPress={onClose} style={styles.closeButton}>
                        <Ionicons name="close" size={24} color={theme.colors.text} />
                    </TouchableOpacity>
                    <Text style={[styles.headerTitle, { color: theme.colors.text }]}>Post Insights</Text>
                    <View style={styles.headerRight} />
                </View>

                {/* Content */}
                {loading ? (
                    <View style={styles.loadingContainer}>
                        <Loading size="large" />
                    </View>
                ) : insights ? (
                    <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                        {/* Stats Grid */}
                        <View style={styles.statsGrid}>
                            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                                <Ionicons name="eye-outline" size={24} color={theme.colors.primary} />
                                <Text style={[styles.statValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(insights.stats.views)}
                                </Text>
                                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Views</Text>
                            </View>

                            <View style={[styles.statCard, styles.statCardLast, { backgroundColor: theme.colors.backgroundSecondary }]}>
                                <Ionicons name="heart-outline" size={24} color="#FF3040" />
                                <Text style={[styles.statValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(insights.stats.likes)}
                                </Text>
                                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Likes</Text>
                            </View>

                            <View style={[styles.statCard, { backgroundColor: theme.colors.backgroundSecondary }]}>
                                <Ionicons name="chatbubble-outline" size={24} color={theme.colors.primary} />
                                <Text style={[styles.statValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(insights.stats.replies)}
                                </Text>
                                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Replies</Text>
                            </View>

                            <View style={[styles.statCard, styles.statCardLast, { backgroundColor: theme.colors.backgroundSecondary }]}>
                                <Ionicons name="repeat-outline" size={24} color="#10B981" />
                                <Text style={[styles.statValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(insights.stats.reposts)}
                                </Text>
                                <Text style={[styles.statLabel, { color: theme.colors.textSecondary }]}>Reposts</Text>
                            </View>
                        </View>

                        {/* Engagement Metrics */}
                        <View style={[styles.section, { backgroundColor: theme.colors.backgroundSecondary }]}>
                            <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Engagement</Text>
                            <View style={styles.metricRow}>
                                <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>
                                    Engagement Rate
                                </Text>
                                <Text style={[styles.metricValue, { color: theme.colors.primary }]}>
                                    {insights.engagement.engagementRate.toFixed(2)}%
                                </Text>
                            </View>
                            <View style={styles.metricRow}>
                                <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>
                                    Total Interactions
                                </Text>
                                <Text style={[styles.metricValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(insights.engagement.totalInteractions)}
                                </Text>
                            </View>
                            <View style={styles.metricRow}>
                                <Text style={[styles.metricLabel, { color: theme.colors.textSecondary }]}>Reach</Text>
                                <Text style={[styles.metricValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(insights.engagement.reach)}
                                </Text>
                            </View>
                        </View>

                        {/* Additional Stats */}
                        {insights.stats.quotes > 0 && (
                            <View style={[styles.section, { backgroundColor: theme.colors.backgroundSecondary }]}>
                                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Quotes</Text>
                                <Text style={[styles.sectionValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(insights.stats.quotes)}
                                </Text>
                            </View>
                        )}

                        {insights.stats.shares > 0 && (
                            <View style={[styles.section, { backgroundColor: theme.colors.backgroundSecondary }]}>
                                <Text style={[styles.sectionTitle, { color: theme.colors.text }]}>Shares</Text>
                                <Text style={[styles.sectionValue, { color: theme.colors.text }]}>
                                    {formatCompactNumber(insights.stats.shares)}
                                </Text>
                            </View>
                        )}
                    </ScrollView>
                ) : (
                    <View style={styles.emptyContainer}>
                        <Ionicons name="bar-chart-outline" size={64} color={theme.colors.textSecondary} />
                        <Text style={[styles.emptyText, { color: theme.colors.textSecondary }]}>
                            No insights available
                        </Text>
                    </View>
                )}
            </View>
        </Modal>
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
    },
    closeButton: {
        padding: 8,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: '600',
    },
    headerRight: {
        width: 40,
    },
    content: {
        flex: 1,
        padding: 16,
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
        paddingVertical: 16,
    },
    emptyText: {
        fontSize: 16,
    },
    statsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginBottom: 24,
    },
    statCard: {
        width: '47%',
        padding: 16,
        borderRadius: 12,
        alignItems: 'center',
        marginRight: '3%',
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
        padding: 16,
        borderRadius: 12,
        marginBottom: 16,
    },
    sectionTitle: {
        fontSize: 18,
        fontWeight: '600',
        marginBottom: 12,
    },
    sectionValue: {
        fontSize: 24,
        fontWeight: '700',
    },
    metricRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 12,
    },
    metricLabel: {
        fontSize: 14,
    },
    metricValue: {
        fontSize: 18,
        fontWeight: '600',
    },
});

export default PostInsightsModal;

