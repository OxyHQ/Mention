import mongoose from 'mongoose';
import { PostType } from '@mention/shared-types';
import { Post } from '../models/Post';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import Notification from '../models/Notification';
import Poll from '../models/Poll';
import Article from '../models/Article';
import { Postgate } from '../models/Postgate';
import { Threadgate } from '../models/Threadgate';
import EngagementOutbox from '../models/EngagementOutbox';
import ContentLabel from '../models/ContentLabel';
import { FeedInteraction } from '../models/FeedInteraction';
import FederationDeliveryQueue from '../models/FederationDeliveryQueue';
import { PostRecentReplier } from '../models/PostRecentReplier';
import { logger } from '../utils/logger';
import {
  collectPostCascadeResidue,
  type PostDeletionTarget,
  type PostReferenceProbeName,
} from '../scripts/lib/adminDeletionPreflight';

/**
 * Everything that has to happen once a `Post` row is gone, for the LIVE delete
 * path — the route every user hits, not an administrative sweep.
 *
 * The reference list this works from is the one
 * {@link PostReferenceProbeName} already enumerates, and the disposition table
 * below is a `Record` over it ON PURPOSE: adding a reference type to the probe
 * list breaks THIS file's build until somebody decides what the delete route
 * should do about it. That is the property a plain array of claimed names does
 * not have, and it is what makes the cascade fail closed on a reference nobody
 * has thought about yet rather than silently leaving it behind.
 */

/** What the live delete path does about one known kind of post reference. */
type ReferenceDisposition =
  /** Deleted in this cascade — the row describes a post and cannot outlive it. */
  | 'cascade'
  /**
   * A queue whose PENDING rows are cancelled and whose completed rows are kept.
   * Deliberately NOT claimed to the residue check: the claim would be false,
   * and a false claim reported as satisfied is the exact failure this module
   * exists to remove.
   */
  | 'cancel-pending'
  /** Deliberately kept. Every entry carries its reason in the table below. */
  | 'retain';

const POST_REFERENCE_DISPOSITION: Record<PostReferenceProbeName, ReferenceDisposition> = {
  // Pure derivations of the post: nothing else keys on them, and left behind
  // they name an id no surface can resolve.
  'Notification.entityId': 'cascade',
  'Poll.postId': 'cascade',
  'Article.postId': 'cascade',
  'Postgate.postId/postUri': 'cascade',
  'Threadgate.postId/postUri': 'cascade',
  'PostRecentReplier.postId': 'cascade',
  'ContentLabel.targetId(post)': 'cascade',
  'FeedInteraction.postUri': 'cascade',
  'Like.postId': 'cascade',
  'Bookmark.postId': 'cascade',

  /**
   * Two durable queues, cancelled but not erased, for the same two reasons.
   *
   * Only a PENDING row can still act — apply an engagement transition to a post
   * that is gone, or deliver an activity about it. A processed or delivered row
   * is a log entry, not a pointer anything dereferences.
   *
   * And the queries that would find the rest do not belong on a user-facing
   * route. Neither collection is indexed on the field the reference is named
   * by (`payload.postId`; the three `activityJson` paths), so an unscoped
   * delete is a collection scan — over 30 days of engagement in one case, and
   * in the other over a queue nothing prunes at all: rows are flipped to
   * `delivered`/`failed` in place and kept forever. Filtering on `status`
   * reaches both through an existing index prefix and touches only the live
   * backlog. The administrative purge still removes them wholesale, which is
   * the right trade for a batch job and the wrong one here.
   */
  'EngagementOutbox.payload.postId': 'cancel-pending',
  'FederationDeliveryQueue.activityJson': 'cancel-pending',

  /**
   * RETAINED, and this is the one entry where deleting would break something
   * rather than merely lose an audit trail.
   *
   * An inbound CrowdSource decision is matched to local rows by
   * `Report.crowdSourceCaseId` — `ModerationDecisionWorker` throws a RETRYABLE
   * `ModerationDecisionDeferredError` when a case resolves to no report, so a
   * decision arriving after the reported post was deleted would back off and
   * retry until it expired. The delivery side already has a designed answer for
   * a subject that vanished (`ModerationDeliveryWorker` closes the report as
   * undeliverable rather than retrying), so the row is not stranded by being
   * kept — only by being removed.
   *
   * `purgeBlockedDomainContent` deletes these, which is a different call for a
   * different reason: it removes a blocked instance's content wholesale, and
   * its cascade owns that decision. A user deleting their own post does not get
   * to erase reports filed about it.
   */
  'Report.reportedId(post)': 'retain',
};

/** The claim this cascade makes, in the shape the residue check verifies. */
export const CASCADED_POST_REFERENCES: readonly PostReferenceProbeName[] = (
  Object.keys(POST_REFERENCE_DISPOSITION) as PostReferenceProbeName[]
).filter((name) => POST_REFERENCE_DISPOSITION[name] === 'cascade');

/**
 * The references this module deliberately does NOT remove — the `retain` and
 * `cancel-pending` halves of the table above.
 *
 * Derived from the same `Record` rather than written out a second time, so a
 * disposition that changes moves both lists at once. Exported for a caller that
 * has to declare its position to `assertPostsSafeToDelete`
 * (`keptByPolicy`): a reference this module keeps on purpose must not read to
 * that gate as one nobody thought about, and the only honest way to say so is
 * to name the decision's owner rather than to claim the rows are gone.
 */
export const POST_REFERENCES_KEPT_BY_POLICY: readonly PostReferenceProbeName[] = (
  Object.keys(POST_REFERENCE_DISPOSITION) as PostReferenceProbeName[]
).filter((name) => POST_REFERENCE_DISPOSITION[name] !== 'cascade');

/**
 * The fields the cascade reads off a post. Deliberately the same set the
 * administrative purge projects, so the two cannot drift into needing different
 * reads of the same row.
 */
export interface CascadedPostRow {
  _id: mongoose.Types.ObjectId | string;
  oxyUserId?: string;
  boostOf?: string;
  parentPostId?: string;
  federation?: { activityId?: string; url?: string } | null;
  content?: { pollId?: string; article?: { articleId?: string } } | null;
}

const BOOST_CLOSURE_PROJECTION = {
  _id: 1,
  oxyUserId: 1,
  boostOf: 1,
  parentPostId: 1,
  federation: 1,
  'content.pollId': 1,
  'content.article.articleId': 1,
} as const;

/**
 * A hard cap on how many boosts one delete may take with it.
 *
 * The closure is unbounded in principle — a widely boosted post has as many
 * boosts as it has boosters — and a live HTTP request is the wrong place to
 * discover that. Past the cap the cascade REFUSES to expand rather than
 * deleting an arbitrary prefix: a partially deboosted post leaves exactly the
 * blank cards the expansion exists to prevent, and the operator needs to know
 * it happened. Reported through the residue log, which is the signal an
 * administrative reconciliation reads.
 */
const MAX_BOOST_CLOSURE = 500;

function idString(value: mongoose.Types.ObjectId | string): string {
  return String(value);
}

/** The AP identifiers a post can additionally be named by. */
function postUris(post: CascadedPostRow): string[] {
  return [post.federation?.activityId, post.federation?.url].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/**
 * Every boost of `seedIds`, transitively.
 *
 * Transitive because `boostOf` can name a boost: one level would leave a boost
 * of a boost pointing at a row this cascade removed, which is the same blank
 * card the expansion exists to prevent.
 *
 * Returns `null` when the closure exceeds {@link MAX_BOOST_CLOSURE} — see the
 * constant for why that is a refusal rather than a truncation.
 */
export async function collectBoostClosure(
  seedIds: readonly string[],
): Promise<CascadedPostRow[] | null> {
  const seen = new Set(seedIds);
  const found: CascadedPostRow[] = [];
  let frontier = [...seedIds];

  while (frontier.length > 0) {
    const next = await Post.find(
      { type: PostType.BOOST, boostOf: { $in: frontier } },
      BOOST_CLOSURE_PROJECTION,
    ).lean<CascadedPostRow[]>();

    frontier = [];
    for (const boost of next) {
      const id = idString(boost._id);
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(boost);
      if (found.length > MAX_BOOST_CLOSURE) return null;
      frontier.push(id);
    }
  }

  return found;
}

/** One reference deletion, named so a failure says which leg failed. */
interface CascadeLeg {
  reference: string;
  run: () => Promise<unknown>;
}

/**
 * Delete every reference this cascade claims, over the full target set.
 *
 * Runs the legs concurrently but reports each rejection with the leg's name.
 * The previous shape — `Promise.allSettled` whose result was discarded inside a
 * `try` that logged only if the wrapper itself threw — could not fail visibly:
 * `allSettled` never rejects, so a leg that threw was indistinguishable from one
 * that deleted nothing, which is how a cascade step that had never worked at all
 * survived unnoticed.
 */
async function runLegs(legs: readonly CascadeLeg[]): Promise<string[]> {
  const outcomes = await Promise.allSettled(legs.map((leg) => leg.run()));
  const failed: string[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status !== 'rejected') return;
    const { reference } = legs[index];
    failed.push(reference);
    logger.error('Post deletion cascade leg failed', {
      reference,
      error: outcome.reason,
    });
  });
  return failed;
}

/**
 * Restore the counters a deleted post contributed to on rows that SURVIVE it.
 *
 * Only two of a post's counters live somewhere else:
 *
 *  - a reply contributed 1 to its parent's `stats.commentsCount`. The canonical
 *    definition of that counter is `Post.countDocuments({ parentPostId })` —
 *    `recomputeFederatedEngagement`'s `computeRealCounts` is the reference — so a
 *    decrement is exactly its inverse.
 *  - a boost contributed 1 to its target's `stats.boostsCount` (and, when the
 *    boost arrived over ActivityPub, to `stats.federatedBoostsCount`).
 *
 * Both writes are guarded on `$gt: 0`, the same guard the unboost path and the
 * administrative purge use, so a counter that is already behind can never be
 * driven negative. It CAN still be driven low: `POST /posts` creates a reply
 * without incrementing the parent (only `POST /feed/reply` increments), so a
 * population of replies created through both routes decrements more often than
 * it incremented. That asymmetry is a creation-path bug and is deliberately not
 * papered over here — the decrement matches the canonical definition, and a
 * counter reconciliation is the thing that repairs drift in both directions.
 */
async function repairSurvivingCounters(
  post: CascadedPostRow,
  boosts: readonly CascadedPostRow[],
  removedIds: ReadonlySet<string>,
): Promise<CascadeLeg[]> {
  const legs: CascadeLeg[] = [];

  if (post.parentPostId && mongoose.isValidObjectId(post.parentPostId)) {
    const parentPostId = post.parentPostId;
    legs.push({
      reference: 'stats.commentsCount',
      run: () =>
        Post.updateOne(
          { _id: parentPostId, 'stats.commentsCount': { $gt: 0 } },
          { $inc: { 'stats.commentsCount': -1 } },
        ).exec(),
    });
  }

  // Only boosts whose TARGET survives this delete need a repair; a boost of the
  // deleted post is repairing a counter on a row that is already gone.
  const boostsToRepair = [post, ...boosts].filter(
    (row): row is CascadedPostRow & { boostOf: string } =>
      typeof row.boostOf === 'string' &&
      !removedIds.has(row.boostOf) &&
      mongoose.isValidObjectId(row.boostOf),
  );
  for (const boost of boostsToRepair) {
    const targetId = boost.boostOf;
    const federated = Boolean(boost.federation);
    legs.push({
      reference: 'stats.boostsCount',
      run: async () => {
        await Post.updateOne(
          { _id: targetId, 'stats.boostsCount': { $gt: 0 } },
          { $inc: { 'stats.boostsCount': -1 } },
        ).exec();
        if (federated) {
          await Post.updateOne(
            { _id: targetId, 'stats.federatedBoostsCount': { $gt: 0 } },
            { $inc: { 'stats.federatedBoostsCount': -1 } },
          ).exec();
        }
      },
    });
  }

  return legs;
}

/** The reference-deleting legs, over the whole target set. */
function referenceLegs(targets: readonly CascadedPostRow[]): CascadeLeg[] {
  const idStrings = [...new Set(targets.map((post) => idString(post._id)))];
  // `Like.postId`, `Bookmark.postId` and `Notification.entityId` are ObjectId
  // columns, so they are matched with real ObjectIds rather than left to
  // per-query casting.
  const objectIds = idStrings
    .filter((id) => mongoose.isValidObjectId(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  // Both keys a post can be named by: its id, and the AP identifiers a
  // federated post also travels under. The side tables are split between the
  // two exactly as the preflight's probes are.
  const postKeys = [...new Set([...idStrings, ...targets.flatMap(postUris)])];
  const pollIds = targets.flatMap((post) => (post.content?.pollId ? [post.content.pollId] : []));
  const articleIds = targets.flatMap((post) =>
    post.content?.article?.articleId ? [post.content.article.articleId] : [],
  );

  return [
    {
      // Both entity types the enum can hold for a post row. `'post'` alone
      // missed every reply notification — `PostCreationService` and the
      // ActivityPub inbox both write `entityType: 'reply'`.
      reference: 'Notification.entityId',
      run: () =>
        Notification.deleteMany({
          entityType: { $in: ['post', 'reply'] },
          entityId: { $in: objectIds },
        }).exec(),
    },
    {
      reference: 'Poll.postId',
      run: () =>
        Poll.deleteMany({
          $or: [
            { postId: { $in: [...objectIds, ...idStrings] } },
            ...(pollIds.length > 0 ? [{ _id: { $in: pollIds } }] : []),
          ],
        }).exec(),
    },
    {
      reference: 'Article.postId',
      run: () =>
        Article.deleteMany({
          $or: [
            { postId: { $in: idStrings } },
            ...(articleIds.length > 0 ? [{ _id: { $in: articleIds } }] : []),
          ],
        }).exec(),
    },
    {
      reference: 'Postgate.postId/postUri',
      run: () =>
        Postgate.deleteMany({
          $or: [{ postId: { $in: idStrings } }, { postUri: { $in: postKeys } }],
        }).exec(),
    },
    {
      reference: 'Threadgate.postId/postUri',
      run: () =>
        Threadgate.deleteMany({
          $or: [{ postId: { $in: idStrings } }, { postUri: { $in: postKeys } }],
        }).exec(),
    },
    {
      // `repairRecentRepliersAfterPostDelete` already removes the projections
      // for the seed post and the replies it deletes. This covers the rest of
      // the target set — a boost can be replied to, and so can carry one.
      reference: 'PostRecentReplier.postId',
      run: () => PostRecentReplier.deleteMany({ postId: { $in: idStrings } }).exec(),
    },
    {
      // `pending` only, never `processing`: a claimed row is being applied by a
      // worker right now, and pulling it out from under an open lease trades a
      // harmless no-op update for a real race.
      reference: 'EngagementOutbox.payload.postId(pending)',
      run: () =>
        EngagementOutbox.deleteMany({
          status: 'pending',
          'payload.postId': { $in: idStrings },
        }).exec(),
    },
    {
      reference: 'ContentLabel.targetId(post)',
      run: () =>
        ContentLabel.deleteMany({ targetType: 'post', targetId: { $in: idStrings } }).exec(),
    },
    {
      reference: 'FeedInteraction.postUri',
      run: () => FeedInteraction.deleteMany({ postUri: { $in: postKeys } }).exec(),
    },
    {
      // Cancels outbound work for a post we have just deleted — the
      // `Delete(Tombstone)` this route sends is what remote instances should
      // receive, not a queued `Create(Note)` for a post that no longer exists.
      reference: 'FederationDeliveryQueue.activityJson(pending)',
      run: () =>
        FederationDeliveryQueue.deleteMany({
          status: 'pending',
          $or: [
            { 'activityJson.id': { $in: postKeys } },
            { 'activityJson.object.id': { $in: postKeys } },
            { 'activityJson.object': { $in: postKeys } },
          ],
        }).exec(),
    },
    {
      reference: 'Like.postId',
      run: () => Like.deleteMany({ postId: { $in: objectIds } }).exec(),
    },
    {
      reference: 'Bookmark.postId',
      run: () => Bookmark.deleteMany({ postId: { $in: objectIds } }).exec(),
    },
  ];
}

/**
 * The reference legs alone, over MANY posts, for an ADMINISTRATIVE caller.
 *
 * WHY A SECOND ENTRY POINT EXISTS, RATHER THAN A FLAG ON THE FIRST.
 *
 * {@link cascadeDeletedPost} serves the LIVE delete route: one post, already
 * removed by the request that authorized it, and the user has been told the
 * delete succeeded. It must therefore never throw — a derived row that could not
 * be removed is not a reason to report a completed deletion as a failure — so it
 * swallows everything and states the residue in a log.
 *
 * An administrative cascade is the opposite case in both respects. It deletes
 * MANY posts, and it runs inside a job that can be re-run, so a leg that failed
 * MUST reach the caller: a BullMQ retry re-running the whole cascade is exactly
 * the recovery the live path does not have. Returning the failed leg NAMES is
 * what makes that possible without either caller inheriting the other's error
 * posture — a shared flag would put both postures in one function and let the
 * wrong one be selected by a default.
 *
 * Scope is deliberately narrow: the reference legs and nothing else. It does not
 * delete the `Post` rows (the caller owns which posts die and in what order), it
 * does not expand the boost closure (use {@link collectBoostClosure}), and it
 * does not repair counters (the surviving-row set depends on which posts the
 * caller is destroying, which only the caller knows). Duplicating any of those
 * here would put a second implementation beside the caller's.
 */
export async function cascadePostReferences(
  targets: readonly CascadedPostRow[],
): Promise<{ failedLegs: string[] }> {
  if (targets.length === 0) return { failedLegs: [] };
  return { failedLegs: await runLegs(referenceLegs(targets)) };
}

export interface PostDeletionCascadeInput {
  /** The post row, as returned by the delete that removed it. */
  post: CascadedPostRow;
  /**
   * Rows this request's caller has ALREADY deleted and whose references are
   * therefore this cascade's to clean — today the direct replies that
   * `repairRecentRepliersAfterPostDelete` removes inside its own transaction.
   * Captured BEFORE that delete, so a federated reply still carries the AP
   * identifiers half the side tables name it by.
   */
  alsoDeleted?: readonly CascadedPostRow[];
}

/**
 * Clean up after a post row that has already been removed.
 *
 * Ordering is deliberate. The seed post is gone before this runs — the route's
 * `findOneAndDelete` is what AUTHORIZES the delete and claims it against a
 * concurrent second request — so this cannot pretend to remove side tables
 * first. What it can do is remove the boost rows LAST, after their own
 * references are gone, so a run that dies midway leaves boosts pointing at
 * nothing rather than boost references pointing at nothing.
 *
 * Never throws: a delete the user asked for and the database performed must not
 * be reported as a failure because a derived row could not be removed. Every
 * failure is logged with the leg that produced it, and the residue check at the
 * end states what is actually still there.
 *
 * ## Dependents
 *
 * - **Boosts are deleted.** A `type:'boost'` post has an intentionally empty
 *   body and renders entirely from `boostOf`, so a boost outliving its original
 *   is not degraded content — it is a blank card. `adminDeletionPreflight`
 *   refuses to let any caller acknowledge `boostOf` away for this reason.
 * - **Quotes are NOT deleted.** A quote carries the quoter's own writing.
 *   `PostHydrationService` resolves `quotedPost` to null and drops the quote
 *   card, leaving the text its author wrote intact. Deleting it would destroy
 *   one person's content to remove another's.
 * - **Replies are not this function's decision.** Direct replies are already
 *   removed by `repairRecentRepliersAfterPostDelete`, inside the transaction
 *   that repairs the replier projection; the rows arrive here as
 *   `alsoDeleted` so that whatever that policy removes gets cleaned up. Deeper
 *   descendants are left standing and hydration tolerates the dangling
 *   `parentPostId`.
 */
export async function cascadeDeletedPost(input: PostDeletionCascadeInput): Promise<void> {
  const { post } = input;
  const seedId = idString(post._id);

  try {
    const seeds = [post, ...(input.alsoDeleted ?? [])];
    const boosts = await collectBoostClosure(seeds.map((row) => idString(row._id)));
    if (boosts === null) {
      logger.error('Post deletion cascade refused to expand an oversized boost closure', {
        postId: seedId,
        limit: MAX_BOOST_CLOSURE,
      });
      return;
    }

    const targets = [...seeds, ...boosts];
    const removedIds = new Set(targets.map((row) => idString(row._id)));

    const failed = await runLegs([
      ...(await repairSurvivingCounters(post, boosts, removedIds)),
      ...referenceLegs(targets),
    ]);

    // Boost ROWS last — see the ordering note above.
    if (boosts.length > 0) {
      await Post.deleteMany({
        _id: { $in: boosts.map((boost) => boost._id) },
      }).exec();
    }

    await reportResidue(targets, failed, seedId);
  } catch (error) {
    logger.error('Post deletion cascade failed', { postId: seedId, error });
  }
}

/**
 * Verify the claim rather than trusting it, using the same probes the
 * administrative purge is checked with — the end state, after the deletes, with
 * nothing acknowledged.
 */
async function reportResidue(
  targets: readonly CascadedPostRow[],
  failedLegs: readonly string[],
  postId: string,
): Promise<void> {
  const probeTargets: PostDeletionTarget[] = targets.map((row) => ({
    id: row._id,
    uris: postUris(row),
  }));
  const residue = await collectPostCascadeResidue(probeTargets, CASCADED_POST_REFERENCES);
  if (residue.length === 0 && failedLegs.length === 0) return;
  logger.error('Post deletion cascade left references behind', {
    postId,
    residue,
    failedLegs,
  });
}
