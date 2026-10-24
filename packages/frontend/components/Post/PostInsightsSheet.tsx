import { InsightsSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { View, StyleSheet, ScrollView } from 'react-native';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import {
  BarListCard,
  ChartCardSurface,
  ChartHeadline,
  ChartStatTiles,
} from '@oxy.so/bloom/chart-cards';
import { RiBarChartHorizontalLine } from '@oxy.so/bloom/icons/RiBarChartHorizontalLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { insightsService } from '@/services/insightsService';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';
import { formatCompactNumber } from '@/utils/formatNumber';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

interface PostInsightsSheetProps {
  postId: string | null;
  onClose: () => void;
}

const PostInsightsSheet: React.FC<PostInsightsSheetProps> = ({ postId, onClose }) => {
  const { t } = useTranslation();

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
          appearance="subtle"
          tone="neutral"
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
        <InsightsSkeleton />
      </View>
    );
  }

  if (!insights) {
    return (
      <View className="flex-1 bg-background">
        {headerEl}
        <EmptyState
          title={t('insights.post.noInsightsAvailable')}
          icon={RiBarChartHorizontalLine}
        />
      </View>
    );
  }

  const totalInteractions = insights.engagement.totalInteractions;

  return (
    <View className="flex-1 bg-background">
      {headerEl}

      <ScrollView
        className="flex-1"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.contentContainer}
      >
        <ChartCardSurface height="auto" testID="post-insights-summary">
          <ChartHeadline
            label={t('insights.post.views')}
            value={insights.stats.views}
            format={formatCompactNumber}
          />
          <ChartStatTiles
            items={[
              {
                label: t('insights.post.engagementRate'),
                value: `${insights.engagement.engagementRate.toFixed(1)}%`,
              },
              {
                label: t('insights.post.interactions'),
                value: formatCompactNumber(totalInteractions),
              },
              ...(insights.engagement.reach > 0
                ? [
                    {
                      label: t('insights.post.reach'),
                      value: formatCompactNumber(insights.engagement.reach),
                    },
                  ]
                : []),
            ]}
          />
        </ChartCardSurface>
        <BarListCard
          testID="post-insights-interactions"
          title={t('insights.post.interactions')}
          metricLabel={t('insights.post.interactions')}
          metric="value"
          showShares
          format={formatCompactNumber}
          items={[
            { label: t('insights.post.likes'), value: insights.stats.likes },
            { label: t('insights.post.replies'), value: insights.stats.replies },
            { label: t('insights.post.boosts'), value: insights.stats.boosts },
            { label: t('insights.post.shares'), value: insights.stats.shares },
            { label: t('insights.post.quotes'), value: insights.stats.quotes },
          ]}
        />
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  contentContainer: {
    gap: 16,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 24,
  },
});

export default PostInsightsSheet;
