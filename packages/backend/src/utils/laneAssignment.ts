/**
 * The ONE rule that governs putting a post in a lane, shared by every write path
 * that can set `post.laneId` (`POST /posts` via `PostCreationService.create`, and
 * `PATCH /posts/:id/lane`). One definition, so the rule cannot drift between the
 * place a post is created and the place it is moved.
 *
 * Two things are enforced, and both are REFUSALS rather than silent drops — an
 * author who is told nothing would go on believing they published in a lane:
 *
 *  1. **A lane's publisher must be the post's publisher.** A lane belongs to one
 *     `ownerId`, and the post's publisher is its OWNER — which for a post
 *     published as a channel is the channel account itself, because that account
 *     authors the post. So there is one comparison here, not a branch: a lane of
 *     any other publisher is a 404.
 *  2. **Replies and boosts carry no lane.** A lane is an editorial decision about
 *     ORIGINAL content: a boost has no body of its own, and a reply belongs to
 *     its parent's conversation. Refusing them here is also what keeps the two
 *     write paths that skip `PostCreationService` (`feed.controller`'s
 *     `createReply` / `createBoost`) out of this feature entirely. A QUOTE is
 *     allowed — it is an original post with its own body and its own row on the
 *     profile.
 *
 * The lookup is SCOPED BY PUBLISHER, so somebody else's lane is indistinguishable
 * from one that does not exist: both answer 404, and neither is an oracle for
 * whether a given lane id is real.
 *
 * Free when there is no lane — `laneId == null` returns without a query, which is
 * the overwhelming majority of posts.
 */

import mongoose from 'mongoose';
import { Lane } from '../models/Lane';

/** A refusal carrying the status the HTTP layer should answer with. */
export class LaneAssignmentError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'LaneAssignmentError';
    this.status = status;
  }
}

export interface LaneAssignmentParams {
  /** The lane the post is being put in. `null`/`undefined` = no lane; nothing to check. */
  laneId?: string | null;
  /**
   * The post's OWNER — the publisher whose lanes are eligible. For a post
   * published as a channel this is the channel account, because that account is
   * the post's author; the human who wrote it is recorded outside `authorship`
   * and owns none of this.
   */
  authorId?: string | null;
  /** Present ⇒ the post is a reply ⇒ no lane. */
  parentPostId?: string | null;
  /** Present ⇒ the post is a boost ⇒ no lane. */
  boostOf?: string | null;
}

/**
 * Throw {@link LaneAssignmentError} unless this post may carry this lane.
 * Resolves silently (and without a query) when no lane was requested.
 */
export async function assertLaneAssignable(params: LaneAssignmentParams): Promise<void> {
  const laneId = params.laneId ?? undefined;
  if (!laneId) return;

  if (params.parentPostId) {
    throw new LaneAssignmentError(400, 'A reply cannot be assigned to a lane');
  }
  if (params.boostOf) {
    throw new LaneAssignmentError(400, 'A boost cannot be assigned to a lane');
  }

  const ownerId = params.authorId ?? '';
  if (!ownerId) {
    throw new LaneAssignmentError(400, 'A post with no publisher cannot be assigned to a lane');
  }

  // An id that is not even an ObjectId answers the same 404 as a real lane
  // belonging to somebody else, rather than reaching Mongo and raising a
  // CastError the caller would have to translate into the same answer anyway.
  if (!mongoose.Types.ObjectId.isValid(laneId)) {
    throw new LaneAssignmentError(404, 'Lane not found');
  }

  const exists = await Lane.exists({ _id: laneId, ownerId });
  if (!exists) {
    throw new LaneAssignmentError(404, 'Lane not found');
  }
}
