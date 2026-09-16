import React, { memo, useCallback, useState } from 'react';
import { Pressable, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Badge } from '@oxy.so/bloom/badge';
import { Item } from '@oxy.so/bloom/item';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import type { JobEmploymentType, JobReportReason, JobSearchResult, JobWorkplaceType } from '@clarity.surf/sdk';
import { logger } from '@oxy.so/core/logger';
import { WEB_BASE_URL } from '@/config';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import { openExternalLink } from '@/utils/openExternalLink';
import { shareLink } from '@/utils/shareLink';
import { formatTimeAgo } from '@/utils/dateUtils';
import { jobApplicationsService } from '@/services/jobApplicationsService';

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
        toast(t('jobs.discovery.reportSubmitted', { defaultValue: 'Thanks — this listing has been reported' }), { type: 'success' });
      } catch (error) {
        logger.warn('Failed to report external job', { error, clarityJobId });
        toast(t('jobs.discovery.reportFailed', { defaultValue: 'Could not submit this report' }), { type: 'error' });
      } finally {
        setSubmitting(null);
        onClose();
      }
    },
    [clarityJobId, onClose, t],
  );

  return (
    <View className="bg-background px-4 pt-3 pb-6">
      <Text className="text-foreground text-lg font-bold mb-1">
        {t('jobs.discovery.reportTitle', { defaultValue: 'Report this listing' })}
      </Text>
      <Text className="text-muted-foreground text-sm mb-3">
        {t('jobs.discovery.reportSubtitle', {
          defaultValue: 'This job is indexed from another site. Your report goes to its source, via Clarity.',
        })}
      </Text>
      {EXTERNAL_REPORT_REASONS.map((reason) => (
        <Item
          key={reason}
          title={REPORT_REASON_LABELS[reason]}
          onPress={() => void submit(reason)}
          trailing={submitting === reason ? <Ionicons name="hourglass-outline" size={16} /> : undefined}
        />
      ))}
    </View>
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
  const { t } = useTranslation();
  const theme = useTheme();

  const isFirstParty = job.source.type === 'first_party';
  const appPath = isFirstParty ? mentionAppPath(job.source.canonicalUrl || job.canonicalUrl) : null;

  const open = useCallback(() => {
    if (appPath) {
      router.push(appPath);
      return;
    }
    void openExternalLink(job.source.applyUrl || job.applyUrl || job.source.canonicalUrl || job.canonicalUrl);
  }, [appPath, job]);

  const share = useCallback(() => {
    void shareLink({
      title: job.title,
      url: appPath ? job.source.canonicalUrl || job.canonicalUrl : job.canonicalUrl,
      copiedToast: t('jobs.detail.linkCopied', { defaultValue: 'Link copied' }),
      errorToast: t('jobs.detail.shareFailed', { defaultValue: 'Could not share this job' }),
    });
  }, [appPath, job, t]);

  const locationLabel = job.locations[0]?.raw;
  const badges = [
    locationLabel,
    job.workplaceType ? WORKPLACE_LABELS[job.workplaceType] : undefined,
    ...job.employmentTypes.map((type) => EMPLOYMENT_LABELS[type]),
  ].filter((value): value is string => Boolean(value));

  const salaryLabel = formatSalary(job.salary);
  const postedLabel = job.publishedAt ? formatTimeAgo(job.publishedAt) : null;

  return (
    <Pressable
      onPress={open}
      className="mx-4 mb-3 border border-border bg-background rounded-[14px] p-4"
      accessibilityRole="button"
      accessibilityLabel={job.title}
    >
      <View className="flex-row items-start justify-between gap-2">
        <View className="flex-1">
          <Text className="text-foreground text-[16px] font-bold" numberOfLines={2}>
            {job.title}
          </Text>
          <Text className="text-muted-foreground text-[13px] mt-0.5" numberOfLines={1}>
            {job.employer.name}
          </Text>
        </View>
        <TouchableOpacity
          onPress={() => onToggleSave(job)}
          hitSlop={HIT_SLOP_MD}
          accessibilityRole="button"
          accessibilityLabel={
            isSaved
              ? t('jobs.discovery.unsave', { defaultValue: 'Remove from saved' })
              : t('jobs.discovery.save', { defaultValue: 'Save job' })
          }
        >
          <Ionicons
            name={isSaved ? 'bookmark' : 'bookmark-outline'}
            size={20}
            color={isSaved ? theme.colors.primary : theme.colors.textSecondary}
          />
        </TouchableOpacity>
      </View>

      {badges.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5 mt-2.5">
          {badges.map((label, index) => (
            <Badge key={`${label}-${index}`} content={label} color="default" variant="outlined" size="small" />
          ))}
        </View>
      ) : null}

      {salaryLabel ? (
        <Text className="text-foreground text-[14px] font-semibold mt-2">{salaryLabel}</Text>
      ) : null}

      {job.snippet ? (
        <Text className="text-muted-foreground text-[13px] mt-2" numberOfLines={2}>
          {job.snippet}
        </Text>
      ) : null}

      {/* Clear source/canonical attribution — never presented as a Mention
          listing unless it genuinely resolves to one of this app's own
          routes. */}
      <View className="flex-row items-center justify-between mt-3 pt-3 border-t border-border">
        <View className="flex-1 flex-row items-center gap-1.5">
          <Ionicons
            name={appPath ? 'checkmark-circle' : 'globe-outline'}
            size={14}
            color={appPath ? theme.colors.primary : theme.colors.textTertiary}
          />
          <Text className="text-muted-foreground text-[12px]" numberOfLines={1}>
            {appPath
              ? t('jobs.discovery.onMention', { defaultValue: 'On Mention' })
              : t('jobs.discovery.viaSource', {
                  defaultValue: '{{domain}} · via Clarity',
                  domain: job.source.domain,
                })}
            {postedLabel ? ` · ${postedLabel}` : ''}
          </Text>
        </View>
        <View className="flex-row items-center gap-3">
          <TouchableOpacity onPress={share} hitSlop={HIT_SLOP_MD} accessibilityRole="button" accessibilityLabel={t('jobs.detail.share', { defaultValue: 'Share' })}>
            <Ionicons name="share-outline" size={16} color={theme.colors.textSecondary} />
          </TouchableOpacity>
          {!appPath ? (
            <TouchableOpacity
              onPress={() => onReport(job)}
              hitSlop={HIT_SLOP_MD}
              accessibilityRole="button"
              accessibilityLabel={t('jobs.discovery.report', { defaultValue: 'Report' })}
            >
              <Ionicons name="flag-outline" size={16} color={theme.colors.textSecondary} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

export default JobDiscoveryResultCard;
