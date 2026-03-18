import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
    TouchableOpacity,
    Modal,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
import { statisticsService, PostInsights } from '@/services/statisticsService';
import { useTranslation } from 'react-i18next';
import { formatCompactNumber } from '@/utils/formatNumber';
import { logger } from '@/lib/logger';

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
            logger.error('Error loading post insights');
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
            <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
                {/* Header */}
                <View
                    className="flex-row items-center justify-between px-4 py-3 border-b border-border"
                    style={{ borderBottomWidth: StyleSheet.hairlineWidth }}
                >
                    <TouchableOpacity onPress={onClose} className="p-2">
                        <Ionicons name="close" size={24} color={theme.colors.text} />
                    </TouchableOpacity>
                    <Text className="text-foreground text-lg font-semibold">Post Insights</Text>
                    <View style={{ width: 40 }} />
                </View>

                {/* Content */}
                {loading ? (
                    <View className="flex-1 justify-center items-center">
                        <Loading size="large" />
                    </View>
                ) : insights ? (
                    <ScrollView className="flex-1 p-4" showsVerticalScrollIndicator={false}>
                        {/* Stats Grid */}
                        <View className="flex-row flex-wrap mb-6">
                            <View className="bg-surface items-center p-4 rounded-xl mb-3" style={styles.statCard}>
                                <Ionicons name="eye-outline" size={24} color={theme.colors.primary} />
                                <Text className="text-foreground text-2xl font-bold mt-2">
                                    {formatCompactNumber(insights.stats.views)}
                                </Text>
                                <Text className="text-muted-foreground text-xs font-medium mt-2">Views</Text>
                            </View>

                            <View className="bg-surface items-center p-4 rounded-xl mb-3" style={styles.statCardLast}>
                                <Ionicons name="heart-outline" size={24} color="#FF3040" />
                                <Text className="text-foreground text-2xl font-bold mt-2">
                                    {formatCompactNumber(insights.stats.likes)}
                                </Text>
                                <Text className="text-muted-foreground text-xs font-medium mt-2">Likes</Text>
                            </View>

                            <View className="bg-surface items-center p-4 rounded-xl mb-3" style={styles.statCard}>
                                <Ionicons name="chatbubble-outline" size={24} color={theme.colors.primary} />
                                <Text className="text-foreground text-2xl font-bold mt-2">
                                    {formatCompactNumber(insights.stats.replies)}
                                </Text>
                                <Text className="text-muted-foreground text-xs font-medium mt-2">Replies</Text>
                            </View>

                            <View className="bg-surface items-center p-4 rounded-xl mb-3" style={styles.statCardLast}>
                                <Ionicons name="repeat-outline" size={24} color="#10B981" />
                                <Text className="text-foreground text-2xl font-bold mt-2">
                                    {formatCompactNumber(insights.stats.reposts)}
                                </Text>
                                <Text className="text-muted-foreground text-xs font-medium mt-2">Reposts</Text>
                            </View>
                        </View>

                        {/* Engagement Metrics */}
                        <View className="bg-surface p-4 rounded-xl mb-4">
                            <Text className="text-foreground text-lg font-semibold mb-3">Engagement</Text>
                            <View className="flex-row justify-between items-center mb-3">
                                <Text className="text-muted-foreground text-sm">
                                    Engagement Rate
                                </Text>
                                <Text className="text-primary text-lg font-semibold">
                                    {insights.engagement.engagementRate.toFixed(2)}%
                                </Text>
                            </View>
                            <View className="flex-row justify-between items-center mb-3">
                                <Text className="text-muted-foreground text-sm">
                                    Total Interactions
                                </Text>
                                <Text className="text-foreground text-lg font-semibold">
                                    {formatCompactNumber(insights.engagement.totalInteractions)}
                                </Text>
                            </View>
                            <View className="flex-row justify-between items-center mb-3">
                                <Text className="text-muted-foreground text-sm">Reach</Text>
                                <Text className="text-foreground text-lg font-semibold">
                                    {formatCompactNumber(insights.engagement.reach)}
                                </Text>
                            </View>
                        </View>

                        {/* Additional Stats */}
                        {insights.stats.quotes > 0 && (
                            <View className="bg-surface p-4 rounded-xl mb-4">
                                <Text className="text-foreground text-lg font-semibold mb-3">Quotes</Text>
                                <Text className="text-foreground text-2xl font-bold">
                                    {formatCompactNumber(insights.stats.quotes)}
                                </Text>
                            </View>
                        )}

                        {insights.stats.shares > 0 && (
                            <View className="bg-surface p-4 rounded-xl mb-4">
                                <Text className="text-foreground text-lg font-semibold mb-3">Shares</Text>
                                <Text className="text-foreground text-2xl font-bold">
                                    {formatCompactNumber(insights.stats.shares)}
                                </Text>
                            </View>
                        )}
                    </ScrollView>
                ) : (
                    <View className="flex-1 justify-center items-center py-4">
                        <Ionicons name="bar-chart-outline" size={64} color={theme.colors.textSecondary} />
                        <Text className="text-muted-foreground text-base">
                            No insights available
                        </Text>
                    </View>
                )}
            </View>
        </Modal>
    );
};

const styles = StyleSheet.create({
    statCard: {
        width: '47%',
        marginRight: '3%',
    },
    statCardLast: {
        width: '47%',
        marginRight: 0,
        padding: 16,
        borderRadius: 12,
        alignItems: 'center',
        marginBottom: 12,
    },
});

export default PostInsightsModal;
