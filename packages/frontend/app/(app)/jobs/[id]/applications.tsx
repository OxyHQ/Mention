import React, { useCallback, useContext, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FlashList } from '@shopify/flash-list';
import { Badge } from '@oxy.so/bloom/badge';
import { Chip } from '@oxy.so/bloom/chip';
import { Loading } from '@oxy.so/bloom/loading';
import { useAuth } from '@oxy.so/services/ui/client';
import {
  MENTION_JOB_APPLICATION_STATUSES,
  type MentionJobApplication,
  type MentionJobApplicationStatus,
} from '@mention/shared-types';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Error as ErrorState } from '@/components/Error';
import { useSafeBack } from '@/hooks/useSafeBack';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { jobApplicationsService, isJobForbiddenError } from '@/services/jobApplicationsService';
import JobApplicationDetailSheet from '@/components/Jobs/JobApplicationDetailSheet';

const STATUS_TONE: Record<MentionJobApplicationStatus, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
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
  const { user } = useAuth();
  const safeBack = useSafeBack();
  const bottomSheet = useContext(BottomSheetContext);
  const queryClient = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const applicationsQuery = useInfiniteQuery({
    queryKey: viewerQueryKeys.jobApplications(user?.id, jobId, statusFilter === 'all' ? undefined : statusFilter),
    queryFn: ({ pageParam }) =>
      jobApplicationsService.listForEmployer(jobId, {
        status: statusFilter === 'all' ? undefined : statusFilter,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor : undefined),
    enabled: Boolean(jobId),
  });

  const applications = useMemo(
    () => applicationsQuery.data?.pages.flatMap((page) => page.applications) ?? [],
    [applicationsQuery.data],
  );

  const forbidden = isJobForbiddenError(applicationsQuery.error);

  // The updated row itself is not read here — every status-filtered view of
  // this job's applications is simply invalidated, since a status change can
  // move the row between buckets (e.g. out of the tab currently open).
  const handleStatusChanged = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobApplicationsRoot(user?.id, jobId) });
    bottomSheet.openBottomSheet(false);
  }, [queryClient, user?.id, jobId, bottomSheet]);

  const openApplication = useCallback(
    (application: MentionJobApplication) => {
      bottomSheet.setBottomSheetContent(
        <JobApplicationDetailSheet jobId={jobId} application={application} onStatusChanged={handleStatusChanged} />,
      );
      bottomSheet.openBottomSheet(true);
    },
    [bottomSheet, jobId, handleStatusChanged],
  );

  const handleEndReached = useCallback(() => {
    if (applicationsQuery.hasNextPage && !applicationsQuery.isFetchingNextPage) {
      void applicationsQuery.fetchNextPage();
    }
  }, [applicationsQuery]);

  const header = (
    <Header
      options={{
        title: t('jobs.applications.title', { defaultValue: 'Applications' }),
        leftComponents: [
          <IconButton key="back" variant="icon" onPress={safeBack}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  const filterRow = (
    <View className="flex-row flex-wrap gap-2 px-4 pt-2 pb-3">
      <Chip selected={statusFilter === 'all'} onPress={() => setStatusFilter('all')}>
        {t('jobs.applications.all', { defaultValue: 'All' })}
      </Chip>
      {MENTION_JOB_APPLICATION_STATUSES.map((status) => (
        <Chip key={status} selected={statusFilter === status} onPress={() => setStatusFilter(status)}>
          {status}
        </Chip>
      ))}
    </View>
  );

  if (forbidden) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-muted-foreground text-base text-center">
            {t('jobs.applications.forbidden', { defaultValue: 'Only this job\'s operators can view applications' })}
          </Text>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      {filterRow}
      <View className="flex-1 min-h-0">
        {applicationsQuery.isPending ? (
          <View className="flex-1 items-center justify-center">
            <Loading className="text-primary" size="large" />
          </View>
        ) : applicationsQuery.isError ? (
          <ErrorState
            title={t('jobs.applications.errorTitle', { defaultValue: 'Could not load applications' })}
            onRetry={() => void applicationsQuery.refetch()}
            hideBackButton
          />
        ) : applications.length === 0 ? (
          <View className="flex-1 items-center justify-center px-8 gap-2">
            <Text className="text-foreground text-base font-semibold text-center">
              {t('jobs.applications.emptyTitle', { defaultValue: 'No applications yet' })}
            </Text>
          </View>
        ) : (
          <FlashList
            data={applications}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <View className="mx-4 mb-3 border border-border bg-background rounded-[14px] p-4">
                <View className="flex-row items-start justify-between gap-2">
                  <Text
                    className="flex-1 text-foreground text-[15px] font-semibold"
                    numberOfLines={1}
                    onPress={() => openApplication(item)}
                  >
                    {item.displayName || t('jobs.applications.unnamed', { defaultValue: 'Applicant' })}
                  </Text>
                  <Badge content={item.status} color={STATUS_TONE[item.status]} variant="subtle" size="small" />
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
              </View>
            )}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              applicationsQuery.isFetchingNextPage ? (
                <View className="items-center justify-center py-4">
                  <Loading className="text-primary" size="small" />
                </View>
              ) : null
            }
          />
        )}
      </View>
    </ThemedView>
  );
}
