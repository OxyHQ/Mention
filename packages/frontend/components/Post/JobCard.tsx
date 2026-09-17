import React, { useCallback } from 'react';
import { Pressable, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { createLogger } from '@oxy.so/core/logger';
import type { PostJobContent } from '@mention/shared-types';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import { useJobVocabulary } from '@/utils/jobVocabulary';

const logger = createLogger('JobCard');

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

const STATUS_LABELS: Record<string, string> = {
  paused: 'Paused',
  closed: 'Closed',
  expired: 'Expired',
  draft: 'Draft',
};

interface JobCardProps {
  /**
   * The already-resolved job attachment, denormalized server-side at write
   * time (see `PostJobContent` in `@mention/shared-types`). Unlike
   * `PollCard`, this component never fetches the job itself — a stale or
   * adversarial client can never forge an employer name or a closed job's
   * apparent status, and there is no second round trip to render the card.
   */
  job: PostJobContent;
  width?: number;
  /** Fixed height, when the card shares an attachments row whose items all take one height. */
  height?: number;
}

/**
 * Post-attachment card for a Mention-authored job listing. Renders the
 * denormalized summary only; tapping the card opens the canonical job page
 * and tapping the employer name opens the employer's profile.
 *
 * The employer profile link is the one place this card makes its own
 * request: `PostJobContent` carries `employerOxyUserId` but no handle (posts
 * only ever navigate to a profile by `@handle` — see `app/(app)/[username]`),
 * so the handle is resolved on tap via the Oxy SDK's cached `getUserById`
 * rather than upfront for every rendered card.
 */
const JobCard: React.FC<JobCardProps> = ({ job, width = 280, height }) => {
  const { t } = useTranslation();
  const { oxyServices } = useAuth();
  const vocabulary = useJobVocabulary();

  const isPublished = job.status === 'published';
  const isNegativeStatus = job.status === 'closed' || job.status === 'expired';

  const openJob = useCallback(() => {
    // `canonicalUrl` is Mention's own absolute canonical URL for the job page
    // (e.g. `https://mention.earth/jobs/<slug>`). Navigate by its PATH so the
    // tap stays in-app instead of opening a browser tab; fall back to the id
    // route if the URL is somehow unparseable.
    try {
      const path = new URL(job.canonicalUrl).pathname;
      router.push(path || `/jobs/${job.mentionJobId}`);
    } catch {
      router.push(`/jobs/${job.mentionJobId}`);
    }
  }, [job.canonicalUrl, job.mentionJobId]);

  const openEmployer = useCallback(() => {
    void (async () => {
      try {
        const profile = await oxyServices.getUserById(job.employerOxyUserId);
        const handle = getNormalizedUserHandle(profile);
        if (handle) router.push(`/@${handle}`);
      } catch (error) {
        logger.warn('Failed to resolve employer profile for job card', { error });
      }
    })();
  }, [oxyServices, job.employerOxyUserId]);

  const metaBadges = [
    job.location ? vocabulary.formatJobLocation(job.location) : undefined,
    job.workplaceType ? WORKPLACE_LABELS[job.workplaceType] : undefined,
    job.employmentType ? EMPLOYMENT_LABELS[job.employmentType] : undefined,
  ].filter((value): value is string => Boolean(value));

  return (
    <Pressable
      onPress={openJob}
      className="border border-border bg-muted rounded-[14px] overflow-hidden p-3"
      style={{ width, height }}
      accessibilityRole="button"
      accessibilityLabel={job.title}
    >
      <View className="flex-row items-center justify-between gap-2">
        <Text className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wide">
          {t('post.job.label', { defaultValue: 'Job' })}
        </Text>
        {!isPublished ? (
          <Badge
            content={STATUS_LABELS[job.status] ?? job.status}
            color={isNegativeStatus ? 'error' : 'warning'}
            variant="subtle"
            size="small"
          />
        ) : null}
      </View>

      <Text className="text-foreground text-[15px] font-bold mt-1" numberOfLines={2}>
        {job.title}
      </Text>

      <Pressable onPress={openEmployer} hitSlop={HIT_SLOP_MD} className="self-start mt-0.5">
        <Text className="text-primary text-[13px]" numberOfLines={1}>
          {job.employerName}
        </Text>
      </Pressable>

      {metaBadges.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5 mt-2.5">
          {metaBadges.map((label) => (
            <Badge key={label} content={label} color="default" variant="outlined" size="small" />
          ))}
        </View>
      ) : null}
    </Pressable>
  );
};

export default JobCard;
