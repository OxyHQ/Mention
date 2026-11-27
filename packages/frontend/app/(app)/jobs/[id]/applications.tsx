import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback, useMemo, useState } from 'react';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import type { MentionJobApplication, MentionJobApplicationStatus } from '@mention/shared-types';
import { MENTION_JOB_APPLICATION_STATUSES } from '@mention/shared-types/job';
import { Error as ErrorState } from '@/components/Error';
import { presentSheet } from '@/utils/sheet';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getNextJobApplicationPage } from '@/lib/jobPagination';
import { jobApplicationsService, isJobForbiddenError } from '@/services/jobApplicationsService';
import JobApplicationDetailSheet from '@/components/Jobs/JobApplicationDetailSheet';
import { EmptyState } from '@/components/common/EmptyState';

import {
  Badge as LBadge,
  Embed,
  HStack,
  Header,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Card as LCard, Chip as LChip } from '@oxy.so/bloom-language/containers';
import { VirtualList } from '@oxy.so/bloom-language/list';
import { screen as Lscreen } from '@oxy.so/bloom-language/router';

const STATUS_TONE: Record<
  MentionJobApplicationStatus,
  'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'
> = {
  new: 'info',
  reviewing: 'primary',
  interview: 'warning',
  hired: 'success',
  rejected: 'error',
  withdrawn: 'default',
};

type StatusFilter = 'all' | MentionJobApplicationStatus;

/**
 * The applicant inbox for ONE job — employer-only (`GET
 * /jobs/:id/applications`, 403 for anybody else). Linked from
 * `app/(app)/jobs/mine.tsx`'s per-job actions, for jobs with
 * `applicationMode: 'mention'`.
 */
export default Lscreen(function JobApplicationsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = String(id);
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const applicationsQuery = useInfiniteQuery({
    queryKey: viewerQueryKeys.jobApplications(
      user?.id,
      jobId,
      statusFilter === 'all' ? undefined : statusFilter,
    ),
    queryFn: ({ pageParam }) =>
      jobApplicationsService.listForEmployer(jobId, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: getNextJobApplicationPage,
    // This endpoint is employer-only (401/403 otherwise) — gate on
    // `canUsePrivateApi`, not just a truthy jobId, so this doesn't fire an
    // authenticated request during the SSO-restore window before auth is
    // actually ready (docs/frontend-rules.md).
    enabled: Boolean(jobId) && canUsePrivateApi,
  });

  const applications = useMemo(
    () => applicationsQuery.data?.pages.flatMap((page) => page.applications) ?? [],
    [applicationsQuery.data],
  );

  const forbidden = isJobForbiddenError(applicationsQuery.error);

  // The updated row itself is not read here — every status-filtered view of
  // this job's applications is simply invalidated, since a status change can
  // move the row between buckets (e.g. out of the tab currently open).
  const invalidateApplications = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: viewerQueryKeys.jobApplicationsRoot(user?.id, jobId),
    });
  }, [queryClient, user?.id, jobId]);

  const openApplication = useCallback(
    (application: MentionJobApplication) => {
      void presentSheet((surface) => (
        <JobApplicationDetailSheet
          jobId={jobId}
          application={application}
          onStatusChanged={() => {
            invalidateApplications();
            surface.dismiss();
          }}
        />
      ));
    },
    [jobId, invalidateApplications],
  );

  // Bloom's VirtualList pages from `onEndReached` on both platforms. A FlashList
  // here had no bounded height on web (the document scrolls), so it kept firing
  // `onEndReached` and paged on its own.
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = applicationsQuery;
  const handleEndReached = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const filterRow = toElement(
    HStack(
      LChip(LText(t('jobs.applications.all', { defaultValue: 'All' })))
        .selected(statusFilter === 'all')
        .onPress(() => setStatusFilter('all')),
      Embed(
        MENTION_JOB_APPLICATION_STATUSES.map((status) =>
          toElement(
            LChip(LText(status))
              .selected(statusFilter === status)
              .onPress(() => setStatusFilter(status)),
            status,
          ),
        ),
      ),
    )
      .padding('top', 'sm')
      .padding('bottom', 'xs')
      .wrap()
      .spacing('sm'),
  );

  // One list in every state, so Bloom pads each of them clear of the header and
  // the bottom bar.
  const renderEmpty = () => {
    if (forbidden) {
      return toElement(
        VStack(
          RawText(
            t('jobs.applications.forbidden', {
              defaultValue: "Only this job's operators can view applications",
            }),
          )
            .foreground('muted')
            .font('16')
            .leading('normal')
            .textAlign('center'),
        )
          .padding('horizontal', '3xl')
          .padding('vertical', '64')
          .align('center')
          .justify('center'),
      );
    }
    if (applicationsQuery.isPending) return <ListSkeleton />;
    if (applicationsQuery.isError) {
      return (
        <ErrorState
          title={t('jobs.applications.errorTitle', {
            defaultValue: 'Could not load applications',
          })}
          onRetry={() => void applicationsQuery.refetch()}
          hideBackButton
        />
      );
    }
    return (
      <EmptyState
        title={t('jobs.applications.emptyTitle', { defaultValue: 'No applications yet' })}
        sticker="jobApplications"
        containerStyle={{ paddingTop: 40 }}
      />
    );
  };

  return VirtualList(forbidden ? [] : applications, ({ item }) =>
    LCard(
      HStack(
        RawText(item.displayName || t('jobs.applications.unnamed', { defaultValue: 'Applicant' }))
          .flex('1')
          .foreground('foreground')
          .font('md')
          .weight('semibold')
          .lines(1)
          .onPress(() => openApplication(item)),
        LBadge(item.status).style('subtle').color(STATUS_TONE[item.status]).size('sm'),
      )
        .align('start')
        .justify('between')
        .spacing('sm'),
      item.contactMethod
        ? RawText(item.contactMethod).foreground('muted').font('sm').margin('top', '2xs').lines(1)
        : null,
      item.coverNote
        ? RawText(item.coverNote).foreground('foreground').font('sm').margin('top', 'sm').lines(2)
        : null,
      RawText(t('jobs.applications.viewDetails', { defaultValue: 'View details' }))
        .foreground('primary')
        .font('sm')
        .weight('semibold')
        .margin('top', 'sm')
        .onPress(() => openApplication(item)),
    )
      .outline('thin')
      .elevation('none')
      .radius('lg')
      .margin('horizontal', 'lg')
      .margin('bottom', 'md')
      .padding('lg'),
  )
    .itemKey((item: MentionJobApplication) => item.id)
    .onEndReached(handleEndReached, 0.5)
    .emptyState(Embed(renderEmpty()))
    .footerContent(
      VStack(Embed(isFetchingNextPage ? <ListSkeleton count={2} /> : null))
        .padding('vertical', 'lg')
        .align('center')
        .justify('center'),
    )
    .screen()
    .header(
      Header(t('jobs.applications.title', { defaultValue: 'Applications' }))
        .backLabel(t('common.back', { defaultValue: 'Back' }))
        .accessory(Embed(forbidden ? undefined : filterRow))
        .inPage(),
    );
});
