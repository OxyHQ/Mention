import type { Href } from 'expo-router';
import React, { memo, useCallback } from 'react';
import { Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { Card } from '@oxy.so/bloom/card';
import { Text as BloomText } from '@oxy.so/bloom/typography';
import type { MentionJobPosting, MentionJobStatus } from '@mention/shared-types';
import { formatTimeAgo } from '@/utils/dateUtils';
import { useJobVocabulary } from '@/utils/jobVocabulary';

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

const STATUS_TONE: Record<MentionJobStatus, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
  draft: 'default',
  published: 'success',
  paused: 'warning',
  closed: 'error',
  expired: 'error',
};

function formatSalary(salary: MentionJobPosting['salary']): string | null {
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

interface OrganizationJobRowProps {
  job: MentionJobPosting;
}

/**
 * One row of a profile's Jobs tab (OxyHQ/Mention#952) — the organization or
 * project account's OWN listings, read via
 * `jobsService.getOrganizationJobs(employerOxyUserId)`. That endpoint returns
 * full `MentionJobPosting` objects (richer than the denormalized
 * `PostJobContent` `components/Post/JobCard.tsx` renders for a post
 * attachment), so this is a dedicated row reading `MentionJobPosting` fields
 * directly rather than forcing the shape through `JobCard`.
 *
 * A non-operator visitor only ever receives `published` jobs here (enforced
 * server-side in `jobs.controller.ts#getOrganizationJobs`), so the status
 * badge below is mostly seen by the operator viewing their own tab.
 */
const OrganizationJobRow = memo(function OrganizationJobRow({ job }: OrganizationJobRowProps) {
  const { t } = useTranslation();
  const vocabulary = useJobVocabulary();

  const open = useCallback(() => {
    try {
      const path = new URL(job.canonicalUrl).pathname;
      router.push((path || `/jobs/${job.id}`) as Href);
    } catch {
      router.push(`/jobs/${job.id}`);
    }
  }, [job.canonicalUrl, job.id]);

  const isPublished = job.status === 'published';
  const badges = [
    job.location ? vocabulary.formatJobLocation(job.location) : undefined,
    job.workplaceType ? WORKPLACE_LABELS[job.workplaceType] : undefined,
    job.employmentType ? EMPLOYMENT_LABELS[job.employmentType] : undefined,
  ].filter((value): value is string => Boolean(value));
  const salaryLabel = formatSalary(job.salary);
  const dateLabel = job.publishedAt
    ? t('jobs.mine.publishedAgo', { defaultValue: 'Published {{time}}', time: formatTimeAgo(job.publishedAt) })
    : t('jobs.mine.createdAgo', { defaultValue: 'Created {{time}}', time: formatTimeAgo(job.createdAt) });

  return (
    <Card
      variant="outlined"
      radius="radius-16"
      onPress={open}
      className="p-4"
      accessibilityRole="button"
      accessibilityLabel={job.title}
    >
      <View className="flex-row items-start justify-between gap-2">
        <BloomText variant="headline-bold" style={{ flex: 1 }} numberOfLines={2}>
          {job.title}
        </BloomText>
        {!isPublished ? (
          <Badge content={job.status} color={STATUS_TONE[job.status]} variant="subtle" size="small" />
        ) : null}
      </View>

      {badges.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5 mt-2">
          {badges.map((label) => (
            <Badge key={label} content={label} color="default" variant="outlined" size="small" />
          ))}
        </View>
      ) : null}

      {salaryLabel ? (
        <BloomText variant="body-semibold" style={{ marginTop: 8 }}>{salaryLabel}</BloomText>
      ) : null}

      <Text className="text-muted-foreground text-xs mt-2">{dateLabel}</Text>
    </Card>
  );
});

export default OrganizationJobRow;
