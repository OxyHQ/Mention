/**
 * The author's unpublished posts: the draft list, the scheduled list, and
 * publishing a scheduled post ahead of its time.
 */

import { Response } from 'express';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts as postsTable } from '../../db/schema/posts';
import { CHRONO_DESC, findPostRecords } from '../../db/posts/postRepository';
import type { PostRecord } from '../../db/posts/postRecord';
import type { OxyAuthRequest as AuthRequest } from '@oxyhq/core/server';
import { postCreationService } from '../../services/PostCreationService';
import { logger } from '../../utils/logger';
import { postHydrationService } from '../../services/PostHydrationService';
import { createScopedOxyClient, createUserScopedOxyServices } from '../../utils/oxyHelpers';
import { requestLanguageCandidates } from '../../utils/viewerLanguage';
import { listOperatedChannelIds } from '../../services/publishAsAccount';
import { postManagementRefusal } from '../../services/postManagementAccess';
import { loadScheduledChain } from '../../services/scheduledChain';

// Get drafts
export const getDrafts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // Sorted on `created_at`, which is what the Mongoose call MEANT: it passed
    // the snake_case column name, which Mongo treats as an absent field and
    // therefore as no sort at all. The column exists here, so the intended order
    // is finally the one served.
    const drafts = await findPostRecords(
      and(eq(postsTable.oxyUserId, userId), eq(postsTable.status, 'draft')),
      { orderBy: CHRONO_DESC },
    );

    res.json(drafts);
  } catch (error) {
    logger.error('Error fetching drafts', error);
    res.status(500).json({ message: 'Error fetching drafts' });
  }
};

/**
 * Publish one of the caller's scheduled posts immediately.
 *
 * Publishing early is NOT a reschedule to now — that would leave the post to the
 * next 60s sweep — and it is not a status flip either, because a scheduled post
 * has not federated, has not emitted its MTN record and has notified nobody, all
 * of which `PostCreationService.publishScheduledPost` does. So this reaches that
 * exact method rather than reimplementing publishing in a controller; the post
 * takes the identical pipeline, only sooner.
 *
 * The publish decision stays inside ONE atomic claim: the update filters on the
 * post's OWNER and `status: 'scheduled'`, so nothing can publish twice — not even
 * the sweep running concurrently, which selects on the same filter.
 *
 * **The owner is the post's `oxyUserId`, which is NOT the caller.** For a channel
 * post it is the channel — an account nobody can be signed in as — so passing the
 * caller here (as this did) made every channel's scheduled post unpublishable by
 * everybody, the writer included, while `DELETE /posts/:id` had already been
 * widened to let any member CANCEL that same post. Authorization is therefore
 * asked SEPARATELY, of `postManagementRefusal` — the one authority the other six
 * management routes use — and the owner it resolves is what scopes the claim. The
 * claim is no weaker for it: it still names one exact account, just the right one.
 *
 * **Publishing one post of a scheduled THREAD publishes the thread.** Its posts
 * are replies to one another, so there is no coherent way to send just one:
 * ahead of its parent is a reply to something nobody can see, and behind its
 * continuations is a thread that stops mid-sentence until its original time
 * comes round. The chain is the unit, and it goes out in order, root first.
 */
export const publishScheduledPostNow = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    const targetId = String(req.params.id);

    // One column, not a whole `PostRecord`: this read only has to answer "may
    // the caller manage this post, and whose queue is it in". Assembling the
    // content graph for that would be nine joins on the way to a decision that
    // reads neither. Same shape, and the same order, as `deletePost`.
    //
    // `written_by_oxy_user_id` is deliberately NOT projected. It used to be,
    // because the gate read it — and reading it was the defect: a stored writer
    // who has left the channel is not an authority over it. The gate proves
    // current membership instead, off `oxy_user_id` alone.
    const [target] = await getDb()
      .select({ oxyUserId: postsTable.oxyUserId })
      .from(postsTable)
      .where(eq(postsTable.id, targetId))
      .limit(1);
    if (!target) {
      return res.status(404).json({ message: 'Post not found' });
    }
    const publishRefusal = await postManagementRefusal({
      post: target,
      callerId: userId,
      memberReader: createUserScopedOxyServices(req),
    });
    if (publishRefusal) {
      return res.status(publishRefusal.status).json({ message: publishRefusal.message });
    }
    // The account the chain and the claim are scoped to. Falls back to the caller
    // only for a post with no owner at all, which is a federated row — one that
    // `postManagementRefusal` has already refused above, so this is a total
    // function rather than a reachable branch.
    const ownerId = target.oxyUserId ? String(target.oxyUserId) : userId;

    const chain = await loadScheduledChain(targetId, ownerId);
    if (!chain.ok) {
      return res.status(409).json({
        message: 'This post continues a thread that has not been published yet.',
      });
    }

    // Root first, and stop at the first post that does not go out — the same
    // rule the sweep follows, for the same reason. A post left behind stays
    // scheduled and publishes at its own time, still in order.
    let published: PostRecord | null = null;
    for (const postId of chain.postIds) {
      const result = await postCreationService.claimAndPublishScheduledPost({ postId, ownerId });
      if (postId === targetId) {
        published = result;
      }
      if (result === null) {
        break;
      }
    }

    if (!published) {
      // The claim missed. Tell the caller why — a post that already went out is a
      // different situation from one that never existed — which is safe to
      // distinguish here because `postManagementRefusal` above has already
      // established they may manage this post. Scoped to the resolved OWNER, so
      // it still reports on the row the claim actually tried.
      const [own] = await getDb()
        .select({ status: postsTable.status })
        .from(postsTable)
        .where(and(
          eq(postsTable.id, targetId),
          eq(postsTable.oxyUserId, ownerId),
        ))
        .limit(1);
      if (own && own.status === 'published') {
        return res.status(409).json({ message: 'This post has already been published' });
      }
      return res.status(404).json({ message: 'Post not found' });
    }

    const hydratedPosts = await postHydrationService.hydratePosts([published], {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
    });
    if (hydratedPosts.length === 0) {
      logger.error('Failed to hydrate a just-published scheduled post', {
        postId: published.id,
        userId,
      });
      return res.status(500).json({ message: 'Error publishing scheduled post' });
    }

    res.json(hydratedPosts[0]);
  } catch (error) {
    logger.error('Error publishing scheduled post', error);
    res.status(500).json({ message: 'Error publishing scheduled post' });
  }
};

/**
 * The pending scheduled posts this caller can act on, soonest first: their own,
 * plus the SHARED EDITORIAL QUEUE of every channel they operate.
 *
 * ## Why the channel half exists
 *
 * Several people publish under one channel's byline, and scheduling was private
 * to each author — so two writers could schedule a story for the same Tuesday and
 * neither would know. Worse, and measured rather than inferred: a channel AUTHORS
 * its own posts, so a scheduled channel post carries the CHANNEL as `oxy_user_id`
 * — an account nobody can sign in as — and the owner-scoped query below returned
 * it to NOBODY, *including the person who scheduled it*. It could only ever leave
 * the queue via the 60-second sweep.
 *
 * ## Whose queue an entry belongs to is already in the DTO
 *
 * Each post's `user` IS its authoring account, so the client groups by
 * `post.user.id` with no extra field, no second request and no parallel notion of
 * "queue" to keep in sync with the posts themselves.
 *
 * ## Access control, still enforced twice and now agreeing
 *
 * The query admits an account only after {@link listOperatedChannelIds} confirms
 * an ACTIVE membership through the caller's OWN bearer, and hydration — the
 * single ACL authority — is told the same set, so a post reaches the response
 * only if BOTH agree. The two gates are fed from one resolution, so they cannot
 * drift; loosening the query alone would still return nothing.
 *
 * Fail-soft to `[]` (that resolver's own contract), so an Oxy outage degrades
 * this to the personal queue it has always been rather than 500-ing the
 * composer. It can never ADD an account, which is the direction that would
 * matter.
 *
 * ## Seeing and acting are the SAME right here, deliberately
 *
 * Membership is the strongest right that exists over a channel — it can never be
 * acted as — so there is nothing stronger to demand of someone publishing an
 * entry early than of someone reading it. `postManagementRefusal` already lets
 * any active member DELETE and EDIT these exact posts, so this restores
 * `affordance ⊆ permission` rather than stretching it: the read had been the
 * narrow half, not the wide one.
 *
 * ## WHO QUEUED IT is `signPosts`' decision, and is not made here
 *
 * These are hydrated by the same `PostHydrationService` as every other listing,
 * so an entry names its writer in `authors[]` exactly when the channel signs its
 * posts, and `writtenByOxyUserId` never crosses the wire either way. This surface
 * therefore makes NO new disclosure: it shows a member precisely what the
 * published post would have shown them.
 */
export const getScheduledPosts = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ message: 'Unauthorized' });
    }

    // ONE resolution feeding both gates below. Asked with the caller's own client
    // because `GET /accounts` is anchored on the authenticated operator — a
    // service credential cannot ask "which accounts does person X operate" at all.
    const operatedChannelIds = await listOperatedChannelIds(createUserScopedOxyServices(req));

    const scheduledPosts = await findPostRecords(
      and(
        inArray(postsTable.oxyUserId, [userId, ...operatedChannelIds]),
        eq(postsTable.status, 'scheduled'),
      ),
      { orderBy: [asc(postsTable.scheduledFor), asc(postsTable.id)] },
    );

    const hydratedPosts = await postHydrationService.hydratePosts(scheduledPosts, {
      viewerId: userId,
      oxyClient: createScopedOxyClient(req),
      requestLanguages: requestLanguageCandidates(req),
      maxDepth: 1,
      includeLinkMetadata: true,
      operatedAccountIds: operatedChannelIds,
    });

    res.json({ posts: hydratedPosts });
  } catch (error) {
    logger.error('Error fetching scheduled posts', error);
    res.status(500).json({ message: 'Error fetching scheduled posts' });
  }
};
