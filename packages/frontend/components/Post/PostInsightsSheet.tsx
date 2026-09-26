import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import {
    View,
    Text,
    StyleSheet,
    ScrollView,
} from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { useTheme } from '@oxy.so/bloom/theme';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { RiChat3Fill } from '@oxy.so/bloom/icons/RiChat3Fill';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiDoubleQuotesL } from '@oxy.so/bloom/icons/RiDoubleQuotesL';
import { RiGroupFill } from '@oxy.so/bloom/icons/RiGroupFill';
import { RiHeartFill } from '@oxy.so/bloom/icons/RiHeartFill';
import { RiRepeat2Line } from '@oxy.so/bloom/icons/RiRepeat2Line';
import { RiShare2Line } from '@oxy.so/bloom/icons/RiShare2Line';
import { insightsService } from '@/services/insightsService';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';
import { formatCompactNumber } from '@/utils/formatNumber';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { StatRow } from '@/components/insights/StatRow';

interface PostInsightsSheetProps {
    postId: string | null;
    onClose: () => void;
}

const PostInsightsSheet: React.FC<PostInsightsSheetProps> = ({ postId, onClose }) => {
    const { t } = useTranslation();
    const theme = useTheme();

    const { user, canUsePrivateApi } = useAuth();

    // Insights are the owner's own private analytics, so the key carries the
    // viewer: a cold boot that resolves a session 5-25s after mount changes the
    // key and refetches, rather than caching whatever the anonymous attempt got.
    const { data: insights, isLoading } = useQuery({
        queryKey: viewerQueryKeys.postInsights(user?.id, postId ?? ''),
        queryFn: () => insightsService.getPostInsights(postId ?? ''),
        enabled: canUsePrivateApi && Boolean(postId),
        staleTime: 60_000,
    });

    const headerEl = (
        <PageHeader
            title={t('insights.post.title')}
            safeArea={false}
            actions={
                <Button
                    appearance="subtle" tone="neutral"
                    iconOnly
                    leadingIcon={RiCloseLine}
                    accessibilityLabel={t('common.close', { defaultValue: 'Close' })}
                    onPress={onClose}
                />
            }
        />
    );

    if (isLoading) {
        return (
            <View className="flex-1 bg-background">
                {headerEl}
                <View className="flex-1 justify-center items-center py-12">
                    <Loading className="text-primary" size="large" />
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
                    <Divider vertical style={styles.metricDivider} />
                    <View className="flex-1 items-center">
                        <Text className="text-foreground text-[22px] font-extrabold" style={{ letterSpacing: -0.3 }}>
                            {insights.engagement.engagementRate.toFixed(1)}%
                        </Text>
                        <Text className="text-muted-foreground text-xs font-medium mt-0.5">
                            {t('insights.post.engagementRate')}
                        </Text>
                    </View>
                    <Divider vertical style={styles.metricDivider} />
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

                <StatRow icon={<RiHeartFill width={18} height={18} fill="#FF3040" />} label={t('insights.post.likes')} value={insights.stats.likes} sub={pct(insights.stats.likes)} />
                <StatRow icon={<RiChat3Fill width={18} height={18} fill={theme.colors.primary} />} label={t('insights.post.replies')} value={insights.stats.replies} sub={pct(insights.stats.replies)} />
                <StatRow icon={<RiRepeat2Line width={18} height={18} fill={theme.colors.primary} />} label={t('insights.post.boosts')} value={insights.stats.boosts} sub={pct(insights.stats.boosts)} />
                {insights.stats.shares > 0 && (
                    <StatRow icon={<RiShare2Line width={18} height={18} fill={theme.colors.primary} />} label={t('insights.post.shares')} value={insights.stats.shares} sub={pct(insights.stats.shares)} />
                )}
                {insights.stats.quotes > 0 && (
                    <StatRow icon={<RiDoubleQuotesL width={18} height={18} fill={theme.colors.primary} />} label={t('insights.post.quotes')} value={insights.stats.quotes} sub={pct(insights.stats.quotes)} showDivider={false} />
                )}

                {insights.engagement.reach > 0 && (
                    <>
                        <Text className="text-foreground text-[15px] font-bold mb-3 mt-5">
                            {t('insights.post.reach')}
                        </Text>
                        <StatRow icon={<RiGroupFill width={18} height={18} fill={theme.colors.primary} />} label={t('insights.post.reach')} value={insights.engagement.reach} showDivider={false} />
                    </>
                )}
            </ScrollView>
        </View>
    );
};

const styles = StyleSheet.create({
    // A vertical `Divider` stretches to its row; the figures' rule is shorter.
    metricDivider: {
        height: 28,
        alignSelf: 'center',
    },
    contentContainer: {
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 24,
    },
});

export default PostInsightsSheet;
