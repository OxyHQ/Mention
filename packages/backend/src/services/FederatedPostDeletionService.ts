import { eq } from 'drizzle-orm';
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
 * for administrative cleanup of old federated rows alike.
 */
export async function deleteFederatedPostSubtree(
  postId: string,
  actorUri: string,
): Promise<'deleted' | 'not-found' | 'too-large'> {
  let deletion: Awaited<ReturnType<typeof deletePostSubtree>>;
  try {
    deletion = await deletePostSubtree(postId, eq(posts.federationActorUri, actorUri));
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
  try {
    await reportResidue(allDeletionTargets(deletion.targets), postId);
  } catch (error) {
    recordDeletionSideEffectFailure('residue_check', error);
  }
  return 'deleted';
}
