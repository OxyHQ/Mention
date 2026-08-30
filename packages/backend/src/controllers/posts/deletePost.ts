/**
 * `DELETE /posts/:id` — the post delete and its cascade.
 *
 * The subtree walk, the reference sweep and the counter repair are
 * `PostDeletionCascade`; this is the authorisation, the scheduled-continuation
 * cleanup, and the response.
 */

import { Response } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts as postsTable } from '../../db/schema/posts';
import { CHRONO_DESC, deletePostRecord, findPostRecords } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { PostVisibility } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { postManagementRefusal } from '../../services/postManagementAccess';
import { emitTombstone, postRecordUri } from '../../services/mtn/MentionRecordEmitter';
import { federateAsResolvedActor } from '../../connectors/outboundFederation';
import { repairRecentRepliersAfterPostDelete } from '../../services/PostRecentReplierService';
import {
  allDeletionTargets,
  deletePostSubtree,
  PostDeletionTooLargeError,
  recordDeletionSideEffectFailure,
  repairSurvivingCounters,
  reportResidue,
  type DeletedPostSubtree,
  type PostDeletionTargets,
} from '../../services/PostDeletionCascade';
import { loadScheduledChain } from '../../services/scheduledChain';

// Delete post
export const deletePost = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Cancelling a SCHEDULED post takes its scheduled continuations with it, and
    // the ids are collected BEFORE the delete, while the chain is still walkable.
    // A thread's continuations exist only as replies to their predecessor: once
    // the parent is gone they can never publish (the claim refuses a post whose
    // parent has not published) and nobody can see them either, so leaving them
    // behind would be a silent black hole in the author's queue rather than a
    // cancellation. Empty for a published post and for a lone scheduled one.
    // Resolved and authorized BEFORE anything is deleted or walked, because both
    // of the steps below need the post's AUTHOR — which for a channel post is
    // the channel, not the caller.
    // One column, not a whole `PostRecord`: this read exists only to answer
    // "may the caller manage this post", and assembling the content graph for it
    // would be six extra joins on the way to a decision that reads neither.
    // `written_by_oxy_user_id` is not among them — see `publishScheduledPostNow`
    // on why the stored writer stopped being an authority over a channel's post.
    const [target] = await getDb()
      .select({ oxyUserId: postsTable.oxyUserId })
      .from(postsTable)
      .where(eq(postsTable.id, String(req.params.id)))
      .limit(1);
    if (!target) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const deleteRefusal = await postManagementRefusal({
      post: target,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (deleteRefusal) {
      return res.status(deleteRefusal.status).json({ message: deleteRefusal.message });
    }
    const authorId = target.oxyUserId ? String(target.oxyUserId) : userId;

    const cancelledContinuations = await scheduledContinuationIds(String(req.params.id), authorId);

    /**
     * ONE TRANSACTION OWNS THE WHOLE SUBTREE, and the ORDER inside it is the
     * fix for a defect that shipped, not a stylistic preference.
     *
     * `posts.parent_post_id` is `ON DELETE SET NULL` and `posts.boost_of` is
     * `ON DELETE CASCADE`, so the instant the post row goes:
     *
     *   - its direct replies stop being findable and are silently PROMOTED to
     *     root posts (measured: the reply survives with `parent_post_id: null`
     *     and `is_reply: true`), and
     *   - every boost of it is removed by the database, taking the only link
     *     that could have found the boosts' own polymorphic references.
     *
     * So the capture comes FIRST, then the reference legs, then the replies,
     * then the post. Deleting first and repairing after — which is what this
     * route did — cannot work, and did not.
     *
     * The reference legs THROW, and that is only coherent because they are in
     * here with the `DELETE`: a leg that fails rolls the whole thing back, the
     * post is NOT deleted, and the 500 is honest and retryable. Outside a
     * transaction the same throw would report a completed deletion whose
     * leftovers no retry could ever reach.
     *
     * The OWNERSHIP CLAIM keeps its atomic-claim property. `deletePostRecord`
     * carries the `oxy_user_id` predicate in the DELETE's own `WHERE`, so it is
     * still one statement that authorizes and removes — not a read-then-write.
     * Two concurrent requests cannot both claim the row; the loser deletes
     * nothing, the whole transaction rolls back, and it answers 404 exactly as
     * before. Moving it inside a transaction changes when it commits, never
     * what it checks.
     */
    let deletion: DeletedPostSubtree | null = null;
    try {
      // `authorId`, NOT `userId`. Authorization was already decided above by
      // `postManagementRefusal`, which deliberately admits a channel post's
      // WRITER and its co-operators — none of whom is the row's `oxy_user_id`,
      // because a channel post is owned by the CHANNEL and no session can ever
      // have a channel as its subject. Claiming on the caller's own id therefore
      // matched nothing and answered 404 to the person who wrote the post, after
      // telling them they were allowed. Same trap the lane path names two hundred
      // lines above; this is the site where it survived the port.
      //
      // The claim keeps its atomic-claim property: `authorId` comes from the row
      // this request already read and re-checks the SAME ownership the refusal
      // decided against, in the DELETE's own `WHERE`.
      deletion = await deletePostSubtree(
        String(req.params.id),
        eq(postsTable.oxyUserId, authorId),
      );
    } catch (error) {
      if (error instanceof PostDeletionTooLargeError) {
        logger.error('Post deletion refused: too many dependent rows', {
          postId: String(req.params.id),
          found: error.found,
        });
        return res.status(409).json({ message: 'Post has too many dependent rows to delete' });
      }
      throw error;
    }
    if (!deletion) {
      // Either no such post, or the ownership claim matched nothing — the
      // second rolled back, so nothing was removed for a caller who was never
      // allowed to. Both answer 404; distinguishing them would disclose that
      // the post exists.
      return res.status(404).json({ message: 'Post not found' });
    }
    const deletedPost: PostRecord = deletion.post;
    const deletedTargets: PostDeletionTargets = deletion.targets;
    const postId = deletedPost.id;

    // Everything from here is BEST-EFFORT: the deletion is committed and the
    // user is about to be told it succeeded, so a failure below must not turn
    // it into a 500. Each one is swallowed and COUNTED — fail-soft is fine,
    // silent is not.
    try {
      await repairRecentRepliersAfterPostDelete({
        postId,
        parentPostId: deletedPost.parentPostId,
      });
    } catch (error) {
      recordDeletionSideEffectFailure('recent_replier_projection', error);
    }
    try {
      await repairSurvivingCounters(deletedTargets, deletion.removedIds);
    } catch (error) {
      recordDeletionSideEffectFailure('surviving_counters', error);
    }

    // MTN dual-write: deleting a LOCAL post tombstones its
    // `app.mention.feed.post` record. (Federated posts never emitted a record.)
    if (deletedPost.federation == null && deletedPost.oxyUserId) {
      await emitTombstone({
        authorOxyUserId: deletedPost.oxyUserId,
        tombstoneRkey: postId,
        subjectUri: postRecordUri(deletedPost.oxyUserId, postId),
      });
    }

    // Outbound federation: broadcast a Delete(Tombstone) so remote followers'
    // Mastodon removes the post. The row is already gone, but its data (id +
    // author) is captured above from the deleted doc; the canonical Note id is
    // minted from the resolved username + post id. Local + published + public
    // only — an unpublished/private post was never federated. Username resolved
    // server-side from the authoritative oxyUserId.
    if (
      deletedPost.federation == null &&
      deletedPost.oxyUserId &&
      deletedPost.visibility === PostVisibility.PUBLIC &&
      deletedPost.status === 'published'
    ) {
      const deleterOxyUserId = deletedPost.oxyUserId;
      federateAsResolvedActor(deleterOxyUserId, 'post delete', (username) => ({
        kind: 'post.delete',
        post: { _id: postId },
        actorOxyUserId: deleterOxyUserId,
        actorUsername: username,
      }));
    }

    // The cascade ITSELF already ran, inside the transaction above — every
    // reference the delete claims is gone by the time the row is. What is left
    // here is the VERIFICATION: re-run exactly the claimed probes against the
    // committed state and say what is actually still there, rather than
    // assuming the legs worked.
    //
    // It has to be outside the transaction to mean anything. Inside, the probes
    // would read that transaction's own uncommitted deletes and pass by
    // construction — a check that cannot fail.
    try {
      await reportResidue(allDeletionTargets(deletedTargets), postId);
    } catch (error) {
      recordDeletionSideEffectFailure('residue_check', error);
    }

    await deleteScheduledContinuations(cancelledContinuations, userId);

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    logger.error('Error deleting post', error);
    res.status(500).json({ message: 'Error deleting post' });
  }
};

/**
 * The scheduled posts that would be orphaned by cancelling `postId` — its own
 * scheduled descendants, never `postId` itself.
 *
 * Returns nothing unless `postId` is itself a scheduled post of `ownerId`:
 * deleting a PUBLISHED post leaves its replies standing (they are real posts
 * people have seen), and only an unpublished chain is the author's to withdraw.
 */
async function scheduledContinuationIds(postId: string, ownerId: string): Promise<string[]> {
  const [target] = await getDb()
    .select({ id: postsTable.id })
    .from(postsTable)
    .where(and(
      eq(postsTable.id, postId),
      eq(postsTable.oxyUserId, ownerId),
      eq(postsTable.status, 'scheduled'),
    ))
    .limit(1);
  if (!target) {
    return [];
  }
  const chain = await loadScheduledChain(postId, ownerId);
  if (!chain.ok) {
    return [];
  }
  // The chain walks up to its root as well; only what publishes AFTER this post
  // depends on it.
  const index = chain.postIds.indexOf(postId);
  return index === -1 ? [] : chain.postIds.slice(index + 1);
}

/**
 * Delete cancelled continuations and the only two records a never-published post
 * can own: its article and its poll.
 *
 * Everything else `deletePost` cleans up needs a reader — likes, bookmarks,
 * subscriptions, mention notifications — and a scheduled post has none by
 * construction (it never federated, emitted no MTN record, and `createThread`
 * withholds its mention notifications until publish). Best-effort: a
 * cancellation that removed the posts has done the part the author asked for.
 */
async function deleteScheduledContinuations(postIds: string[], ownerId: string): Promise<void> {
  if (postIds.length === 0) return;
  try {
    const cancelled = await findPostRecords(
      and(
        inArray(postsTable.id, postIds),
        eq(postsTable.oxyUserId, ownerId),
        eq(postsTable.status, 'scheduled'),
      ),
      { orderBy: CHRONO_DESC },
    );
    // No `articleIds` or `pollIds` here: both tables cascade from `posts` (see
    // deletePost). The `Article.deleteMany` that used to follow this loop was
    // reaching a store the article write path no longer uses.

    // Per-row, because `deletePostRecord` owns the child-table cascade a post's
    // nine tables need; a bare `DELETE … WHERE id = any(...)` would leave the
    // repository's own invariants to the database's foreign keys alone.
    await Promise.allSettled(
      cancelled.map((p) => deletePostRecord(p.id, eq(postsTable.oxyUserId, ownerId))),
    );
  } catch (error) {
    logger.error('Error cancelling scheduled thread continuations', error);
  }
}
