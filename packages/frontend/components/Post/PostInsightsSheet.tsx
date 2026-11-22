import { commerceService } from '@/services/commerceService';
import { usePostSelector } from '@/stores/postsStore';
import { InsightsSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { Screen } from '@oxy.so/bloom/screen';
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

import {
  Button as LButton,
  Embed,
  Header,
  Icon,
  RawText,
  ScrollView,
  toElement,
} from '@oxy.so/bloom-language';

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

  const cachedPost = usePostSelector(postId ?? undefined);
  const hasCommerce = Boolean(
    cachedPost?.content?.attachments?.some((item) => item.type === 'commerce'),
  );
  const commerce = useQuery({
    queryKey: viewerQueryKeys.commerceMetrics(user?.id, 'posts', postId),
    queryFn: () => commerceService.metrics('posts', postId ?? ''),
    enabled: canUsePrivateApi && Boolean(postId) && hasCommerce,
    staleTime: 60_000,
  });

  const headerEl = toElement(
    Header(t('insights.post.title'))
      .safeArea(false)
      .onBack(null)
      .toolbar(
        LButton(Icon(RiCloseLine))
          .shape('circle')
          .style('subtle')
          .tint('neutral')
          .label(t('common.close', { defaultValue: 'Close' }))
          .onPress(onClose),
      )
      .inPage(),
  );

  return (
    <Screen scroll="auto" header={headerEl} testID="post-insights-screen">
      {toElement(
        ScrollView(
          Embed(
            isLoading ? (
              <InsightsSkeleton />
            ) : !insights ? (
              <EmptyState
                title={t('insights.post.noInsightsAvailable')}
                icon={RiBarChartHorizontalLine}
              />
            ) : (
              <>
                {commerce.data ? (
                  <ChartCardSurface height="auto" testID="post-commerce-insights">
                    {toElement(
                      RawText(t('commerce.shop', { defaultValue: 'Shop' }))
                        .foreground('foreground')
                        .weight('semibold'),
                    )}
                    {toElement(
                      RawText(
                        commerce.data.suppressed
                          ? t('commerce.metricsSuppressed', {
                              defaultValue:
                                'Activity totals appear after at least {{count}} opens in the last 30 days.',
                              count: commerce.data.minimumOpens,
                            })
                          : t('commerce.metricsSummary', {
                              defaultValue:
                                'Last 30 days: {{opens}} opens · {{handoffs}} visits to Mercaria. Counts are interactions, not unique visitors or sales.',
                              opens: commerce.data.opens,
                              handoffs: commerce.data.handoffs,
                            }),
                      ).foreground('muted'),
                    )}
                  </ChartCardSurface>
                ) : null}
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
                        value: formatCompactNumber(insights.engagement.totalInteractions),
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
              </>
            ),
          ),
        ).contentView((v) =>
          v.padding('horizontal', 'xl').padding('top', 'sm').padding('bottom', '2xl').spacing('lg'),
        ),
      )}
    </Screen>
  );
};

export default PostInsightsSheet;
