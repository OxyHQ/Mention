import { InsightsSkeleton } from '@/components/loading/ContentSkeleton';
import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { useAuth, OxyAuthPrompt } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import type { HydratedPost } from '@mention/shared-types';
import { useSafeBack } from '@/hooks/useSafeBack';
import { insightsService } from '@/services/insightsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { usePostsStore } from '@/stores/postsStore';
import { EmptyState } from '@/components/common/EmptyState';
import { WeeklyRecapContent } from '@/components/insights/WeeklyRecapContent';

export default function WeeklyRecapScreen() {
  const { t } = useTranslation();
  const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();
  const safeBack = useSafeBack();
  const getPostById = usePostsStore((state) => state.getPostById);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: viewerQueryKeys.weeklyRecapPosts(user?.id),
    enabled: canUsePrivateApi,
    queryFn: async () => {
      // Use the API's actual period. Sparse daily rows cannot be split into
      // weeks by array position; the API doesn't provide prior-week post totals.
      const stats = await insightsService.getAccountInsights(7);
      const posts = await Promise.all(
        stats.topPosts.slice(0, 5).map((post) => getPostById(post.postId).catch(() => null)),
      );
      return {
        stats,
        topPosts: posts.filter((post): post is HydratedPost => post !== null),
      };
    },
  });
  const { data: summary } = useQuery({
    queryKey: viewerQueryKeys.weeklyRecapSummary(user?.id),
    enabled: canUsePrivateApi,
    queryFn: () => insightsService.getWeeklySummary(),
    retry: false,
  });
  const content = data ? <WeeklyRecapContent {...data} summary={summary?.summary ?? null} /> : null;
  return (
    <Screen
      header={
        <PageHeader
          title={t('insights.weeklyRecap.title')}
          onBack={() => safeBack()}
          backLabel={t('common.back', { defaultValue: 'Back' })}
        />
      }
    >
      {isPrivateApiPending || isLoading ? (
        <ScreenScrollView>
          <InsightsSkeleton />
        </ScreenScrollView>
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
        <ScreenScrollView showsVerticalScrollIndicator={false}>{content}</ScreenScrollView>
      )}
    </Screen>
  );
}
