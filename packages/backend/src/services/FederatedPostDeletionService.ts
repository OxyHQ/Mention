import { eq, isNull } from 'drizzle-orm';
import { posts } from '../db/schema/posts';
import { logger } from '../utils/logger';
import { repairRecentRepliersAfterPostDelete } from './PostRecentReplierService';
import {
  allDeletionTargets,
  deletePostSubtree,
  PostDeletionTooLargeError,
  recordDeletionSideEffectFailure,
  repairSurvivingCounters,
  reportResidue,
} from './PostDeletionCascade';

/**
 * Remove a remote actor's post through the canonical transactional cascade.
 * The actor URI remains part of the DELETE claim for inbox authorization and
 * for administrative cleanup of old federated rows alike. `null` claims a row
 * stored with no actor at all, which only an administrative cleanup names: the
 * dependency import once stored boosted originals without one.
 */
export async function deleteFederatedPostSubtree(
  postId: string,
  actorUri: string | null,
): Promise<'deleted' | 'not-found' | 'too-large'> {
  let deletion: Awaited<ReturnType<typeof deletePostSubtree>>;
  try {
    deletion = await deletePostSubtree(
      postId,
      actorUri === null ? isNull(posts.federationActorUri) : eq(posts.federationActorUri, actorUri),
      'privileged-removal',
    );
  } catch (error) {
    if (error instanceof PostDeletionTooLargeError) {
      logger.warn('[Federation] refused oversized federated post deletion', {
        found: error.found,
      });
      return 'too-large';
    }
    throw error;
  }
  if (!deletion) return 'not-found';

  try {
    await repairRecentRepliersAfterPostDelete({
      postId,
      parentPostId: deletion.post.parentPostId,
    });
  } catch (error) {
    recordDeletionSideEffectFailure('recent_replier_projection', error);
  }
  try {
    await repairSurvivingCounters(deletion.targets, deletion.removedIds);
  } catch (error) {
    recordDeletionSideEffectFailure('surviving_counters', error);
  }
  reportResidue(allDeletionTargets(deletion.targets), postId);
  return 'deleted';
}
