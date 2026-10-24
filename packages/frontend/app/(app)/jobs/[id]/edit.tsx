import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import type { UpdateMentionJobRequest } from '@mention/shared-types';
import { jobsService, getJobErrorMessage } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { JobFormFields, useJobForm } from '@/components/Jobs/JobFormFields';
import { jobLocationInputFrom } from '@/components/Jobs/JobLocationField';

/**
 * Edit an existing Mention job listing. Same fields as `jobs/create.tsx`
 * minus the employer picker — the employer is immutable after creation
 * (`UpdateMentionJobRequest` omits `employerOxyUserId`). Status transitions
 * (publish/pause/close/duplicate) live on the dashboard (`jobs/mine.tsx`),
 * not here.
 */
export default function EditJobScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = String(id);
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();

  const jobQuery = useQuery({
    queryKey: viewerQueryKeys.jobDetail(user?.id, jobId),
    queryFn: () => jobsService.get(jobId),
    enabled: Boolean(jobId),
  });

  // Employer-only aggregate view/apply counters for this one job — privacy-safe,
  // never a named-viewer trail (see MentionJobMetricsSummary).
  const metricsQuery = useQuery({
    queryKey: viewerQueryKeys.jobMetrics(user?.id, jobId),
    queryFn: () => jobsService.getMetrics(jobId),
    enabled: Boolean(jobId) && canUsePrivateApi,
  });
  const metrics = metricsQuery.data?.metrics;

  const form = useJobForm();
  const { hydrate } = form;
  const [hydrated, setHydrated] = useState(false);

  // Prefill once, when the job loads. A ref-free one-shot guard (`hydrated`)
  // rather than syncing on every refetch: a background refetch mid-edit must
  // not stomp on what the operator is actively typing.
  useEffect(() => {
    const job = jobQuery.data?.job;
    if (!job || hydrated) return;
    hydrate(job);
    setHydrated(true);
  }, [jobQuery.data, hydrated, hydrate]);

  const updateMutation = useMutation({
    mutationFn: (patch: UpdateMentionJobRequest) => jobsService.update(jobId, patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobDetail(user?.id, jobId) }),
        queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobsMine(user?.id) }),
      ]);
      toast.success(t('jobs.edit.saved', { defaultValue: 'Job updated' }));
      router.replace('/jobs/mine');
    },
    onError: (error) => {
      logger.error('[jobs/edit] Failed to update job', error);
      toast.error(
        getJobErrorMessage(
          error,
          t('jobs.edit.failed', { defaultValue: 'Could not save these changes' }),
        ),
      );
    },
  });

  const save = () => {
    if (!form.isComplete) return;

    // The wire contract (see `~/Oxy/Mention/.../job.ts` `UpdateMentionJobRequest`
    // background) lets an explicit `null` CLEAR a field — distinct from omitting
    // it, which leaves the stored value untouched. `Partial<...>` only types the
    // "send what changed" (`undefined`) half of that contract, so a field the
    // operator has actually cleared is cast through at the call site rather than
    // silently left unclearable.
    const patch = {
      title: form.title.trim(),
      description: form.description.trim(),
      location: jobLocationInputFrom(form.location) ?? null,
      workplaceType: form.workplaceType || null,
      employmentType: form.employmentType || null,
      salary: form.salary ?? null,
      skills: form.skills,
      applicationMode: form.applicationMode,
      externalApplyUrl:
        form.applicationMode === 'external' ? form.externalApplyUrl.trim() || null : null,
    } as UpdateMentionJobRequest;

    updateMutation.mutate(patch);
  };

  const canSave = form.isComplete && form.isApplyReady;

  const header = (
    <PageHeader
      title={t('jobs.edit.title', { defaultValue: 'Edit job' })}
      backLabel={t('common.back', { defaultValue: 'Back' })}
    />
  );

  if (jobQuery.isLoading || !hydrated) {
    return (
      <Screen header={header}>
        <ScreenScrollView>
          <FormSkeleton />
        </ScreenScrollView>
      </Screen>
    );
  }

  if (jobQuery.isError || !jobQuery.data) {
    return (
      <Screen header={header}>
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Text className="text-muted-foreground text-base text-center">
            {t('jobs.edit.loadFailed', { defaultValue: 'Could not load this job' })}
          </Text>
          <Button appearance="subtle" tone="neutral" size="sm" onPress={() => jobQuery.refetch()}>
            {t('common.tryAgain', { defaultValue: 'Try again' })}
          </Button>
        </View>
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <ScreenScrollView
        contentContainerClassName="px-4 pb-16 pt-2"
        keyboardShouldPersistTaps="handled"
      >
        {metrics ? (
          <View className="flex-row flex-wrap gap-4 mb-4 p-3 bg-muted rounded-[12px]">
            <View>
              <Text className="text-foreground text-[18px] font-bold">{metrics.views}</Text>
              <Text className="text-muted-foreground text-[11px]">
                {t('jobs.edit.metricsViews', { defaultValue: 'Views' })}
              </Text>
            </View>
            <View>
              <Text className="text-foreground text-[18px] font-bold">{metrics.applyStarts}</Text>
              <Text className="text-muted-foreground text-[11px]">
                {t('jobs.edit.metricsApplyStarts', { defaultValue: 'Apply starts' })}
              </Text>
            </View>
            <View>
              <Text className="text-foreground text-[18px] font-bold">
                {metrics.externalApplyClicks}
              </Text>
              <Text className="text-muted-foreground text-[11px]">
                {t('jobs.edit.metricsExternalClicks', { defaultValue: 'External clicks' })}
              </Text>
            </View>
            <View>
              <Text className="text-foreground text-[18px] font-bold">
                {metrics.completedApplications}
              </Text>
              <Text className="text-muted-foreground text-[11px]">
                {t('jobs.edit.metricsCompleted', { defaultValue: 'Completed applications' })}
              </Text>
            </View>
          </View>
        ) : null}
        <JobFormFields form={form} />

        <View className="mt-6">
          <Button
            appearance="solid"
            tone="accent"
            size="lg"
            loading={updateMutation.isPending}
            disabled={!canSave || updateMutation.isPending}
            onPress={save}
          >
            {t('jobs.edit.save', { defaultValue: 'Save changes' })}
          </Button>
        </View>
      </ScreenScrollView>
    </Screen>
  );
}
