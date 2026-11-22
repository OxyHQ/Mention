import { tokens } from '@oxy.so/bloom/styles';
import type { Href } from '@/lib/navigation/router';
import { memo, useCallback, useState } from 'react';
import { TouchableOpacity } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { Divider } from '@oxy.so/bloom/divider';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons/RiCheckboxCircleFill';
import { RiFlagLine } from '@oxy.so/bloom/icons/RiFlagLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiLoader4Line } from '@oxy.so/bloom/icons/RiLoader4Line';
import { RiShareForwardLine } from '@oxy.so/bloom/icons/RiShareForwardLine';
import { toast } from '@oxy.so/bloom/toast';
import type {
  JobEmploymentType,
  JobReportReason,
  JobSearchResult,
  JobWorkplaceType,
} from '@mention/shared-types/job';
import { logger } from '@oxy.so/core/logger';
import { WEB_BASE_URL } from '@/config';
import { openExternalLink } from '@/utils/openExternalLink';
import { shareLink } from '@/utils/shareLink';
import { formatTimeAgo } from '@/utils/dateUtils';
import { jobApplicationsService } from '@/services/jobApplicationsService';
import { useJobVocabulary } from '@/utils/jobVocabulary';

import {
  Badge as LBadge,
  Card as LCard,
  Embed,
  HStack,
  Icon,
  RawText,
  Row,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const WORKPLACE_LABELS: Record<JobWorkplaceType, string> = {
  onsite: 'On-site',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

const EMPLOYMENT_LABELS: Record<JobEmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  temporary: 'Temporary',
  internship: 'Internship',
  volunteer: 'Volunteer',
  per_diem: 'Per diem',
  other: 'Other',
};

/**
 * Every reason Clarity's own report endpoint accepts
 * (`jobApplications.controller.ts`'s `externalJobReportSchema`, restated
 * frontend-side since the SDK ships only the `JobReportReason` TYPE, no
 * runtime array to import).
 */
const EXTERNAL_REPORT_REASONS: readonly JobReportReason[] = [
  'scam',
  'discriminatory',
  'already_filled',
  'duplicate',
  'misleading',
  'other',
];

const REPORT_REASON_LABELS: Record<JobReportReason, string> = {
  scam: 'Scam or fraud',
  discriminatory: 'Discriminatory',
  already_filled: 'Position already filled',
  duplicate: 'Duplicate listing',
  misleading: 'Misleading information',
  other: 'Other',
};

function formatSalary(salary: JobSearchResult['salary']): string | null {
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
 * A Clarity-canonical URL that is ALSO this Mention deployment's own job page
 * — `source.type === 'first_party'` on the result means Clarity indexed the
 * listing back from Mention, but the URL itself is the only reliable way to
 * tell whether THIS URL is a Mention URL: a first-party result's
 * `canonicalUrl` and its `source.canonicalUrl` are not guaranteed identical,
 * and only a URL on this app's own web origin can be turned into an in-app
 * route (`new URL(url).pathname`) instead of an external open.
 */
function mentionAppPath(canonicalUrl: string): string | null {
  try {
    const target = new URL(canonicalUrl);
    const home = new URL(WEB_BASE_URL);
    if (target.hostname !== home.hostname) return null;
    return target.pathname || '/';
  } catch {
    return null;
  }
}

interface ExternalJobReportSheetProps {
  clarityJobId: string;
  onClose: () => void;
}

/** Reason picker for reporting an EXTERNAL (Clarity-only) listing — a separate, narrower vocabulary from the generic post/user/room report categories. */
const ExternalJobReportSheet = memo(function ExternalJobReportSheet({
  clarityJobId,
  onClose,
}: ExternalJobReportSheetProps) {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState<JobReportReason | null>(null);

  const submit = useCallback(
    async (reason: JobReportReason) => {
      setSubmitting(reason);
      try {
        await jobApplicationsService.reportExternalJob(clarityJobId, reason);
        toast(
          t('jobs.discovery.reportSubmitted', {
            defaultValue: 'Thanks — this listing has been reported',
          }),
          { type: 'success' },
        );
      } catch (error) {
        logger.warn('Failed to report external job', { error, clarityJobId });
        toast(t('jobs.discovery.reportFailed', { defaultValue: 'Could not submit this report' }), {
          type: 'error',
        });
      } finally {
        setSubmitting(null);
        onClose();
      }
    },
    [clarityJobId, onClose, t],
  );

  return toElement(
    VStack(
      RawText(t('jobs.discovery.reportTitle', { defaultValue: 'Report this listing' }))
        .foreground('foreground')
        .font('18')
        .leading('28px')
        .weight('bold')
        .margin('bottom', 'xs'),
      RawText(
        t('jobs.discovery.reportSubtitle', {
          defaultValue:
            'This job is indexed from another site. Your report goes to its source, via Clarity.',
        }),
      )
        .foreground('muted')
        .font('14')
        .leading('20px')
        .margin('bottom', 'md'),
      Embed(
        EXTERNAL_REPORT_REASONS.map((reason) =>
          toElement(
            Row(REPORT_REASON_LABELS[reason])
              .onPress(() => void submit(reason))
              .trailing(
                Embed(
                  submitting === reason
                    ? toElement(Icon(RiLoader4Line).size('sm').foreground('muted'))
                    : undefined,
                ),
              ),
            reason,
          ),
        ),
      ),
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', '2xl')
      .background('background'),
  );
});

export { ExternalJobReportSheet };

interface JobDiscoveryResultCardProps {
  job: JobSearchResult;
  isSaved: boolean;
  onToggleSave: (job: JobSearchResult) => void;
  onReport: (job: JobSearchResult) => void;
}

/**
 * One row of the global job discovery feed (`app/(app)/jobs/index.tsx`) — a
 * raw Clarity `JobSearchResult`, NOT the denormalized `PostJobContent`
 * `components/Post/JobCard.tsx` renders for a post attachment. Every result
 * keeps clear source/canonical attribution (issue #952) — the employer's own
 * domain, and "via Clarity" for anything not first-party — rather than
 * presenting an external listing as if Mention owned it.
 */
const JobDiscoveryResultCard = memo(function JobDiscoveryResultCard({
  job,
  isSaved,
  onToggleSave,
  onReport,
}: JobDiscoveryResultCardProps) {
  const router = useRouter();
  const { t } = useTranslation();
  const vocabulary = useJobVocabulary();

  const isFirstParty = job.source.type === 'first_party';
  const appPath = isFirstParty ? mentionAppPath(job.source.canonicalUrl || job.canonicalUrl) : null;

  const open = useCallback(() => {
    if (appPath) {
      router.push(appPath as Href);
      return;
    }
    void openExternalLink(
      job.source.applyUrl || job.applyUrl || job.source.canonicalUrl || job.canonicalUrl,
    );
  }, [appPath, job, router]);

  const share = useCallback(() => {
    void shareLink({
      title: job.title,
      url: appPath ? job.source.canonicalUrl || job.canonicalUrl : job.canonicalUrl,
      copiedToast: t('jobs.detail.linkCopied', { defaultValue: 'Link copied' }),
      errorToast: t('jobs.detail.shareFailed', { defaultValue: 'Could not share this job' }),
    });
  }, [appPath, job, t]);

  const locationLabel = vocabulary.formatClarityJobLocation(job.locations[0]);
  const badges = [
    locationLabel,
    job.workplaceType ? WORKPLACE_LABELS[job.workplaceType] : undefined,
    ...job.employmentTypes.map((type) => EMPLOYMENT_LABELS[type]),
  ].filter((value): value is string => Boolean(value));

  const salaryLabel = formatSalary(job.salary);
  const postedLabel = job.publishedAt ? formatTimeAgo(job.publishedAt) : null;

  return toElement(
    LCard(
      HStack(
        VStack(
          LText(job.title).font('headline').weight('bold').lines(2),
          LText(job.employer.name).margin('top', '2xs').foreground('muted').font('body-2').lines(1),
        ).flex('1'),
        Embed(
          <TouchableOpacity
            onPress={() => onToggleSave(job)}
            hitSlop={tokens.hitSlop.md}
            accessibilityRole="button"
            accessibilityLabel={
              isSaved
                ? t('jobs.discovery.unsave', { defaultValue: 'Remove from saved' })
                : t('jobs.discovery.save', { defaultValue: 'Save job' })
            }
          >
            {isSaved
              ? toElement(Icon(RiBookmarkFill).size('md').foreground('primary'))
              : toElement(Icon(RiBookmarkLine).size('md').foreground('muted'))}
          </TouchableOpacity>,
        ),
      )
        .align('start')
        .justify('between')
        .spacing('sm'),
      badges.length > 0
        ? HStack(
            badges.map((label, index) =>
              LBadge(label).color('default').style('outlined').size('sm').id(`${label}-${index}`),
            ),
          )
            .wrap()
            .spacing('6')
            .margin('top', '10')
        : null,
      salaryLabel ? LText(salaryLabel).margin('top', 'sm').font('body').weight('semibold') : null,
      job.snippet
        ? LText(job.snippet).margin('top', 'sm').foreground('muted').font('body-2').lines(2)
        : null,
      // Clear source/canonical attribution — never presented as a Mention
      // listing unless it genuinely resolves to one of this app's own routes.
      Embed(<Divider style={{ marginTop: 12 }} />),
      HStack(
        HStack(
          appPath
            ? Icon(RiCheckboxCircleFill).size('14').foreground('primary')
            : Icon(RiGlobalLine).size('14').foreground('textTertiary'),
          LText(
            appPath
              ? t('jobs.discovery.onMention', { defaultValue: 'On Mention' })
              : t('jobs.discovery.viaSource', {
                  defaultValue: '{{domain}} · via Clarity',
                  domain: job.source.domain,
                }),
            postedLabel ? ` · ${postedLabel}` : '',
          )
            .shrink('normal')
            .foreground('muted')
            .font('caption-1')
            .lines(1),
        )
          .flex('1')
          .align('center')
          .spacing('6'),
        HStack(
          Embed(
            <TouchableOpacity
              onPress={share}
              hitSlop={tokens.hitSlop.md}
              accessibilityRole="button"
              accessibilityLabel={t('jobs.detail.share', { defaultValue: 'Share' })}
            >
              {toElement(Icon(RiShareForwardLine).size('sm').foreground('muted'))}
            </TouchableOpacity>,
          ),
          Embed(
            !appPath ? (
              <TouchableOpacity
                onPress={() => onReport(job)}
                hitSlop={tokens.hitSlop.md}
                accessibilityRole="button"
                accessibilityLabel={t('jobs.discovery.report', { defaultValue: 'Report' })}
              >
                {toElement(Icon(RiFlagLine).size('sm').foreground('muted'))}
              </TouchableOpacity>
            ) : null,
          ),
        )
          .align('center')
          .spacing('md'),
      )
        .padding('top', 'md')
        .align('center')
        .justify('between'),
    )
      .style('outline')
      .radius('lg')
      .padding('lg')
      .margin('horizontal', 'lg')
      .margin('bottom', 'md')
      .onPress(open)
      .role('button')
      .label(job.title),
  );
});

export default JobDiscoveryResultCard;
