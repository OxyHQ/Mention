/**
 * Everything that has to happen when a `Post` row is deleted, for the LIVE
 * delete path — the route every user hits, not an administrative sweep.
 *
 * ## SEVEN references, not thirteen, and the boundary is the database's
 *
 * {@link PostReferenceProbeName} enumerates thirteen ways a row can name a
 * post. **Six of them are `ON DELETE CASCADE` on `posts.id`** — `polls`,
 * `articles`, `likes`, `bookmarks`, `post_recent_repliers` and
 * `engagement_outbox` (plus seven more child tables nothing probes) — so
 * Postgres removes them inside the same `DELETE` statement that removes the
 * post. Writing a leg for those would re-implement work the database has
 * already done, and it would be **permanently untestable**: the residue check
 * runs after the delete, when the rows are gone either way, so it cannot tell
 * "my leg ran" from "the FK ran". A leg nothing can ever prove ran is
 * indistinguishable from a leg that never worked.
 *
 * The seven that need explicit handling are exactly the shapes a foreign key
 * cannot express: polymorphic (`notifications.entity_id`,
 * `reports.reported_id`, `content_labels.target_id`), URI-keyed rather than
 * id-keyed (`feed_interactions.post_uri`), a JSON blob
 * (`federation_delivery_queue.activity_json`), and the two gate tables whose
 * `post_id` is plain `text()` because a gate is upserted on `post_uri` without
 * proving the post exists. **Do not "complete" this module by adding the six
 * back.**
 *
 * They are not claimed to the residue check either. Claiming them would make it
 * re-run six probes on a user-facing route to verify something the schema
 * guarantees structurally — and an FK that went missing is caught by the
 * schema/migration parity gate, which is where a schema regression belongs.
 * They are exported as {@link POST_REFERENCES_REMOVED_BY_DATABASE} so an
 * administrative caller can acknowledge them under a name that says who did it.
 *
 * ## `posts.boost_of` is a SELF-cascade, which is why the CAPTURE comes first
 *
 * Deleting a post deletes every boost of it, transitively, because a boost of a
 * boost cascades from the boost. That is main's whole `collectBoostClosure` /
 * `MAX_BOOST_CLOSURE` / "boost rows last" machinery performed by one statement,
 * so none of it is ported. But it means **the boost rows and their `boost_of`
 * links are gone before any leg here could run**, and those boosts carry
 * polymorphic references of their own with nothing left to find them by. The
 * caller therefore captures the closure BEFORE the delete; see
 * {@link collectDeletionTargets}.
 *
 * ## Two tiers: throw for the seven, COUNT for best-effort
 *
 * The seven legs run inside the caller's transaction, alongside the `DELETE`
 * itself, and they THROW. A leg that fails means a row survives that names a
 * post nobody can load — so the whole transaction rolls back, the post is NOT
 * deleted, and the 500 the caller answers with is honest and retryable. The
 * shape this replaces (swallow everything, log the residue) reported a
 * COMPLETED deletion whose leftovers no retry could ever reach.
 *
 * Best-effort work — the replier projection, the surviving-row counters, the
 * federation tombstone — runs OUTSIDE the transaction, still swallowed, but
 * every failure increments {@link POST_DELETION_SIDE_EFFECT_FAILED_METRIC}.
 * **Fail-soft is fine, silent is not.**
 */

import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { PostType } from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { deletePostRecord } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { notifications } from '../db/schema/discovery';
import { contentLabels } from '../db/schema/moderation';
import { postgates, threadgates } from '../db/schema/gates';
import { feedInteractions } from '../db/schema/feeds';
import { deletePendingDeliveriesReferencingObjects } from '../db/federation/deliveryQueueRepository';
import { logger } from '../utils/logger';
import { metrics } from '../utils/metrics';
import {
  collectPostCascadeResidue,
  type PostDeletionTarget,
  type PostReferenceProbeName,
} from '../scripts/lib/adminDeletionPreflight';

/**
 * Best-effort work after a COMMITTED deletion that did not complete.
 *
 * A counter rather than a log line alone, for the reason
 * `ACTOR_UPSERT_FAILED_METRIC` exists: a `warn` says one deletion had a rough
 * edge, and the thing anybody actually needs to know is whether this is
 * happening to EVERY deletion. The `step` label turns "something after the
 * delete is failing" into a name.
 */
export const POST_DELETION_SIDE_EFFECT_FAILED_METRIC = 'post_deletion_side_effect_failed_total';

/** What the live delete path does about one known kind of post reference. */
type ReferenceDisposition =
  /** An explicit leg in this module, inside the caller's transaction. */
  | 'cascade'
  /**
   * Removed by `ON DELETE CASCADE` on `posts.id`, in the same statement as the
   * post. No leg, and deliberately NOT claimed — see the module comment.
   */
  | 'database'
  /**
   * A durable queue whose PENDING rows are cancelled and whose completed rows
   * are kept. Not claimed to the residue check: the claim would be false, and a
   * false claim reported as satisfied is the exact failure this module exists to
   * remove.
   */
  | 'cancel-pending'
  /** Deliberately kept. Every entry carries its reason in the table below. */
  | 'retain';

/**
 * A `Record` over the probe list ON PURPOSE: adding a reference type upstream
 * breaks THIS file's build until somebody decides what the delete route should
 * do about it. That is the property a plain array of claimed names does not
 * have, and it is what makes the cascade fail closed on a reference nobody has
 * thought about yet rather than silently leaving it behind.
 */
const POST_REFERENCE_DISPOSITION: Record<PostReferenceProbeName, ReferenceDisposition> = {
  // Polymorphic by a type column, so no foreign key can carry them.
  'notifications.entity_id': 'cascade',
  'content_labels.target_id(post)': 'cascade',
  // `post_id` is plain `text()` — a gate is upserted on `post_uri` without
  // proving the post exists, so the column cannot be constrained.
  'postgates.post_id/post_uri': 'cascade',
  'threadgates.post_id/post_uri': 'cascade',
  // Keyed by the post's AP URI, which is not `posts.id`.
  'feed_interactions.post_uri': 'cascade',

  /**
   * `ON DELETE CASCADE` on `posts.id`. Read off `pg_constraint` on a fully
   * migrated database, not inferred from the schema source.
   */
  'polls.post_id': 'database',
  'articles.post_id': 'database',
  'likes.post_id': 'database',
  'bookmarks.post_id': 'database',
  'post_recent_repliers.post_id': 'database',
  'engagement_outbox.payload_post_id': 'database',

  /**
   * The one queue that is cancelled rather than erased.
   *
   * Only a PENDING row can still act — deliver an activity about a post that is
   * gone. A `delivered` or `failed` row is a log entry, and a user erasing their
   * own post does not get to erase the record that it was once sent. Cancelling
   * is also right on its own terms: the `Delete(Tombstone)` this route sends is
   * what remote instances should receive, not a queued `Create(Note)` for a
   * post that no longer exists.
   */
  'federation_delivery_queue.activity_json': 'cancel-pending',

  /**
   * RETAINED, and the one entry where deleting would BREAK something rather
   * than merely lose an audit trail.
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
   * different reason: it removes a blocked instance's content wholesale. A user
   * deleting their own post does not get to erase reports filed about it.
   */
  'reports.reported_id(post)': 'retain',
};

function referencesWithDisposition(
  disposition: ReferenceDisposition,
): readonly PostReferenceProbeName[] {
  return (Object.keys(POST_REFERENCE_DISPOSITION) as PostReferenceProbeName[]).filter(
    (name) => POST_REFERENCE_DISPOSITION[name] === disposition,
  );
}

/** The claim this cascade makes, in the shape the residue check verifies. */
export const CASCADED_POST_REFERENCES = referencesWithDisposition('cascade');

/**
 * The references `ON DELETE CASCADE` removes with the post row.
 *
 * Named separately from everything else so an administrative caller can
 * acknowledge them to `assertPostsSafeToDelete` while stating WHO removes them.
 * Folding them into the cascade's own claim would say this module deleted rows
 * it never touched; folding them into the kept list would say they survive.
 */
export const POST_REFERENCES_REMOVED_BY_DATABASE = referencesWithDisposition('database');

/**
 * The references this module deliberately does NOT remove — `retain` plus the
 * completed half of `cancel-pending`.
 *
 * Derived from the same `Record` rather than written out a second time, so a
 * disposition that changes moves both lists at once. Kept SEPARATE from the
 * cascade's claim because {@link collectPostCascadeResidue} re-runs exactly the
 * claimed probes to check them, and would report a deliberately retained
 * reference as a failure — the one confusion this module exists to remove.
 */
export const POST_REFERENCES_KEPT_BY_POLICY: readonly PostReferenceProbeName[] = [
  ...referencesWithDisposition('cancel-pending'),
  ...referencesWithDisposition('retain'),
];

/**
 * The fields the cascade reads off a post — every key it can be named BY.
 *
 * `boost_of`, a poll id and an article id are deliberately absent, where main's
 * Mongo shape carried all three: each is `ON DELETE CASCADE` on `posts.id`
 * here, so the row goes with the post, and a field carried for a leg that does
 * not exist is a field somebody will later write a leg for.
 */
export interface CascadedPostRow {
  id: string;
  oxyUserId?: string | null;
  parentPostId?: string | null;
  federationActivityId?: string | null;
  federationUrl?: string | null;
}

/** The columns {@link collectDeletionTargets} reads, as one reusable projection. */
const CASCADE_ROW_COLUMNS = {
  id: posts.id,
  oxyUserId: posts.oxyUserId,
  parentPostId: posts.parentPostId,
  federationActivityId: posts.federationActivityId,
  federationUrl: posts.federationUrl,
} as const;

/**
 * A hard cap on how many rows one delete may drag in.
 *
 * The closure is unbounded in principle — a widely boosted post has as many
 * boosts as it has boosters — and a live HTTP request is the wrong place to
 * discover that. It means something narrower here than it did on Mongo, and the
 * difference matters: Postgres deletes every boost whatever this says, because
 * the FK cascades. What the cap bounds is how many rows this module can CLEAN
 * UP AFTER. Past it the deletion is refused outright rather than committed
 * half-cleaned, and the operator is told.
 */
export const MAX_DELETION_TARGETS = 500;

/** The AP identifiers a post can additionally be named by. */
function postUris(post: CascadedPostRow): string[] {
  return [post.federationActivityId, post.federationUrl].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/** Raised when one deletion would drag in more rows than {@link MAX_DELETION_TARGETS}. */
export class PostDeletionTooLargeError extends Error {
  constructor(readonly found: number) {
    super(`Post deletion touches more than ${MAX_DELETION_TARGETS} rows`);
    this.name = 'PostDeletionTooLargeError';
  }
}

export interface PostDeletionTargets {
  /** The post itself, as it stands before the delete. */
  post: CascadedPostRow;
  /** Its direct replies — deleted with it, and NOT by any foreign key. */
  replies: CascadedPostRow[];
  /** Every boost of the post or of one of those replies, transitively. */
  boosts: CascadedPostRow[];
}

/** Every row one deletion removes, in one list. */
export function allDeletionTargets(targets: PostDeletionTargets): CascadedPostRow[] {
  return [targets.post, ...targets.replies, ...targets.boosts];
}

/**
 * Read everything one deletion will remove, WHILE THE LINKS ARE STILL LIVE.
 *
 * This must run before the `DELETE`, inside the same transaction, and both
 * halves of that are load-bearing:
 *
 * - `posts.parent_post_id` is `ON DELETE SET NULL`, so the moment the post is
 *   deleted its replies stop being findable and are silently PROMOTED to root
 *   posts. That is not hypothetical — it is what the live route did before this
 *   function existed.
 * - `posts.boost_of` is `ON DELETE CASCADE`, so the boosts are deleted with the
 *   post and their polymorphic references become unreachable.
 *
 * Same transaction, because a capture on one snapshot and a delete on another
 * lets a reply created in between survive its parent.
 */
export async function collectDeletionTargets(
  postId: string,
  tx: DatabaseOrTransaction,
): Promise<PostDeletionTargets | null> {
  const [post] = await tx.select(CASCADE_ROW_COLUMNS).from(posts).where(eq(posts.id, postId));
  if (!post) return null;

  const replies = await tx
    .select(CASCADE_ROW_COLUMNS)
    .from(posts)
    .where(eq(posts.parentPostId, postId))
    .limit(MAX_DELETION_TARGETS + 1);

  // Transitive, because `boost_of` can name a boost. One level would leave a
  // boost of a boost pointing at a row the FK removed — the same blank card the
  // expansion exists to prevent.
  const seeds = [post.id, ...replies.map((reply) => reply.id)];
  const seen = new Set(seeds);
  const boosts: CascadedPostRow[] = [];
  let frontier = seeds;

  while (frontier.length > 0) {
    if (seen.size > MAX_DELETION_TARGETS) throw new PostDeletionTooLargeError(seen.size);
    const next = await tx
      .select(CASCADE_ROW_COLUMNS)
      .from(posts)
      .where(and(eq(posts.type, PostType.BOOST), inArray(posts.boostOf, frontier)))
      .limit(MAX_DELETION_TARGETS + 1);

    frontier = [];
    for (const boost of next) {
      if (seen.has(boost.id)) continue;
      seen.add(boost.id);
      boosts.push(boost);
      frontier.push(boost.id);
    }
  }

  if (seen.size > MAX_DELETION_TARGETS) throw new PostDeletionTooLargeError(seen.size);
  return { post, replies, boosts };
}

/** One reference deletion, named so a failure says which leg failed. */
interface CascadeLeg {
  reference: PostReferenceProbeName;
  run: () => Promise<unknown>;
}

/**
 * The reference-deleting legs, over the whole target set.
 *
 * Every predicate here is the one the matching probe in
 * `adminDeletionPreflight` asks — `entity_type` on notifications,
 * `target_type` on content labels, both keys on the gate tables. Two copies of
 * a predicate is how a gate starts clearing rows its cascade does not remove.
 */
function referenceLegs(
  targets: readonly CascadedPostRow[],
  tx: DatabaseOrTransaction,
): CascadeLeg[] {
  const ids = [...new Set(targets.map((row) => row.id))];
  // Both keys a post can be named by: its id, and the AP identifiers a
  // federated post also travels under. Split between the two exactly as the
  // preflight's probes are.
  const postKeys = [...new Set([...ids, ...targets.flatMap(postUris)])];

  return [
    {
      // Both entity types the enum can hold for a post row. `'post'` alone
      // missed every reply notification — `PostCreationService` and the
      // ActivityPub inbox both write `entityType: 'reply'`.
      reference: 'notifications.entity_id',
      run: () =>
        tx
          .delete(notifications)
          .where(
            and(
              inArray(notifications.entityType, ['post', 'reply']),
              inArray(notifications.entityId, ids),
            ),
          ),
    },
    {
      reference: 'content_labels.target_id(post)',
      run: () =>
        tx
          .delete(contentLabels)
          .where(and(eq(contentLabels.targetType, 'post'), inArray(contentLabels.targetId, ids))),
    },
    {
      reference: 'postgates.post_id/post_uri',
      run: () =>
        tx
          .delete(postgates)
          .where(or(inArray(postgates.postId, ids), inArray(postgates.postUri, postKeys))),
    },
    {
      reference: 'threadgates.post_id/post_uri',
      run: () =>
        tx
          .delete(threadgates)
          .where(or(inArray(threadgates.postId, ids), inArray(threadgates.postUri, postKeys))),
    },
    {
      reference: 'feed_interactions.post_uri',
      run: () => tx.delete(feedInteractions).where(inArray(feedInteractions.postUri, postKeys)),
    },
    {
      reference: 'federation_delivery_queue.activity_json',
      run: () => deletePendingDeliveriesReferencingObjects(postKeys, tx),
    },
  ];
}

/**
 * Delete every reference this cascade handles, inside the caller's transaction.
 *
 * THROWS on the first leg that fails, naming it. That is the whole difference
 * from the shape this replaces: a `Promise.allSettled` whose result was
 * discarded could not fail visibly — it never rejects, so a leg that threw was
 * indistinguishable from one that deleted nothing, which is how a cascade step
 * that had never worked at all survived unnoticed.
 *
 * Sequential rather than concurrent: they share one transaction and therefore
 * one connection, so they serialise anyway, and running them in order means the
 * error names the FIRST leg that failed rather than an arbitrary one.
 */
export async function cascadePostReferences(
  targets: readonly CascadedPostRow[],
  tx: DatabaseOrTransaction,
): Promise<void> {
  if (targets.length === 0) return;
  for (const leg of referenceLegs(targets, tx)) {
    try {
      await leg.run();
    } catch (error) {
      logger.error('Post deletion cascade leg failed', { reference: leg.reference, error });
      throw error;
    }
  }
}

/**
 * A post deletion that COMMITTED, and everything the best-effort stage needs.
 *
 * `removedIds` is every row this transaction took — the post plus its boost
 * closure plus its replies — so a counter repair can tell "this author lost a
 * reply" from "this author's row is one of the ones that went".
 */
export interface DeletedPostSubtree {
  post: PostRecord;
  targets: PostDeletionTargets;
  removedIds: ReadonlySet<string>;
}

/**
 * DELETE A POST AND THE SUBTREE IT OWNS, IN ONE TRANSACTION — the single
 * implementation, because there are two callers and only one of them used to
 * have it.
 *
 * `deletePost` grew this ordering as the fix for a defect that shipped (#126);
 * `PostMaterializer.materializeTombstone` reached `deletePostRecord` directly
 * and therefore kept the defect, on a path the fix did not cover. The failure is
 * specific and silent: `posts.parent_post_id` is `ON DELETE SET NULL`, so
 * deleting the parent row alone leaves every direct reply alive with a null
 * parent and `is_reply: true` — a ROOT POST in every feed, written by somebody
 * who never posted it. Mongo deleted them, so the MIGRATION introduces this
 * rather than inheriting it.
 *
 * The ORDER inside the transaction is the fix and is not a preference:
 *
 *   1. CAPTURE the closure first. `posts.boost_of` is `ON DELETE CASCADE`, so
 *      the instant the post row goes, every boost of it is removed by the
 *      database along with the only link that could have found the boosts' own
 *      polymorphic references.
 *   2. The reference legs, which THROW — coherent only because they are in here
 *      with the `DELETE`. A leg that fails rolls the whole thing back, the post
 *      is NOT deleted, and the caller's 500 is honest and retryable.
 *   3. The replies, explicitly. No foreign key removes them, and after the post
 *      row goes there is nothing left to find them by.
 *   4. The post itself, claimed by `ownership` in the DELETE's own `WHERE`, so
 *      this is one statement that authorizes and removes rather than a read
 *      followed by a write.
 *
 * Returns `null` for BOTH "no such post" and "the ownership claim matched
 * nothing", which is what every caller wants: they answer 404 to each. The
 * second case ROLLS BACK — a plain return would commit the reference and reply
 * deletions for a post the caller was never allowed to delete, which is the
 * security-relevant half of the claim.
 *
 * Throws {@link PostDeletionTooLargeError} unchanged, so a caller can answer 409.
 *
 * Best-effort work — the replier projection, the surviving-row counters, the
 * federation tombstone — is deliberately NOT here: it runs after the commit, in
 * the caller, so a failure cannot turn a completed deletion into an error.
 */
export async function deletePostSubtree(
  postId: string,
  ownership: SQL | undefined,
): Promise<DeletedPostSubtree | null> {
  let result: DeletedPostSubtree | null = null;
  try {
    await getDb().transaction(async (tx) => {
      const collected = await collectDeletionTargets(postId, tx);
      if (!collected) return;

      const all = allDeletionTargets(collected);
      await cascadePostReferences(all, tx);

      if (collected.replies.length > 0) {
        await tx.delete(posts).where(inArray(posts.id, collected.replies.map((reply) => reply.id)));
      }

      const claimed = await deletePostRecord(postId, ownership, tx);
      if (!claimed) throw new PostDeletionClaimFailedError();

      result = { post: claimed, targets: collected, removedIds: new Set(all.map((row) => row.id)) };
    });
  } catch (error) {
    if (error instanceof PostDeletionClaimFailedError) return null;
    throw error;
  }
  return result;
}

/**
 * Internal only — the signal that rolls the transaction back when the ownership
 * claim matches no row. It never escapes {@link deletePostSubtree}, because a
 * caller cannot act on it differently from "no such post": both are 404, and
 * distinguishing them in a response would disclose that the post exists.
 */
class PostDeletionClaimFailedError extends Error {
  constructor() {
    super('Post deletion claim matched no row');
    this.name = 'PostDeletionClaimFailedError';
  }
}

/**
 * Record that a best-effort step after a COMMITTED deletion did not complete.
 *
 * The step keeps failing softly — the post is gone and the user was told so, and
 * a projection that could not be repaired is not a reason to report a completed
 * deletion as a failure. What changes is that it is now COUNTED.
 */
export function recordDeletionSideEffectFailure(step: string, error: unknown): void {
  metrics.incrementCounter(POST_DELETION_SIDE_EFFECT_FAILED_METRIC, 1, { step });
  logger.error('Post deletion side effect failed', { step, error });
}

/**
 * Restore the counters a deleted post contributed to on a row that SURVIVES it.
 *
 * Best-effort by nature: it runs after the commit, so a failure cannot undo
 * anything, and a counter is repairable by reconciliation where a lost deletion
 * is not.
 *
 * Only ONE counter can need repairing here, and the reason the boost counter
 * does not is structural rather than an omission. Every boost this deletion
 * removes boosted something inside the removed set BY CONSTRUCTION — the
 * closure is seeded from that set and expanded along `boost_of` — so its
 * target's `stats_boosts_count` is a counter on a row that is already gone.
 * What remains is the reply's contribution to its parent's
 * `stats_comments_count`, when that parent is not itself being deleted.
 *
 * Guarded on `> 0`, the same guard the unboost path and the administrative
 * purge use, so a counter already behind can never be driven negative.
 */
export async function repairSurvivingCounters(
  targets: PostDeletionTargets,
  removedIds: ReadonlySet<string>,
): Promise<void> {
  const parentPostId = targets.post.parentPostId;
  if (!parentPostId || removedIds.has(parentPostId)) return;

  await getDb()
    .update(posts)
    .set({ statsCommentsCount: sql`${posts.statsCommentsCount} - 1` })
    .where(and(eq(posts.id, parentPostId), sql`${posts.statsCommentsCount} > 0`));
}

/**
 * Verify the claim rather than trusting it, using the same probes the
 * administrative purge is checked with — the end state, with nothing
 * acknowledged.
 *
 * Runs OUTSIDE the transaction on purpose. Inside it, the probes would read the
 * transaction's own uncommitted deletes and pass by construction, which is a
 * check that cannot fail.
 */
export async function reportResidue(
  targets: readonly CascadedPostRow[],
  postId: string,
): Promise<void> {
  const probeTargets: PostDeletionTarget[] = targets.map((row) => ({
    id: row.id,
    uris: postUris(row),
  }));
  const residue = await collectPostCascadeResidue(probeTargets, CASCADED_POST_REFERENCES);
  if (residue.length === 0) return;
  logger.error('Post deletion cascade left references behind', { postId, residue });
}
