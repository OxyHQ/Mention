/**
 * The post-level settings an author changes after publishing: the pin, hidden
 * counts, reply permission and review flag (`updatePostSettings`), and the
 * channel lane a post is filed under (`updatePostLane`).
 */

import { Response } from 'express';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { lanes as lanesTable } from '../../db/schema/channels';
import { posts as postsTable } from '../../db/schema/posts';
import { loadPostRecord, updatePostRecord, type PostRecordPatch } from '../../db/posts/postRepository';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { ReplyPermission } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { assertLaneAssignable, LaneAssignmentError } from '../../utils/laneAssignment';
import { postIsAuthoredByChannel } from '../../utils/channelReplyGate';
import { postManagementRefusal } from '../../services/postManagementAccess';
import { sendSuccessResponse } from '../../utils/apiHelpers';

// Update post settings (pin, hide counts, reply permissions, review replies)
export const updatePostSettings = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // By id then authorized — see `updatePost` for why the owner-scoped lookup
    // could not serve a channel post.
    const post = await loadPostRecord(String(req.params.id));
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const settingsRefusal = await postManagementRefusal({
      post,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (settingsRefusal) {
      return res.status(settingsRefusal.status).json({ message: settingsRefusal.message });
    }

    const { isPinned, hideEngagementCounts, replyPermission, reviewReplies, quotesDisabled } = req.body;

    const patch: PostRecordPatch = {};
    const metadata: NonNullable<PostRecordPatch['metadata']> = {};

    if (isPinned !== undefined) {
      if (typeof isPinned !== 'boolean') {
        return res.status(400).json({ message: 'isPinned must be a boolean' });
      }
      metadata.isPinned = isPinned;
    }

    if (hideEngagementCounts !== undefined) {
      if (typeof hideEngagementCounts !== 'boolean') {
        return res.status(400).json({ message: 'hideEngagementCounts must be a boolean' });
      }
      metadata.hideEngagementCounts = hideEngagementCounts;
    }

    if (replyPermission !== undefined) {
      // A channel post's `replyPermission` is not the author's to change. The
      // server's refusal does not depend on this field (see
      // `utils/channelReplyGate`), so a change here could not actually reopen the
      // post — but it WOULD un-hide the client's reply button and leave every
      // reader hitting a 403 they were invited to attempt. The stored `['nobody']`
      // is defence in depth precisely because it is what the client reads, so it
      // has to stay put.
      if (await postIsAuthoredByChannel(post)) {
        return res.status(400).json({
          message: 'A post published by a channel does not accept replies',
        });
      }
      const validPermissions = ['anyone', 'followers', 'following', 'mentioned', 'nobody'];
      if (!Array.isArray(replyPermission) || replyPermission.length === 0) {
        return res.status(400).json({ message: 'replyPermission must be a non-empty array' });
      }
      const allValid = replyPermission.every((p: string) => validPermissions.includes(p));
      if (!allValid) {
        return res.status(400).json({ message: `replyPermission values must be one of: ${validPermissions.join(', ')}` });
      }
      patch.replyPermission = replyPermission as ReplyPermission[];
    }

    if (reviewReplies !== undefined) {
      if (typeof reviewReplies !== 'boolean') {
        return res.status(400).json({ message: 'reviewReplies must be a boolean' });
      }
      patch.reviewReplies = reviewReplies;
    }

    if (quotesDisabled !== undefined) {
      if (typeof quotesDisabled !== 'boolean') {
        return res.status(400).json({ message: 'quotesDisabled must be a boolean' });
      }
      patch.quotesDisabled = quotesDisabled;
    }

    if (Object.keys(metadata).length > 0) patch.metadata = metadata;
    await updatePostRecord(post.id, patch);

    res.json({
      message: 'Post settings updated',
      isPinned: metadata.isPinned ?? post.metadata.isPinned,
      hideEngagementCounts: metadata.hideEngagementCounts ?? post.metadata.hideEngagementCounts,
      replyPermission: patch.replyPermission ?? post.replyPermission,
      reviewReplies: patch.reviewReplies ?? post.reviewReplies,
      quotesDisabled: patch.quotesDisabled ?? post.quotesDisabled,
    });
  } catch (error) {
    logger.error('Error updating post settings', error);
    res.status(500).json({ message: 'Error updating post settings' });
  }
};

/**
 * PATCH /posts/:id/lane — move one of the author's own posts between their lanes,
 * or (with `laneId: null`) out of every lane.
 *
 * **There is deliberately NO edit window here, and nobody should add one by
 * copying the 30-minute guard out of `updatePost`.** That window exists because
 * REWRITING THE TEXT of a post people have already read is a trust problem.
 * Moving a post between the author's own organizational carriageways changes no
 * text: it does not federate, does not emit an MTN record, does not set
 * `isEdited`, and does not re-classify. Pinning/unpinning already has no window
 * for exactly the same reason, which is why this is modelled on
 * `updatePostSettings` rather than on `updatePost`.
 *
 * Owner-only, and scoped by `oxyUserId` in the query, so somebody else's post is
 * a 404 rather than a 403 that confirms it exists.
 *
 * **The success body uses `sendSuccessResponse`'s `{data}` envelope, unlike every
 * other handler in this file — that is deliberate, not an oversight.** This is a
 * Lanes endpoint that happens to live on the posts router because it addresses a
 * post; its only client is `lanesService`, which reads every OTHER lane endpoint
 * (all of `routes/lanes.routes.ts`) through that envelope. Matching the feature
 * the client sees beats matching the file the handler sits in. The error paths
 * deliberately stay on this file's bare `{message}` shape, which is what the rest
 * of the posts API — and this controller's own `LaneAssignmentError` mapping in
 * `createPost` — already returns.
 *
 * ---------------------------------------------------------------------------
 * NAMED EXCEPTION FOR THE NEXT MERGE FROM `main` — DO NOT AUTO-RESOLVE THIS ROUTE
 *
 * This branch re-ported Channels/Lanes against `main` at **`f54db41e`**, where a
 * channel post is not the caller's to move: the lookup below is scoped by
 * `oxy_user_id = userId`, so a post authored by the CHANNEL is a 404 here and the
 * writer cannot relane it.
 *
 * `main` has since moved to **`036927ed`**, which answers that question
 * DIFFERENTLY: it looks the post up by id alone and authorizes through a
 * `postManagementRefusal` helper — a symbol that **exists nowhere in this tree** —
 * letting the WRITER move a channel post, with the lane measured against the
 * channel rather than against the caller.
 *
 * **That is an authorization decision wearing a merge conflict's clothes.** Taking
 * either side mechanically ships a permission bug, and NO TEST ON THIS BRANCH
 * WOULD CATCH IT: this branch's tests encode the `f54db41e` semantics, so they go
 * green while being wrong about who may move what.
 *
 * So when the catch-up merge happens: read this route against main's new helper
 * as a deliberate decision, and REWRITE its tests to whichever semantics you
 * choose. Do not carry the ones below forward as evidence.
 * ---------------------------------------------------------------------------
 */
export const updatePostLane = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const { laneId } = req.body;
    if (laneId !== null && typeof laneId !== 'string') {
      return res.status(400).json({ message: 'laneId must be a lane id or null' });
    }

    // By id, NOT narrowed by `oxy_user_id` — see `updatePost`. The projection
    // carries `oxy_user_id` because `postManagementRefusal` reads it: it names
    // the account that authored the post (a channel, for a channel post) and is
    // what the membership proof is made against, so a projection missing it
    // silently refuses everybody.
    const [post] = await getDb()
      .select({
        id: postsTable.id,
        parentPostId: postsTable.parentPostId,
        boostOf: postsTable.boostOf,
        laneId: postsTable.laneId,
        oxyUserId: postsTable.oxyUserId,
      })
      .from(postsTable)
      .where(eq(postsTable.id, String(req.params.id)))
      .limit(1);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const laneRefusal = await postManagementRefusal({
      post,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (laneRefusal) {
      return res.status(laneRefusal.status).json({ message: laneRefusal.message });
    }

    // The SAME rule the create path applies, from the same definition: a lane
    // belongs to its publisher, and replies/boosts carry none.
    //
    // **The publisher is read off the POST, never taken as the caller.** It used
    // to be `userId`, which was safe only while the lookup above was narrowed by
    // `oxy_user_id = userId` — the two could not disagree. They can now, because
    // that narrowing is gone (a channel post's author is the channel, so it made
    // every channel post unmovable): a channel post is authored by the channel
    // and moved by a human, so passing the caller here would offer the WRITER's
    // own lanes for a post the channel published. A channel post landing in a
    // personal lane deanonymizes the writer, because a lane tab is scoped to one
    // author even though the post's DTO stays anonymous.
    await assertLaneAssignable({
      laneId,
      authorId: post.oxyUserId ? String(post.oxyUserId) : null,
      parentPostId: post.parentPostId,
      boostOf: post.boostOf,
    });

    // NULL, and here that is exactly right. Mongo needed `$unset` rather than a
    // stored null because `post_lane_chrono_v1`'s partial filter is
    // `{ laneId: { $exists: true } }`, which a null SATISFIES — leaving a
    // laneless post indexed forever. The Postgres partial index is
    // `where lane_id is not null`, so null is the state that removes the row
    // from it. "Absent" and "null" are one state here, so the trap does not
    // survive the port.
    //
    // Scoped by the post's AUTHOR, never the caller, for the same reason the
    // lane check above is. Left as `oxy_user_id = userId` this matched nothing
    // for a channel post — and an `UPDATE` that matches nothing is not an error,
    // so the handler answered 200 with the new lane's summary while the post had
    // not moved.
    await getDb()
      .update(postsTable)
      .set({ laneId: laneId ?? null })
      .where(and(eq(postsTable.id, post.id), eq(postsTable.oxyUserId, post.oxyUserId ?? '')));

    const [lane] = laneId
      ? await getDb()
        .select({ id: lanesTable.id, name: lanesTable.name, displayMode: lanesTable.displayMode })
        .from(lanesTable)
        .where(eq(lanesTable.id, laneId))
        .limit(1)
      : [];

    return sendSuccessResponse(
      res,
      200,
      {
        postId: post.id,
        lane: lane
          ? { id: lane.id, name: lane.name, displayMode: lane.displayMode }
          : null,
      },
      'Post lane updated',
    );
  } catch (error) {
    if (error instanceof LaneAssignmentError) {
      return res.status(error.status).json({ message: error.message });
    }
    logger.error('Error updating post lane', error);
    res.status(500).json({ message: 'Error updating post lane' });
  }
};
