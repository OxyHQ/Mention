import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import type { Href } from '@/lib/navigation/router';
import { useCallback, useMemo, useState } from 'react';
import { useRouter } from '@/lib/navigation/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import type { MentionJobPosting, MentionJobStatus } from '@mention/shared-types';
import { confirmDestructive } from '@/utils/alerts';
import { formatTimeAgo } from '@/utils/dateUtils';
import { displayNameOrHandle } from '@/utils/displayName';
import { SignInRequired } from '@/components/common/SignInRequired';
import { jobsService, getJobErrorMessage } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { EmptyState } from '@/components/common/EmptyState';

import {
  Badge as LBadge,
  Button as LButton,
  Card as LCard,
  Embed,
  HStack,
  Header,
  RawText,
  Row,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

type JobAction = 'publish' | 'pause' | 'close' | 'duplicate';

const STATUS_TONE: Record<
  MentionJobStatus,
  'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'
> = {
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
export default screen(function MyJobsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const jobsQuery = useQuery({
    queryKey: viewerQueryKeys.jobsMine(user?.id),
    queryFn: () => jobsService.getMine(),
    enabled: canUsePrivateApi,
  });

  const { data: accounts = [] } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.accounts.list(),
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
      toast.error(
        getJobErrorMessage(
          error,
          t('jobs.mine.actionFailed', { defaultValue: 'That action failed' }),
        ),
      );
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
        t('jobs.mine.discardMessage', {
          defaultValue: 'This closes the draft. It will no longer appear as active.',
        }),
      );
      if (!confirmed) return;
      runAction(job.id, 'close');
    },
    [runAction, t],
  );

  const openJob = useCallback(
    (job: MentionJobPosting) => {
      try {
        const path = new URL(job.canonicalUrl).pathname;
        router.push((path || `/jobs/${job.id}`) as Href);
      } catch {
        router.push(`/jobs/${job.id}`);
      }
    },
    [router],
  );

  const editJob = useCallback(
    (job: MentionJobPosting) => {
      router.push(`/jobs/${job.id}/edit`);
    },
    [router],
  );

  const header = toElement(
    Header(t('jobs.mine.title', { defaultValue: 'My jobs' }))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .toolbar(
        Embed(
          canUsePrivateApi
            ? toElement(
                LButton(LText(t('jobs.mine.create', { defaultValue: 'Create job' })))
                  .style('solid')
                  .tint('accent')
                  .onPress(() => router.push('/jobs/create')),
              )
            : undefined,
        ),
      )
      .inPage(),
  );

  // Signed out this used to spin forever: the query is disabled, so
  // `isLoading` never settles. The gate shows the pending spinner or the
  // sign-in prompt instead.
  if (!canUsePrivateApi) {
    return Embed(
      <SignInRequired
        label={t('jobs.signInRequired', { defaultValue: 'Sign in to publish jobs' })}
        description={t('jobs.signInRequiredDesc', {
          defaultValue: 'Jobs are published by an organization or project account you operate.',
        })}
      />,
    ).header(Embed(header));
  }

  if (jobsQuery.isLoading) {
    return ScrollView(Embed(<ListSkeleton />)).header(Embed(header));
  }

  if (jobsQuery.isError) {
    return VStack(
      RawText(t('jobs.mine.loadFailed', { defaultValue: 'Could not load your jobs' }))
        .foreground('muted')
        .font('16')
        .leading('normal')
        .textAlign('center'),
      LButton(LText(t('common.tryAgain', { defaultValue: 'Try again' })))
        .style('subtle')
        .tint('neutral')
        .size('sm')
        .onPress(() => jobsQuery.refetch()),
    )
      .padding('horizontal', '3xl')
      .flex('1')
      .align('center')
      .justify('center')
      .spacing('md')
      .header(Embed(header));
  }

  const jobs = jobsQuery.data?.jobs ?? [];

  return ScrollView(
    Embed(
      jobs.length === 0 ? (
        <EmptyState
          title={t('jobs.mine.emptyTitle', { defaultValue: 'No jobs yet' })}
          subtitle={t('jobs.mine.emptySubtitle', {
            defaultValue:
              'Create a job listing for an organization or project account you operate.',
          })}
          action={{
            label: t('jobs.mine.create', { defaultValue: 'Create job' }),
            onPress: () => router.push('/jobs/create'),
          }}
          sticker="jobsMine"
          containerStyle={{ paddingTop: 40 }}
        />
      ) : (
        toElement(
          VStack(
            Embed(
              jobs.map((job) => {
                const busy = pendingId === job.id && actionMutation.isPending;
                const dateLabel = job.publishedAt
                  ? t('jobs.mine.publishedAgo', {
                      defaultValue: 'Published {{time}}',
                      time: formatTimeAgo(job.publishedAt),
                    })
                  : t('jobs.mine.createdAgo', {
                      defaultValue: 'Created {{time}}',
                      time: formatTimeAgo(job.createdAt),
                    });

                return toElement(
                  LCard(
                    Row(job.title)
                      .subtitle(`${employerLabel(job.employerOxyUserId)} · ${dateLabel}`)
                      .trailing(
                        LBadge(job.status)
                          .style('subtle')
                          .color(STATUS_TONE[job.status])
                          .size('sm'),
                      )
                      .onPress(() => editJob(job)),
                    HStack(
                      RawText(
                        t('jobs.mine.applications', {
                          defaultValue: '{{count}} applications',
                          count: job.applicationCount,
                        }),
                      )
                        .foreground('muted')
                        .font('xs')
                        .leading('16px'),
                      HStack(
                        Embed(
                          job.status === 'draft' && (
                            <>
                              {toElement(
                                LButton(LText(t('common.edit', { defaultValue: 'Edit' })))
                                  .style('subtle')
                                  .tint('neutral')
                                  .size('sm')
                                  .onPress(() => editJob(job)),
                              )}
                              {toElement(
                                LButton(LText(t('jobs.mine.publish', { defaultValue: 'Publish' })))
                                  .style('solid')
                                  .tint('accent')
                                  .size('sm')
                                  .loading(busy)
                                  .onPress(() => runAction(job.id, 'publish')),
                              )}
                              {toElement(
                                LButton(LText(t('jobs.mine.discard', { defaultValue: 'Discard' })))
                                  .style('plain')
                                  .tint('neutral')
                                  .size('sm')
                                  .loading(busy)
                                  .onPress(() => discardDraft(job)),
                              )}
                            </>
                          ),
                        ),
                        Embed(
                          job.status === 'published' && (
                            <>
                              {toElement(
                                LButton(LText(t('common.view', { defaultValue: 'View' })))
                                  .style('subtle')
                                  .tint('neutral')
                                  .size('sm')
                                  .onPress(() => openJob(job)),
                              )}
                              {toElement(
                                LButton(LText(t('common.edit', { defaultValue: 'Edit' })))
                                  .style('subtle')
                                  .tint('neutral')
                                  .size('sm')
                                  .onPress(() => editJob(job)),
                              )}
                              {toElement(
                                LButton(LText(t('jobs.mine.pause', { defaultValue: 'Pause' })))
                                  .style('subtle')
                                  .tint('neutral')
                                  .size('sm')
                                  .loading(busy)
                                  .onPress(() => runAction(job.id, 'pause')),
                              )}
                              {toElement(
                                LButton(LText(t('jobs.mine.close', { defaultValue: 'Close' })))
                                  .style('plain')
                                  .tint('neutral')
                                  .size('sm')
                                  .loading(busy)
                                  .onPress(() => runAction(job.id, 'close')),
                              )}
                            </>
                          ),
                        ),
                        Embed(
                          job.status === 'paused' && (
                            <>
                              {toElement(
                                LButton(LText(t('common.edit', { defaultValue: 'Edit' })))
                                  .style('subtle')
                                  .tint('neutral')
                                  .size('sm')
                                  .onPress(() => editJob(job)),
                              )}
                              {toElement(
                                LButton(LText(t('jobs.mine.publish', { defaultValue: 'Publish' })))
                                  .style('solid')
                                  .tint('accent')
                                  .size('sm')
                                  .loading(busy)
                                  .onPress(() => runAction(job.id, 'publish')),
                              )}
                              {toElement(
                                LButton(LText(t('jobs.mine.close', { defaultValue: 'Close' })))
                                  .style('plain')
                                  .tint('neutral')
                                  .size('sm')
                                  .loading(busy)
                                  .onPress(() => runAction(job.id, 'close')),
                              )}
                            </>
                          ),
                        ),
                        job.status === 'closed' || job.status === 'expired'
                          ? LButton(LText(t('jobs.mine.duplicate', { defaultValue: 'Duplicate' })))
                              .style('subtle')
                              .tint('neutral')
                              .size('sm')
                              .loading(busy)
                              .onPress(() => runAction(job.id, 'duplicate'))
                          : null,
                        /* Applications only exist for jobs applicants apply to
                                THROUGH Mention — an `external` job's applications
                                live on whatever site its `externalApplyUrl` points
                                to, and Mention never sees them. */ job.applicationMode ===
                          'mention'
                          ? LButton(
                              LText(
                                t('jobs.mine.viewApplications', {
                                  defaultValue: 'View applications',
                                }),
                              ),
                            )
                              .style('subtle')
                              .tint('neutral')
                              .size('sm')
                              .onPress(() => router.push(`/jobs/${job.id}/applications`))
                          : null,
                      )
                        .wrap()
                        .spacing('sm')
                        .justify('end'),
                    )
                      .padding('horizontal', 'lg')
                      .padding('bottom', 'md')
                      .padding('top', 'xs')
                      .align('center')
                      .justify('between'),
                  )
                    .outline('thin')
                    .elevation('none')
                    .radius('lg'),
                  job.id,
                );
              }),
            ),
          )
            .padding('horizontal', 'lg')
            .spacing('md')
            .margin('top', 'sm'),
        )
      ),
    ),
  )
    .contentView((v) => v.padding('bottom', '4xl'))
    .header(Embed(header));
});
