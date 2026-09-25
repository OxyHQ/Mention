import type { Href } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import type { MentionJobPosting, MentionJobStatus } from '@mention/shared-types';
import { useSafeBack } from '@/hooks/useSafeBack';
import { confirmDestructive } from '@/utils/alerts';
import { formatTimeAgo } from '@/utils/dateUtils';
import { displayNameOrHandle } from '@/utils/displayName';
import { SignInRequired } from '@/components/common/SignInRequired';
import { jobsService, getJobErrorMessage } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

type JobAction = 'publish' | 'pause' | 'close' | 'duplicate';

const STATUS_TONE: Record<MentionJobStatus, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
  draft: 'default',
  published: 'success',
  paused: 'warning',
  closed: 'error',
  expired: 'error',
};

/**
 * The caller's own job listings, across every organization/project account
 * they operate — `GET /jobs/mine`. Employer identity for each row is resolved
 * from the SAME account-graph read the composer's "publish as" picker uses
 * (`viewerQueryKeys.operatedAccounts`), rather than one profile fetch per
 * job: every employer a job can name is necessarily an account the caller
 * operates, so that list is already the complete lookup table.
 */
export default function MyJobsScreen() {
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const jobsQuery = useQuery({
    queryKey: viewerQueryKeys.jobsMine(user?.id),
    queryFn: () => jobsService.getMine(),
    enabled: canUsePrivateApi,
  });

  const { data: accounts = [] } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.listAccounts(),
    enabled: canUsePrivateApi,
  });

  const accountsById = useMemo(() => {
    const map = new Map<string, AccountNode>();
    for (const account of accounts) map.set(account.accountId, account);
    return map;
  }, [accounts]);

  const employerLabel = useCallback(
    (employerOxyUserId: string) => {
      const account = accountsById.get(employerOxyUserId);
      if (!account) return employerOxyUserId;
      return displayNameOrHandle(account.account.name?.displayName, account.account.username ?? '');
    },
    [accountsById],
  );

  const invalidateJobs = useCallback(
    () => queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobsMine(user?.id) }),
    [queryClient, user?.id],
  );

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: JobAction }) => jobsService[action](id),
    onMutate: ({ id }) => setPendingId(id),
    onSuccess: async () => {
      await invalidateJobs();
    },
    onError: (error) => {
      logger.error('[jobs/mine] Job action failed', error);
      toast.error(getJobErrorMessage(error, t('jobs.mine.actionFailed', { defaultValue: 'That action failed' })));
    },
    onSettled: () => setPendingId(null),
  });

  const runAction = useCallback(
    (id: string, action: JobAction) => actionMutation.mutate({ id, action }),
    [actionMutation],
  );

  const discardDraft = useCallback(
    async (job: MentionJobPosting) => {
      const confirmed = await confirmDestructive(
        t('jobs.mine.discardTitle', { defaultValue: 'Discard this draft?' }),
        t('jobs.mine.discardMessage', { defaultValue: 'This closes the draft. It will no longer appear as active.' }),
      );
      if (!confirmed) return;
      runAction(job.id, 'close');
    },
    [runAction, t],
  );

  const openJob = useCallback((job: MentionJobPosting) => {
    try {
      const path = new URL(job.canonicalUrl).pathname;
      router.push((path || `/jobs/${job.id}`) as Href);
    } catch {
      router.push(`/jobs/${job.id}`);
    }
  }, []);

  const editJob = useCallback((job: MentionJobPosting) => {
    router.push(`/jobs/${job.id}/edit`);
  }, []);

  const header = (
    <PageHeader
      title={t('jobs.mine.title', { defaultValue: 'My jobs' })}
      onBack={() => safeBack()}
      backLabel={t('common.back', { defaultValue: 'Back' })}
      actions={
        canUsePrivateApi ? (
          <Button appearance="solid" tone="accent" size="small" onPress={() => router.push('/jobs/create')}>
            {t('jobs.mine.create', { defaultValue: 'Create job' })}
          </Button>
        ) : undefined
      }
    />
  );

  // Signed out this used to spin forever: the query is disabled, so
  // `isLoading` never settles. The gate shows the pending spinner or the
  // sign-in prompt instead.
  if (!canUsePrivateApi) {
    return (
      <View className="flex-1">
        {header}
        <SignInRequired
          label={t('jobs.signInRequired', { defaultValue: 'Sign in to publish jobs' })}
          description={t('jobs.signInRequiredDesc', {
            defaultValue: 'Jobs are published by an organization or project account you operate.',
          })}
        />
      </View>
    );
  }

  if (jobsQuery.isLoading) {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  if (jobsQuery.isError) {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Text className="text-muted-foreground text-base text-center">
            {t('jobs.mine.loadFailed', { defaultValue: 'Could not load your jobs' })}
          </Text>
          <Button appearance="subtle" tone="neutral" size="small" onPress={() => jobsQuery.refetch()}>
            {t('common.tryAgain', { defaultValue: 'Try again' })}
          </Button>
        </View>
      </View>
    );
  }

  const jobs = jobsQuery.data?.jobs ?? [];

  return (
    <View className="flex-1">
      {header}
      <ScrollView className="flex-1" contentContainerClassName="pb-10">
        {jobs.length === 0 ? (
          <View className="items-center justify-center py-16 gap-3 px-8">
            <Text className="text-foreground text-base font-semibold text-center">
              {t('jobs.mine.emptyTitle', { defaultValue: 'No jobs yet' })}
            </Text>
            <Text className="text-muted-foreground text-sm text-center">
              {t('jobs.mine.emptySubtitle', {
                defaultValue: 'Create a job listing for an organization or project account you operate.',
              })}
            </Text>
            <Button appearance="solid" tone="accent" size="medium" onPress={() => router.push('/jobs/create')}>
              {t('jobs.mine.create', { defaultValue: 'Create job' })}
            </Button>
          </View>
        ) : (
          <View className="px-4 gap-3 mt-2">
            {jobs.map((job) => {
              const busy = pendingId === job.id && actionMutation.isPending;
              const dateLabel = job.publishedAt
                ? t('jobs.mine.publishedAgo', { defaultValue: 'Published {{time}}', time: formatTimeAgo(job.publishedAt) })
                : t('jobs.mine.createdAgo', { defaultValue: 'Created {{time}}', time: formatTimeAgo(job.createdAt) });

              return (
                <Card key={job.id} border="thin" elevation="none" radius="radius-16">
                  <Item
                    title={job.title}
                    subtitle={`${employerLabel(job.employerOxyUserId)} · ${dateLabel}`}
                    trailing={<Badge content={job.status} color={STATUS_TONE[job.status]} variant="subtle" size="small" />}
                    onPress={() => editJob(job)}
                  />
                  <View className="flex-row items-center justify-between px-4 pb-3 pt-1">
                    <Text className="text-muted-foreground text-xs">
                      {t('jobs.mine.applications', { defaultValue: '{{count}} applications', count: job.applicationCount })}
                    </Text>
                    <View className="flex-row flex-wrap gap-2 justify-end">
                      {job.status === 'draft' && (
                        <>
                          <Button appearance="subtle" tone="neutral" size="small" onPress={() => editJob(job)}>
                            {t('common.edit', { defaultValue: 'Edit' })}
                          </Button>
                          <Button
                            appearance="solid" tone="accent"
                            size="small"
                            loading={busy}
                            onPress={() => runAction(job.id, 'publish')}
                          >
                            {t('jobs.mine.publish', { defaultValue: 'Publish' })}
                          </Button>
                          <Button
                            appearance="plain" tone="neutral"
                            size="small"
                            loading={busy}
                            onPress={() => discardDraft(job)}
                          >
                            {t('jobs.mine.discard', { defaultValue: 'Discard' })}
                          </Button>
                        </>
                      )}
                      {job.status === 'published' && (
                        <>
                          <Button appearance="subtle" tone="neutral" size="small" onPress={() => openJob(job)}>
                            {t('common.view', { defaultValue: 'View' })}
                          </Button>
                          <Button appearance="subtle" tone="neutral" size="small" onPress={() => editJob(job)}>
                            {t('common.edit', { defaultValue: 'Edit' })}
                          </Button>
                          <Button
                            appearance="subtle" tone="neutral"
                            size="small"
                            loading={busy}
                            onPress={() => runAction(job.id, 'pause')}
                          >
                            {t('jobs.mine.pause', { defaultValue: 'Pause' })}
                          </Button>
                          <Button
                            appearance="plain" tone="neutral"
                            size="small"
                            loading={busy}
                            onPress={() => runAction(job.id, 'close')}
                          >
                            {t('jobs.mine.close', { defaultValue: 'Close' })}
                          </Button>
                        </>
                      )}
                      {job.status === 'paused' && (
                        <>
                          <Button appearance="subtle" tone="neutral" size="small" onPress={() => editJob(job)}>
                            {t('common.edit', { defaultValue: 'Edit' })}
                          </Button>
                          <Button
                            appearance="solid" tone="accent"
                            size="small"
                            loading={busy}
                            onPress={() => runAction(job.id, 'publish')}
                          >
                            {t('jobs.mine.publish', { defaultValue: 'Publish' })}
                          </Button>
                          <Button
                            appearance="plain" tone="neutral"
                            size="small"
                            loading={busy}
                            onPress={() => runAction(job.id, 'close')}
                          >
                            {t('jobs.mine.close', { defaultValue: 'Close' })}
                          </Button>
                        </>
                      )}
                      {(job.status === 'closed' || job.status === 'expired') && (
                        <Button
                          appearance="subtle" tone="neutral"
                          size="small"
                          loading={busy}
                          onPress={() => runAction(job.id, 'duplicate')}
                        >
                          {t('jobs.mine.duplicate', { defaultValue: 'Duplicate' })}
                        </Button>
                      )}
                      {/* Applications only exist for jobs applicants apply to
                          THROUGH Mention — an `external` job's applications
                          live on whatever site its `externalApplyUrl` points
                          to, and Mention never sees them. */}
                      {job.applicationMode === 'mention' && (
                        <Button
                          appearance="subtle" tone="neutral"
                          size="small"
                          onPress={() => router.push(`/jobs/${job.id}/applications`)}
                        >
                          {t('jobs.mine.viewApplications', { defaultValue: 'View applications' })}
                        </Button>
                      )}
                    </View>
                  </View>
                </Card>
              );
            })}
          </View>
        )}
      </ScrollView>
    </View>
  );
}
