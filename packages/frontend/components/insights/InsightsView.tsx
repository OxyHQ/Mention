import { InsightsSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { useState, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useTheme } from '@oxy.so/bloom/theme';
import { insightsService } from '@/services/insightsService';
import { useTranslation } from 'react-i18next';
import { useAuth, OxyAuthPrompt } from '@oxy.so/services/ui/client';
import { usePostsStore } from '@/stores/postsStore';
import type { HydratedPost } from '@mention/shared-types';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { EmptyState } from '@/components/common/EmptyState';
import { logger } from '@oxy.so/core/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { InsightsDashboard } from './InsightsDashboard';

export interface InsightsViewProps {
  /**
   * The account the numbers are ABOUT. Absent ⇒ the signed-in viewer, which is
   * every use this screen had before channels got a page of their own.
   *
   * A channel can never be signed in as, so its operators reach its numbers
   * only by naming it here. The server independently decides whether this
   * viewer may — an id put here by a caller who does not operate the account is
   * refused, never silently answered with the viewer's own figures.
   */
  accountId?: string;
}

/**
 * The Insights dashboard — period selector, overview and engagement tabs.
 *
 * Owns everything below the screen header so that the two routes rendering it
 * differ only in whose numbers they ask for and what their header says: the
 * viewer's own at `/insights`, and a channel's at `/c/<handle>/insights`. There
 * is deliberately one implementation; a second analytics surface would be a
 * second set of definitions for "engagement rate" waiting to disagree.
 *
 * ## The weekly recap belongs to a PERSON, so it appears only for one
 *
 * The recap row is rendered only when there is no `accountId`. It is not a
 * missing feature for channels: `/statistics/weekly-summary` takes no account and
 * writes a second-person retrospective ("your week") in the reader's own
 * language, over a screen showing the reader's own avatar. Offered on a channel
 * it would either address one operator as though the channel's week were theirs,
 * or link to a page answering about the wrong subject entirely.
 *
 * Hiding the row is therefore the honest shape rather than a stub: affordance ⊆
 * permission — the app never offers a row the server will refuse or misanswer.
 */
export const InsightsView: React.FC<InsightsViewProps> = ({ accountId }) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const { user, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const [selectedPeriod, setSelectedPeriod] = useState(30);
  const [activeTab, setActiveTab] = useState<'overview' | 'engagement' | 'publishing'>('overview');

  const { getPostById } = usePostsStore();

  // Stats + engagement + hydrated top posts for the selected period. Keyed on
  // the auth identity, the SUBJECT and the period so it fires only once the
  // session lands, auto-re-runs when `user?.id` arrives after SSO restore, and
  // never serves one account's figures under another's name. `keepPreviousData`
  // keeps the previous period on screen while a new one loads, matching the
  // original background-prefetch smoothness. Gated on `canUsePrivateApi` since
  // /statistics/* are private endpoints.
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: viewerQueryKeys.insights(user?.id, accountId, selectedPeriod),
    queryFn: async () => {
      const [stats, engagement] = await Promise.all([
        insightsService.getAccountInsights(selectedPeriod, { accountId }),
        insightsService.getEngagementRatios(selectedPeriod, { accountId }),
      ]);

      let topPosts: HydratedPost[] = [];
      if (stats.topPosts && stats.topPosts.length > 0) {
        const posts = await Promise.all(
          stats.topPosts.slice(0, 5).map((postInfo) =>
            getPostById(postInfo.postId).catch((error: unknown) => {
              const status = (error as { response?: { status?: number } })?.response?.status;
              if (status !== 404) {
                logger.error(`Error loading post ${postInfo.postId}`, error);
              }
              return null;
            }),
          ),
        );
        topPosts = posts.filter((p): p is HydratedPost => p !== null);
      }

      return { stats, engagement, topPosts };
    },
    enabled: canUsePrivateApi,
    placeholderData: keepPreviousData,
  });

  const stats = data?.stats ?? null;
  const engagementRatios = data?.engagement ?? null;
  const topPostsData = data?.topPosts ?? [];

  const handlePeriodChange = useCallback(
    (val: number) => {
      if (val !== selectedPeriod) setSelectedPeriod(val);
    },
    [selectedPeriod],
  );

  return (
    <>
      <View
        className="relative web:sticky top-0 z-[100]"
        style={{
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
          backgroundColor: theme.colors.background,
        }}
      >
        <Tabs
          value={activeTab}
          onValueChange={(tabId) => setActiveTab(tabId as 'overview' | 'engagement' | 'publishing')}
          variant="underline"
        >
          {[
            { id: 'overview', label: t('insights.tabs.overview') },
            { id: 'engagement', label: t('insights.tabs.engagement') },
            { id: 'publishing', label: t('insights.publishing') },
          ].map((tab: { id: string; label: string; count?: number }) => (
            <TabsTrigger key={tab.id} value={tab.id} label={tab.label} count={tab.count} />
          ))}
        </Tabs>
      </View>

      {isPrivateApiPending || isLoading ? (
        <InsightsSkeleton />
      ) : !canUsePrivateApi ? (
        <OxyAuthPrompt
          label={t('insights.signInRequired', { defaultValue: 'Sign in to see your insights' })}
          description={t('insights.signInRequiredDesc', {
            defaultValue:
              'Your posts, views, and engagement stats will appear here once you sign in.',
          })}
        />
      ) : isError ? (
        // A failed read must SAY so. Both tab bodies return `null` when
        // their data is missing, so without this branch a refusal or an
        // outage paints an empty panel under a working period selector —
        // indistinguishable from an account that genuinely has no
        // activity, and far worse than an honest error, because there is
        // nothing to retry and nothing to report.
        //
        // The reachable refusal is narrow but real: the affordance and the
        // API resolve membership through two different Oxy reads —
        // `listAccounts` (effective, so an INHERITED membership counts) on
        // the client, `listAccounts/:id/members` (direct rows only) on the
        // server. A member whose role cascades from an ancestor account is
        // therefore offered the screen and refused the data. That gap is
        // known and lives in the shared publish-as authority rather than
        // here; what this branch owes such a reader is a plain statement
        // that the numbers could not be loaded.
        <EmptyState
          error={{
            title: t('insights.unavailable.title', { defaultValue: 'Insights unavailable' }),
            message: t('insights.unavailable.message', {
              defaultValue:
                'These insights could not be loaded. You may not have access to this account, or the service may be temporarily unavailable.',
            }),
            onRetry: async () => {
              await refetch();
            },
          }}
        />
      ) : stats && engagementRatios ? (
        <InsightsDashboard
          stats={stats}
          engagementRatios={engagementRatios}
          topPostsData={topPostsData}
          accountId={accountId}
          selectedPeriod={selectedPeriod}
          handlePeriodChange={handlePeriodChange}
          activeTab={activeTab}
          isFetching={isFetching}
        />
      ) : null}
    </>
  );
};

export default InsightsView;
