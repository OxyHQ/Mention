import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { useEffect, useState } from 'react';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import type { UpdateMentionJobRequest } from '@mention/shared-types';
import { jobsService, getJobErrorMessage } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { jobLocationInputFrom, useJobForm } from '@/components/Jobs/jobForm';
import { LazyJobFormFields } from '@/components/sharedRouteScreens';

import {
  Button as LButton,
  Embed,
  HStack,
  Header,
  RawText,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/**
 * Edit an existing Mention job listing. Same fields as `jobs/create.tsx`
 * minus the employer picker — the employer is immutable after creation
 * (`UpdateMentionJobRequest` omits `employerOxyUserId`). Status transitions
 * (publish/pause/close/duplicate) live on the dashboard (`jobs/mine.tsx`),
 * not here.
 */
export default screen(function EditJobScreen() {
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

    // The wire contract (see `job.ts` in shared-types `UpdateMentionJobRequest`
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

  const header = toElement(
    Header(t('jobs.edit.title', { defaultValue: 'Edit job' }))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );

  if (jobQuery.isLoading || !hydrated) {
    return ScrollView(Embed(<FormSkeleton />)).header(Embed(header));
  }

  if (jobQuery.isError || !jobQuery.data) {
    return VStack(
      RawText(t('jobs.edit.loadFailed', { defaultValue: 'Could not load this job' }))
        .foreground('muted')
        .font('16')
        .leading('normal')
        .textAlign('center'),
      LButton(LText(t('common.tryAgain', { defaultValue: 'Try again' })))
        .style('subtle')
        .tint('neutral')
        .size('sm')
        .onPress(() => jobQuery.refetch()),
    )
      .padding('horizontal', '3xl')
      .flex('1')
      .align('center')
      .justify('center')
      .spacing('md')
      .header(Embed(header));
  }

  return ScrollView(
    metrics
      ? HStack(
          VStack(
            RawText(metrics.views).foreground('foreground').font('18').weight('bold'),
            RawText(t('jobs.edit.metricsViews', { defaultValue: 'Views' }))
              .foreground('muted')
              .font('11'),
          ),
          VStack(
            RawText(metrics.applyStarts).foreground('foreground').font('18').weight('bold'),
            RawText(t('jobs.edit.metricsApplyStarts', { defaultValue: 'Apply starts' }))
              .foreground('muted')
              .font('11'),
          ),
          VStack(
            RawText(metrics.externalApplyClicks).foreground('foreground').font('18').weight('bold'),
            RawText(t('jobs.edit.metricsExternalClicks', { defaultValue: 'External clicks' }))
              .foreground('muted')
              .font('11'),
          ),
          VStack(
            RawText(metrics.completedApplications)
              .foreground('foreground')
              .font('18')
              .weight('bold'),
            RawText(t('jobs.edit.metricsCompleted', { defaultValue: 'Completed applications' }))
              .foreground('muted')
              .font('11'),
          ),
        )
          .padding('all', 'md')
          .background('mutedFill')
          .corner('md')
          .wrap()
          .spacing('lg')
          .margin('bottom', 'lg')
      : null,
    Embed(<LazyJobFormFields form={form} />),
    VStack(
      LButton(LText(t('jobs.edit.save', { defaultValue: 'Save changes' })))
        .style('solid')
        .tint('accent')
        .size('lg')
        .loading(updateMutation.isPending)
        .disabled(!canSave || updateMutation.isPending)
        .onPress(save),
    ).margin('top', '2xl'),
  )
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '64').padding('top', 'sm'))
    .keyboardTaps('handled')
    .header(Embed(header));
});
