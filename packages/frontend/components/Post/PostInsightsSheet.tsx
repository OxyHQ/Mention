import React, { useEffect, useState } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@oxyhq/bloom/theme';
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
}

const StatRow: React.FC<StatRowProps> = ({ icon, iconColor, label, value, percentage, showDivider = true }) => (
    <View>
        <View className="flex-row items-center justify-between py-3">
            <View className="flex-row items-center gap-3">
                <Ionicons name={icon as any} size={18} color={iconColor} />
                <Text className="text-foreground text-[15px] font-medium">{label}</Text>
            </View>
            <View className="flex-row items-center" style={{ gap: 10 }}>
                <Text className="text-foreground text-base font-bold">
                    {formatCompactNumber(value)}
                </Text>
                {percentage && (
                    <Text className="text-muted-foreground text-[13px] font-medium min-w-[40px] text-right">
                        {percentage}
                    </Text>
                )}
            </View>
        </View>
        {showDivider && <View className="bg-border" style={{ height: StyleSheet.hairlineWidth }} />}
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
                        <CloseIcon size={20} className="text-foreground" />
                    </IconButton>,
                ],
            }}
            hideBottomBorder={true}
            disableSticky={true}
        />
    );

    if (loading) {
        return (
            <View className="flex-1 bg-background">
                {headerEl}
                <View className="flex-1 justify-center items-center py-12">
                    <Loading size="large" />
                </View>
            </View>
        );
    }

    if (!insights) {
        return (
            <View className="flex-1 bg-background">
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
        <View className="flex-1 bg-background">
            {headerEl}

            <ScrollView
                className="flex-1"
                showsVerticalScrollIndicator={false}
                contentContainerStyle={styles.contentContainer}
            >
                {/* Top-line metrics */}
                <View className="flex-row items-center py-4 mb-2">
                    <View className="flex-1 items-center">
                        <Text className="text-foreground text-[22px] font-extrabold" style={{ letterSpacing: -0.3 }}>
                            {formatCompactNumber(insights.stats.views)}
                        </Text>
                        <Text className="text-muted-foreground text-xs font-medium mt-0.5">
                            {t('insights.post.views')}
                        </Text>
                    </View>
                    <View className="bg-border" style={{ width: 0.5, height: 28 }} />
                    <View className="flex-1 items-center">
                        <Text className="text-foreground text-[22px] font-extrabold" style={{ letterSpacing: -0.3 }}>
                            {insights.engagement.engagementRate.toFixed(1)}%
                        </Text>
                        <Text className="text-muted-foreground text-xs font-medium mt-0.5">
                            {t('insights.post.engagementRate')}
                        </Text>
                    </View>
                    <View className="bg-border" style={{ width: 0.5, height: 28 }} />
                    <View className="flex-1 items-center">
                        <Text className="text-foreground text-[22px] font-extrabold" style={{ letterSpacing: -0.3 }}>
                            {formatCompactNumber(totalInteractions)}
                        </Text>
                        <Text className="text-muted-foreground text-xs font-medium mt-0.5">
                            {t('insights.post.interactions')}
                        </Text>
                    </View>
                </View>

                {/* Breakdown */}
                <Text className="text-foreground text-[15px] font-bold mb-3 mt-1">
                    {t('insights.post.interactions')}
                </Text>

                <StatRow icon="heart" iconColor="#FF3040" label={t('insights.post.likes')} value={insights.stats.likes} percentage={pct(insights.stats.likes)} />
                <StatRow icon="chatbubble" iconColor={theme.colors.primary} label={t('insights.post.replies')} value={insights.stats.replies} percentage={pct(insights.stats.replies)} />
                <StatRow icon="repeat" iconColor={theme.colors.primary} label={t('insights.post.reposts')} value={insights.stats.reposts} percentage={pct(insights.stats.reposts)} />
                {insights.stats.shares > 0 && (
                    <StatRow icon="share-social" iconColor={theme.colors.primary} label={t('insights.post.shares')} value={insights.stats.shares} percentage={pct(insights.stats.shares)} />
                )}
                {insights.stats.quotes > 0 && (
                    <StatRow icon="chatbox-ellipses" iconColor={theme.colors.primary} label={t('insights.post.quotes')} value={insights.stats.quotes} percentage={pct(insights.stats.quotes)} showDivider={false} />
                )}

                {insights.engagement.reach > 0 && (
                    <>
                        <Text className="text-foreground text-[15px] font-bold mb-3 mt-5">
                            {t('insights.post.reach')}
                        </Text>
                        <StatRow icon="people" iconColor={theme.colors.primary} label={t('insights.post.reach')} value={insights.engagement.reach} showDivider={false} />
                    </>
                )}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    contentContainer: {
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 24,
    },
});

export default PostInsightsSheet;
