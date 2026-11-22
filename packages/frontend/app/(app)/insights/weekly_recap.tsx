import { InsightsSkeleton } from '@/components/loading/ContentSkeleton';
import { useQuery } from '@tanstack/react-query';
import { useAuth, OxyAuthPrompt } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import type { HydratedPost } from '@mention/shared-types';
import { insightsService } from '@/services/insightsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { usePostsStore } from '@/stores/postsStore';
import { EmptyState } from '@/components/common/EmptyState';
import { WeeklyRecapContent } from '@/components/insights/WeeklyRecapContent';
import { Embed, Header, ScrollView, toElement } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

export default screen(function WeeklyRecapScreen() {
  const { t } = useTranslation();
  const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const getPostsByIds = usePostsStore((state) => state.getPostsByIds);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: viewerQueryKeys.weeklyRecapPosts(user?.id),
    enabled: canUsePrivateApi,
    queryFn: async () => {
      // Use the API's actual period. Sparse daily rows cannot be split into
      // weeks by array position; the API doesn't provide prior-week post totals.
      const stats = await insightsService.getAccountInsights(7);
      const topPosts: HydratedPost[] = await getPostsByIds(
        stats.topPosts.slice(0, 5).map((post) => post.postId),
      ).catch(() => []);
      return { stats, topPosts };
    },
  });
  const { data: summary } = useQuery({
    queryKey: viewerQueryKeys.weeklyRecapSummary(user?.id),
    enabled: canUsePrivateApi,
    queryFn: () => insightsService.getWeeklySummary(),
    retry: false,
  });
  const content = data ? <WeeklyRecapContent {...data} summary={summary?.summary ?? null} /> : null;
  return Embed(
    isPrivateApiPending || isLoading ? (
      toElement(ScrollView(Embed(<InsightsSkeleton />)))
    ) : !canUsePrivateApi ? (
      <OxyAuthPrompt
        label={t('insights.signInRequired')}
        description={t('insights.signInRequiredDesc')}
      />
    ) : isError ? (
      <EmptyState
        error={{
          title: t('insights.unavailable.title', { defaultValue: 'Insights unavailable' }),
          message: t('insights.unavailable.message', {
            defaultValue: 'These insights could not be loaded. Please try again.',
          }),
          onRetry: async () => {
            await refetch();
          },
        }}
      />
    ) : (
      toElement(ScrollView(Embed(content)))
    ),
  ).header(
    Header(t('insights.weeklyRecap.title'))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );
});
