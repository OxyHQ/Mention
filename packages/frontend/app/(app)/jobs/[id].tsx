import { tokens } from '@oxy.so/bloom/styles';
import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import { Suspense, lazy, useCallback, useEffect, useRef } from 'react';
import { TouchableOpacity, type ViewStyle } from 'react-native';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle, type User } from '@oxy.so/core';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import type { MentionJobStatus } from '@mention/shared-types';
import { displayNameOrHandle } from '@/utils/displayName';
import { openExternalLink } from '@/utils/openExternalLink';
import { shareLink } from '@/utils/shareLink';
import { jobsService, recordJobMetric } from '@/services/jobsService';
import { reportService } from '@/services/reportService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { presentSheet } from '@/utils/sheet';
import { useJobVocabulary } from '@/utils/jobVocabulary';

import {
  Badge as LBadge,
  Button as LButton,
  Chip as LChip,
  Embed,
  HStack,
  Header,
  RawText,
  ScrollView,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

/** The report link sits centred, 16pt under the actions (`mt-4 self-center`). */
const REPORT_STYLE: ViewStyle = { marginTop: 16, alignSelf: 'center' };
import { screen } from '@oxy.so/bloom-language/router';

const ReportModal = lazy(() =>
  import('@/components/report/ReportModal').then((m) => ({ default: m.ReportModal })),
);

const WORKPLACE_LABELS: Record<string, string> = {
  onsite: 'On-site',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

const EMPLOYMENT_LABELS: Record<string, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  temporary: 'Temporary',
  internship: 'Internship',
  other: 'Other',
};

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

function formatSalary(
  salary: { min?: number; max?: number; currency: string; interval: string } | undefined,
): string | null {
  if (!salary) return null;
  const amount =
    salary.min !== undefined && salary.max !== undefined
      ? `${salary.min.toLocaleString()}–${salary.max.toLocaleString()}`
      : salary.min !== undefined
        ? `${salary.min.toLocaleString()}+`
        : salary.max !== undefined
          ? `Up to ${salary.max.toLocaleString()}`
          : null;
  if (!amount) return null;
  return `${salary.currency} ${amount} / ${salary.interval}`;
}

/**
 * The canonical public job page (`GET /jobs/:id`, id or slug). Accessible to
 * anyone — the backend gates what a non-operator may see, this screen just
 * renders what it gets back.
 */
export default screen(function JobDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const idOrSlug = String(id);
  const { t } = useTranslation();
  const { user, oxyServices } = useAuth();
  const vocabulary = useJobVocabulary();

  const jobQuery = useQuery({
    queryKey: viewerQueryKeys.jobDetail(user?.id, idOrSlug),
    queryFn: () => jobsService.get(idOrSlug),
    enabled: Boolean(idOrSlug),
  });

  const job = jobQuery.data?.job;

  // One `view` per job actually shown, not per render/re-fetch — the ref
  // tracks which job id this mount has already recorded.
  const viewedJobIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!job || viewedJobIdRef.current === job.id) return;
    viewedJobIdRef.current = job.id;
    recordJobMetric(job.id, 'view');
  }, [job]);

  const employerQuery = useQuery<User>({
    queryKey: viewerQueryKeys.jobEmployerProfile(user?.id, job?.employerOxyUserId),
    queryFn: () => oxyServices.users.get(job!.employerOxyUserId),
    enabled: Boolean(job?.employerOxyUserId),
  });

  const openEmployer = useCallback(() => {
    const handle = employerQuery.data ? getNormalizedUserHandle(employerQuery.data) : null;
    if (handle) router.push(`/@${handle}`);
  }, [employerQuery.data, router]);

  const applyExternally = useCallback(() => {
    if (!job?.externalApplyUrl) return;
    recordJobMetric(job.id, 'external_apply_click');
    void openExternalLink(job.externalApplyUrl);
  }, [job]);

  const share = useCallback(() => {
    if (!job) return;
    // TODO(#952): once the composer exposes a job-attachment entry point,
    // route here instead (`/compose?attachJobId=${job.id}`) so sharing a job
    // posts it as a native Mention job attachment rather than a plain link.
    void shareLink({
      title: job.title,
      url: job.canonicalUrl,
      copiedToast: t('jobs.detail.linkCopied', { defaultValue: 'Link copied' }),
      errorToast: t('jobs.detail.shareFailed', { defaultValue: 'Could not share this job' }),
    });
  }, [job, t]);

  /**
   * This page renders only a Mention-OWNED job, so its report affordance goes
   * through the app's EXISTING generic report mechanism
   * (`reportedType: 'job'`, `reportedId: <mention job id>`) — the same
   * `ReportModal` a post/user/room already uses — rather than a new UI.
   * `jobApplicationsService.reportExternalJob` is a DIFFERENT endpoint for a
   * DIFFERENT case: a Clarity-only listing that is not this app's own
   * (`components/Jobs/JobDiscoveryResultCard.tsx`'s report action).
   */
  const openReport = useCallback(() => {
    if (!job) return;
    void presentSheet((surface) => (
      <Suspense fallback={null}>
        <ReportModal
          visible
          onClose={() => surface.dismiss()}
          onSubmit={async (categories, details) => {
            const success = await reportService.reportJob(job.id, categories, details);
            toast(
              success
                ? t('jobs.detail.reportSubmitted', {
                    defaultValue: 'Thanks — this listing has been reported',
                  })
                : t('jobs.detail.reportFailed', { defaultValue: 'Could not submit this report' }),
              { type: success ? 'success' : 'error' },
            );
          }}
        />
      </Suspense>
    ));
  }, [job, t]);

  const header = toElement(
    Header(t('jobs.detail.title', { defaultValue: 'Job' }))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );

  if (jobQuery.isLoading) {
    return ScrollView(Embed(<DetailSkeleton />)).header(Embed(header));
  }

  if (jobQuery.isError || !job) {
    return VStack(
      RawText(t('jobs.detail.notFound', { defaultValue: 'This job could not be found' }))
        .foreground('muted')
        .font('16')
        .leading('normal')
        .textAlign('center'),
    )
      .padding('horizontal', '3xl')
      .flex('1')
      .align('center')
      .justify('center')
      .spacing('md')
      .header(Embed(header));
  }

  const isPublished = job.status === 'published';
  const employerName = employerQuery.data
    ? displayNameOrHandle(employerQuery.data.name?.displayName, employerQuery.data.username)
    : job.employerOxyUserId;

  const salaryLabel = formatSalary(job.salary);
  const badges = [
    job.location ? vocabulary.formatJobLocation(job.location) : undefined,
    job.workplaceType ? WORKPLACE_LABELS[job.workplaceType] : undefined,
    job.employmentType ? EMPLOYMENT_LABELS[job.employmentType] : undefined,
  ].filter((value): value is string => Boolean(value));

  return ScrollView(
    !isPublished
      ? HStack(
          Embed(
            <Badge
              content={job.status}
              color={STATUS_TONE[job.status]}
              variant="subtle"
              size="sm"
            />,
          ),
        ).align('center')
      : null,
    RawText(job.title)
      .foreground('foreground')
      .font('24')
      .leading('32px')
      .weight('bold')
      .margin('top', 'sm'),
    HStack(
      Embed(
        <Avatar source={employerQuery.data?.avatar} size={28} variant={MEDIA_VARIANT_AVATAR} />,
      ),
      RawText(employerName)
        .foreground('primary')
        .font('md')
        .weight('semibold')
        .onPress(openEmployer),
    )
      .align('center')
      .spacing('sm')
      .margin('top', 'sm'),
    badges.length > 0
      ? HStack(
          Embed(
            badges.map((label) =>
              toElement(LBadge(label).color('default').style('outlined').size('sm'), label),
            ),
          ),
        )
          .wrap()
          .spacing('sm')
          .margin('top', 'md')
      : null,
    salaryLabel
      ? RawText(salaryLabel)
          .foreground('foreground')
          .font('16')
          .leading('normal')
          .weight('semibold')
          .margin('top', 'md')
      : null,
    RawText(job.description)
      .foreground('foreground')
      .font('md')
      .leading('24px')
      .margin('top', 'lg'),
    job.skills.length > 0
      ? VStack(
          RawText(t('jobs.detail.skills', { defaultValue: 'Skills' }))
            .font('14')
            .leading('20px')
            .foreground('muted')
            .margin('bottom', '6'),
          HStack(Embed(job.skills.map((skill) => toElement(LChip(LText(skill)), skill))))
            .wrap()
            .spacing('sm'),
        ).margin('top', 'lg')
      : null,
    HStack(
      job.applicationMode === 'external'
        ? LButton(LText(t('jobs.detail.apply', { defaultValue: 'Apply' })))
            .style('solid')
            .tint('accent')
            .size('lg')
            .grow()
            .onPress(applyExternally)
            .disabled(!job.externalApplyUrl)
        : LButton(LText(t('jobs.detail.applyOnMention', { defaultValue: 'Apply on Mention' })))
            .style('solid')
            .tint('accent')
            .size('lg')
            .grow()
            .disabled(!isPublished)
            .onPress(() => router.push(`/jobs/${job.id}/apply`)),
      LButton(LText(t('jobs.detail.share', { defaultValue: 'Share' })))
        .style('subtle')
        .tint('neutral')
        .size('lg')
        .onPress(share),
    )
      .spacing('md')
      .margin('top', '2xl'),
    Embed((render) => (
      <TouchableOpacity onPress={openReport} style={REPORT_STYLE} hitSlop={tokens.hitSlop.md}>
        {render(
          RawText(t('jobs.detail.report', { defaultValue: 'Report this listing' }))
            .foreground('muted')
            .font('xs')
            .leading('16px'),
        )}
      </TouchableOpacity>
    )),
  )
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '64').padding('top', 'sm'))
    .header(Embed(header));
});
