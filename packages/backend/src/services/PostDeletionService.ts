/**
 * Delete ONE post its author owns, and everything a deletion owes afterwards.
 *
 * The committed half is `PostDeletionCascade.deletePostSubtree` (one transaction
 * that captures, sweeps references, removes replies and claims the row). This is
 * the whole operation around it: that transaction, then the best-effort steps a
 * committed deletion owes — the replier projection, the surviving counters, the
 * MTN tombstone, the federated `Delete(Tombstone)` and the residue check.
 *
 * It lived inline in `DELETE /posts/:id` until a second caller needed exactly the
 * same behaviour: undoing a content import (`services/PostImportService.ts`) must
 * delete through the NORMAL path, or a remote server that fetched an imported
 * post from the outbox would never be told it is gone. Two copies of this
 * sequence would drift on precisely the step that matters there.
 *
 * AUTHORIZATION IS THE CALLER'S. `authorId` is the account the row must belong
 * to, re-checked in the DELETE's own `WHERE` (an atomic claim, never a
 * read-then-write); deciding whether the CALLER may act for that account is done
 * before this is called (`postManagementRefusal` for the HTTP route, the import
 * ledger's own owner scope for the undo).
 */

import { eq } from 'drizzle-orm';
import { PostVisibility } from '@mention/shared-types';
import { posts as postsTable } from '../db/schema/posts';
import type { PostRecord } from '../db/posts/postRecord';
import { emitTombstone, postRecordUri } from './mtn/MentionRecordEmitter';
import { federateAsResolvedActor } from '../connectors/outboundFederation';
import { repairRecentRepliersAfterPostDelete } from './PostRecentReplierService';
import {
  allDeletionTargets,
  deletePostSubtree,
  recordDeletionSideEffectFailure,
  repairSurvivingCounters,
  reportResidue,
  type DeletedPostSubtree,
  type PostDeletionTargets,
} from './PostDeletionCascade';

/**
 * Delete `postId` if it belongs to `authorId`, and run every best-effort step a
 * committed deletion owes.
 *
 * Returns `null` for BOTH "no such post" and "not this author's" — every caller
 * answers the two alike, and telling them apart would disclose that the post
 * exists. Throws `PostDeletionTooLargeError` unchanged so a caller can answer
 * 409; any other throw means NOTHING was deleted (the transaction rolled back).
 *
 * Nothing after the commit throws: each best-effort step is swallowed and
 * COUNTED (`recordDeletionSideEffectFailure`), because the post is gone and a
 * projection that could not be repaired is not a reason to report a completed
 * deletion as a failure.
 */
export async function deleteAuthoredPost(
  postId: string,
  authorId: string,
): Promise<DeletedPostSubtree | null> {
  const deletion = await deletePostSubtree(postId, eq(postsTable.oxyUserId, authorId));
  if (!deletion) return null;

  const deletedPost: PostRecord = deletion.post;
  const deletedTargets: PostDeletionTargets = deletion.targets;
  const deletedId = deletedPost.id;

  try {
    await repairRecentRepliersAfterPostDelete({
      postId: deletedId,
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
      tombstoneRkey: deletedId,
      subjectUri: postRecordUri(deletedPost.oxyUserId, deletedId),
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
      post: { _id: deletedId },
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
    await reportResidue(allDeletionTargets(deletedTargets), deletedId);
  } catch (error) {
    recordDeletionSideEffectFailure('residue_check', error);
  }

  return deletion;
}
