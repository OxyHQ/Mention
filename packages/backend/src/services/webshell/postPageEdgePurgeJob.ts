/**
 * The BullMQ processor for `post-page-edge-purge` (`queue/workers.ts`).
 *
 * Kept apart from `postPageEdgePurge.ts` so the modules that purge after a
 * write (deletion, moderation, edits) do not import the author sweep, and with
 * it the Oxy profile reads.
 *
 * GIVING UP is decided here, once: on the last attempt, or at once for an
 * error no retry can change (a revoked or expired token), the purge is logged
 * as `POST_PAGE_PURGE_GAVE_UP_LOG`, which the CloudWatch alarm watches. Every
 * earlier failure is left to BullMQ's backoff.
 */
import { UnrecoverableError, type Job } from 'bullmq';
import type { PostPageEdgePurgeJobData } from '../../queue/types';
import { CloudflarePurgeRejectedError } from './cloudflarePurgeClient';
import { recordPostPagePurgeFailure, runPostPagePurge } from './postPageEdgePurge';
import { runAuthorPostPagePurge } from './authorPostPagePurge';
import { logger } from '../../utils/logger';

export async function processPostPageEdgePurgeJob(
  job: Job<PostPageEdgePurgeJobData>,
): Promise<void> {
  const data = job.data;
  try {
    if (data.kind === 'posts') {
      await runPostPagePurge(data.postIds, data.reason);
      return;
    }
    const { swept } = await runAuthorPostPagePurge(data.oxyUserId);
    if (swept > 0)
      logger.info('[EdgePurge] swept the post pages of a hidden author', { posts: swept });
  } catch (error) {
    const permanent = error instanceof CloudflarePurgeRejectedError;
    const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    if (permanent || lastAttempt) {
      recordPostPagePurgeFailure(
        data.kind === 'posts' ? data.reason : 'author_check',
        'purge',
        data.kind === 'posts' ? data.postIds.length : 0,
        error,
      );
    }
    if (permanent) throw new UnrecoverableError((error as Error).message);
    throw error;
  }
}
