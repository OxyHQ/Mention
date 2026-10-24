import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from '@/lib/navigation/router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { Card } from '@oxy.so/bloom/card';
import { Chip } from '@oxy.so/bloom/chip';
import { VirtualList } from '@oxy.so/bloom/list';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { useAuth } from '@oxy.so/services/ui/client';
import type { MentionJobApplication, MentionJobApplicationStatus } from '@mention/shared-types';
import { MENTION_JOB_APPLICATION_STATUSES } from '@mention/shared-types/job';
import { Error as ErrorState } from '@/components/Error';
import { presentSheet } from '@/utils/sheet';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { jobApplicationsService, isJobForbiddenError } from '@/services/jobApplicationsService';
import JobApplicationDetailSheet from '@/components/Jobs/JobApplicationDetailSheet';
import { EmptyState } from '@/components/common/EmptyState';

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
export default function JobApplicationsScreen() {
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
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
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

  const filterRow = (
    <View className="flex-row flex-wrap gap-2 pt-2 pb-1">
      <Chip selected={statusFilter === 'all'} onPress={() => setStatusFilter('all')}>
        {t('jobs.applications.all', { defaultValue: 'All' })}
      </Chip>
      {MENTION_JOB_APPLICATION_STATUSES.map((status) => (
        <Chip
          key={status}
          selected={statusFilter === status}
          onPress={() => setStatusFilter(status)}
        >
          {status}
        </Chip>
      ))}
    </View>
  );

  // One list in every state, so Bloom pads each of them clear of the header and
  // the bottom bar.
  const renderEmpty = () => {
    if (forbidden) {
      return (
        <View className="items-center justify-center px-8 py-16">
          <Text className="text-muted-foreground text-base text-center">
            {t('jobs.applications.forbidden', {
              defaultValue: "Only this job's operators can view applications",
            })}
          </Text>
        </View>
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

  return (
    <Screen
      header={
        <PageHeader
          title={t('jobs.applications.title', { defaultValue: 'Applications' })}
          backLabel={t('common.back', { defaultValue: 'Back' })}
          accessory={forbidden ? undefined : filterRow}
        />
      }
    >
      <VirtualList
        screen={{}}
        data={forbidden ? [] : applications}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Card
            border="thin"
            elevation="none"
            radius="radius-16"
            style={{ marginHorizontal: 16, marginBottom: 12, padding: 16 }}
          >
            <View className="flex-row items-start justify-between gap-2">
              <Text
                className="flex-1 text-foreground text-[15px] font-semibold"
                numberOfLines={1}
                onPress={() => openApplication(item)}
              >
                {item.displayName || t('jobs.applications.unnamed', { defaultValue: 'Applicant' })}
              </Text>
              <Badge
                content={item.status}
                color={STATUS_TONE[item.status]}
                variant="subtle"
                size="sm"
              />
            </View>
            {item.contactMethod ? (
              <Text className="text-muted-foreground text-[13px] mt-0.5" numberOfLines={1}>
                {item.contactMethod}
              </Text>
            ) : null}
            {item.coverNote ? (
              <Text className="text-foreground text-[13px] mt-2" numberOfLines={2}>
                {item.coverNote}
              </Text>
            ) : null}
            <Text
              className="text-primary text-[13px] font-semibold mt-2"
              onPress={() => openApplication(item)}
            >
              {t('jobs.applications.viewDetails', { defaultValue: 'View details' })}
            </Text>
          </Card>
        )}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={renderEmpty()}
        ListFooterComponent={
          <View className="items-center justify-center py-4">
            {isFetchingNextPage ? <ListSkeleton count={2} /> : null}
          </View>
        }
      />
    </Screen>
  );
}
