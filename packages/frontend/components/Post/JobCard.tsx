import type { Href } from '@/lib/navigation/router';
import { useRouter } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { getNormalizedUserHandle } from '@oxy.so/core';
import { createLogger } from '@oxy.so/core/logger';
import type { PostJobContent } from '@mention/shared-types';
import { useJobVocabulary } from '@/utils/jobVocabulary';

import {
  Badge as LBadge,
  HStack,
  RawText,
  VStack,
  type ViewModifier,
  defineModifier,
  view,
} from '@oxy.so/bloom-language';

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
  /**
   * The card's frame: its full width alone in the attachments row, its width and
   * the row's height beside others; 280pt wide by default.
   */
  look?: ViewModifier;
}

/** The card's own frame: 280pt wide. */
const jobFrame = defineModifier((v) => v.frame({ width: '280' }));

/**
 * The card's two presses: the job page (by its canonical URL's path) and the
 * employer's profile (its handle resolved on tap).
 */
function useJobCardPresses(job: PostJobContent) {
  const router = useRouter();
  const { oxyServices } = useAuth();
  const openJob = () => {
    // `canonicalUrl` is Mention's own absolute canonical URL for the job page
    // (e.g. `https://mention.earth/jobs/<slug>`). Navigate by its PATH so the
    // tap stays in-app instead of opening a browser tab; fall back to the id
    // route if the URL is somehow unparseable.
    try {
      const path = new URL(job.canonicalUrl).pathname;
      router.push((path || `/jobs/${job.mentionJobId}`) as Href);
    } catch {
      router.push(`/jobs/${job.mentionJobId}`);
    }
  };

  const openEmployer = () => {
    void (async () => {
      try {
        const profile = await oxyServices.users.get(job.employerOxyUserId);
        const handle = getNormalizedUserHandle(profile);
        if (handle) router.push(`/@${handle}`);
      } catch (error) {
        logger.warn('Failed to resolve employer profile for job card', { error });
      }
    })();
  };

  return { openJob, openEmployer };
}

/**
 * Post-attachment card for a Mention-authored job listing. Renders the
 * denormalized summary only; tapping the card opens the canonical job page
 * and tapping the employer name opens the employer's profile.
 *
 * The employer profile link is the one place this card makes its own
 * request: `PostJobContent` carries `employerOxyUserId` but no handle (posts
 * only ever navigate to a profile by `@handle` — see `app/(app)/[username]`),
 * so the handle is resolved on tap via the Oxy SDK's cached `users.get`
 * rather than upfront for every rendered card.
 */
const JobCard = view(function JobCard({ job, look = jobFrame }: JobCardProps) {
  const { t } = useTranslation();
  const vocabulary = useJobVocabulary();
  const { openJob, openEmployer } = useJobCardPresses(job);

  const isPublished = job.status === 'published';
  const isNegativeStatus = job.status === 'closed' || job.status === 'expired';

  const metaBadges = [
    job.location ? vocabulary.formatJobLocation(job.location) : undefined,
    job.workplaceType ? WORKPLACE_LABELS[job.workplaceType] : undefined,
    job.employmentType ? EMPLOYMENT_LABELS[job.employmentType] : undefined,
  ].filter((value): value is string => Boolean(value));

  return VStack(
    HStack(
      RawText(t('post.job.label', { defaultValue: 'Job' }))
        .foreground('muted')
        .font('11')
        .weight('semibold')
        .textCase('uppercase')
        .tracking('wide'),
      !isPublished
        ? LBadge(STATUS_LABELS[job.status] ?? job.status)
            .color(isNegativeStatus ? 'error' : 'warning')
            .style('subtle')
            .size('sm')
        : null,
    )
      .align('center')
      .justify('between')
      .spacing('sm'),
    RawText(job.title)
      .foreground('foreground')
      .font('md')
      .weight('bold')
      .margin('top', 'xs')
      .lines(2),
    VStack(RawText(job.employerName).foreground('primary').font('sm').lines(1))
      .onPress(openEmployer)
      .hitSlop('md')
      .alignSelf('start')
      .margin('top', '2xs'),
    metaBadges.length > 0
      ? HStack(
          metaBadges.map((label) =>
            LBadge(label).color('default').style('outlined').size('sm').id(label),
          ),
        )
          .wrap()
          .spacing('6')
          .margin('top', '10')
      : null,
  )
    .padding('md')
    .modifier(look)
    .background('mutedFill')
    .border('border', 'thin')
    .corner('14')
    .clipped()
    .onPress(openJob)
    .role('button')
    .label(job.title);
});

export default JobCard;
