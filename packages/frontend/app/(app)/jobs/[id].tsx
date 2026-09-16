import React, { useCallback } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { Loading } from '@oxy.so/bloom/loading';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle, type User } from '@oxy.so/core';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import type { MentionJobStatus } from '@mention/shared-types';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { displayNameOrHandle } from '@/utils/displayName';
import { openExternalLink } from '@/utils/openExternalLink';
import { shareLink } from '@/utils/shareLink';
import { jobsService } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

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
export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const idOrSlug = String(id);
  const { t } = useTranslation();
  const { user, oxyServices } = useAuth();
  const safeBack = useSafeBack();

  const jobQuery = useQuery({
    queryKey: viewerQueryKeys.jobDetail(user?.id, idOrSlug),
    queryFn: () => jobsService.get(idOrSlug),
    enabled: Boolean(idOrSlug),
  });

  const job = jobQuery.data?.job;

  const employerQuery = useQuery<User>({
    queryKey: ['mention-jobs', 'employer', job?.employerOxyUserId],
    queryFn: () => oxyServices.getUserById(job!.employerOxyUserId),
    enabled: Boolean(job?.employerOxyUserId),
  });

  const openEmployer = useCallback(() => {
    const handle = employerQuery.data ? getNormalizedUserHandle(employerQuery.data) : null;
    if (handle) router.push(`/@${handle}`);
  }, [employerQuery.data]);

  const applyExternally = useCallback(() => {
    if (job?.externalApplyUrl) void openExternalLink(job.externalApplyUrl);
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

  const header = (
    <Header
      options={{
        title: t('jobs.detail.title', { defaultValue: 'Job' }),
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

  if (jobQuery.isLoading) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  if (jobQuery.isError || !job) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Text className="text-muted-foreground text-base text-center">
            {t('jobs.detail.notFound', { defaultValue: 'This job could not be found' })}
          </Text>
        </View>
      </ThemedView>
    );
  }

  const isPublished = job.status === 'published';
  const employerName = employerQuery.data
    ? displayNameOrHandle(employerQuery.data.name?.displayName, employerQuery.data.username)
    : job.employerOxyUserId;

  const salaryLabel = formatSalary(job.salary);
  const badges = [
    job.location?.raw,
    job.workplaceType ? WORKPLACE_LABELS[job.workplaceType] : undefined,
    job.employmentType ? EMPLOYMENT_LABELS[job.employmentType] : undefined,
  ].filter((value): value is string => Boolean(value));

  return (
    <ThemedView className="flex-1">
      {header}
      <ScrollView contentContainerClassName="px-4 pb-16 pt-2">
        {!isPublished ? (
          <View className="flex-row items-center">
            <Badge content={job.status} color={STATUS_TONE[job.status]} variant="subtle" size="small" />
          </View>
        ) : null}

        <Text className="text-foreground text-2xl font-bold mt-2">{job.title}</Text>

        <View className="flex-row items-center gap-2 mt-2">
          <Avatar source={employerQuery.data?.avatar} size={28} variant={MEDIA_VARIANT_AVATAR} />
          <Text className="text-primary text-[15px] font-semibold" onPress={openEmployer}>
            {employerName}
          </Text>
        </View>

        {badges.length > 0 ? (
          <View className="flex-row flex-wrap gap-2 mt-3">
            {badges.map((label) => (
              <Badge key={label} content={label} color="default" variant="outlined" size="small" />
            ))}
          </View>
        ) : null}

        {salaryLabel ? (
          <Text className="text-foreground text-base font-semibold mt-3">{salaryLabel}</Text>
        ) : null}

        <Text className="text-foreground text-[15px] leading-6 mt-4">{job.description}</Text>

        {job.skills.length > 0 ? (
          <View className="mt-4">
            <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
              {t('jobs.detail.skills', { defaultValue: 'Skills' })}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {job.skills.map((skill) => (
                <Chip key={skill}>{skill}</Chip>
              ))}
            </View>
          </View>
        ) : null}

        <View className="flex-row gap-3 mt-6">
          {job.applicationMode === 'external' ? (
            <Button variant="primary" size="large" style={{ flex: 1 }} onPress={applyExternally} disabled={!job.externalApplyUrl}>
              {t('jobs.detail.apply', { defaultValue: 'Apply' })}
            </Button>
          ) : (
            // The Mention-native application flow is a later phase (issue
            // #952 "Applications") another agent may build — this screen
            // must not crash on it, so it shows a disabled "coming soon"
            // state instead of a working submit.
            <Button variant="secondary" size="large" style={{ flex: 1 }} disabled>
              {t('jobs.detail.applyComingSoon', { defaultValue: 'Apply on Mention — coming soon' })}
            </Button>
          )}
          <Button variant="secondary" size="large" onPress={share}>
            {t('jobs.detail.share', { defaultValue: 'Share' })}
          </Button>
        </View>
      </ScrollView>
    </ThemedView>
  );
}
