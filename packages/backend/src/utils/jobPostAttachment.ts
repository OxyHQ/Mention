import type { PostJobContent } from '@mention/shared-types';
import { getJobById, toMentionJobPosting } from '../db/jobs/jobRepository';
import { resolveUserSummaries } from '../services/PostHydrationService';

/**
 * Extract ONLY the untrusted `mentionJobId` reference from a job attachment
 * input. Title/employer/status/canonical URL are NEVER taken from the client —
 * they are resolved + denormalized server-side from Mention's own job record
 * (see {@link resolveJobContent}) after this returns. Mirrors `sanitizePodcast`.
 * Returns `null` when no valid id is present.
 */
export const sanitizeJobInput = (input: unknown): { mentionJobId: string } | null => {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const mentionJobId = typeof obj.mentionJobId === 'string' ? obj.mentionJobId.trim() : '';
  if (!mentionJobId) return null;
  return { mentionJobId };
};

/**
 * Resolve a Mention job by id and denormalize it into the canonical
 * {@link PostJobContent} shape persisted on a post — title/employer/status
 * come from Mention's own `mention_jobs` row, never the client. Returns `null`
 * when the job cannot be resolved (deleted, or an id that never existed);
 * callers own the drop-vs-400 policy, same as `resolvePodcastContent` throwing
 * for its own callers to catch.
 */
export const resolveJobContent = async (id: string): Promise<PostJobContent | null> => {
  const row = await getJobById(id);
  if (!row) return null;
  const job = toMentionJobPosting(row);
  const employer = (await resolveUserSummaries([job.employerOxyUserId])).get(job.employerOxyUserId);
  return {
    mentionJobId: job.id,
    title: job.title,
    employerName: employer?.user.name?.displayName ?? employer?.user.username ?? job.employerOxyUserId,
    employerOxyUserId: job.employerOxyUserId,
    status: job.status,
    canonicalUrl: job.canonicalUrl,
    location: job.location,
    workplaceType: job.workplaceType,
    employmentType: job.employmentType,
  };
};
