/**
 * Executes {@link CHANNEL_CASCADE} — the destruction of one channel account's
 * content, and of every row in Mention's own database that points at it.
 *
 * WHAT THIS IS NOT
 *
 * It does not delete the Oxy account, its membership rows, its follow edges or
 * its uploaded bytes; those live on the far side of the Oxy boundary and are
 * enumerated in `OWNED_BY_OXY` rather than silently omitted.
 *
 * IT REFUSES ANYTHING THAT IS NOT A CHANNEL
 *
 * The account `kind` is resolved here, at the top of both entry points, before a
 * single post is read — see {@link NotAChannelAccountError}. It used to be the
 * caller's job, on the reasoning that no route calls this yet; the absence of a
 * route is the absence of an accident, not a defence, and pointing this at a
 * personal account destroys a person's writing irreversibly. An unresolvable kind
 * is a refusal too: `resolveAccountKind` is fail-soft to `null` by design and
 * leaves the decision to its caller, and the two directions here are not
 * comparable — refusing delays an administrative action, allowing may destroy the
 * wrong account's posts.
 *
 * ## THE CASCADE IS SMALLER THAN THE MANIFEST, AND THAT IS THE POINT
 *
 * Eighteen manifest entries are performed by POSTGRES: thirteen child tables of
 * `posts` are `ON DELETE CASCADE`, `posts.boost_of` is a SELF-cascade, and
 * `quote_of` / `parent_post_id` / `thread_id` / `lane_id` are
 * `ON DELETE SET NULL`. **There is no leg here for any of them, deliberately.** A
 * leg would re-implement work the `DELETE` statement has already done, and it
 * would be PERMANENTLY UNTESTABLE: every residue check runs after the delete,
 * when the rows are gone either way, so nothing could ever tell "my leg ran" from
 * "the FK ran". A leg nobody can prove ran is indistinguishable from a leg that
 * never worked. Do not "complete" this module by adding them back — the same
 * boundary `services/PostDeletionCascade.ts` states for the live delete route.
 *
 * What is left is everything a foreign key cannot express, and that is almost
 * entirely **rows keyed on an Oxy ACCOUNT id**: Oxy owns identity, so every
 * `oxy_user_id` / `user_id` / `actor_id` / `owner_oxy_user_id` is a foreign
 * service's primary key in a plain `text()` column with no constraint. Postgres
 * cascades none of it, so every channel-account-scoped step is a real leg.
 *
 * ## `posts.boost_of` CASCADES, SO THE CAPTURE COMES FIRST
 *
 * Deleting a channel post deletes every boost of it, transitively, inside the
 * same statement — which is main's whole `collectBoostClosure` / `MAX_BOOST_CLOSURE`
 * / "boost rows last" machinery performed by one constraint. But it means the
 * boost rows and their `boost_of` links are gone before any later step could run,
 * and those boosts carry POLYMORPHIC references of their own (a notification, a
 * content label, a postgate, a feed interaction) with nothing left to find them
 * by. So each batch captures its boost closure BEFORE the delete, while the links
 * are still live, and hands the whole set to the delegate.
 *
 * ## THE MANIFEST IS THE PROGRAM
 *
 * Every write below is driven by an entry in `CHANNEL_CASCADE`. Nothing is
 * deleted that the manifest does not name, and every manifest entry is accounted
 * for in the result — under `steps` with a count when this service performs the
 * write, under `delegated` when `PostDeletionCascade` owns the disposition, under
 * `performedByDatabase` when a constraint does it, and under `retained` when the
 * row is deliberately kept. `__tests__/services/channelDeletionService.test.ts`
 * asserts that the four key sets are disjoint and that their union is EXACTLY the
 * manifest's, so a step that stops executing disappears from all four and fails
 * the build rather than silently leaving rows behind. The three non-executing
 * accounts carry no count on purpose: a fabricated `0` is indistinguishable from
 * a step that never ran, which is the failure this binding exists to catch. Do
 * not pre-seed `steps` from the manifest either — that satisfies the assertion
 * while executing nothing.
 *
 * ## BATCHED, AND THEREFORE NEVER REFUSED FOR SIZE
 *
 * A channel is a publication and its archive is unbounded, so the posts are taken
 * in keyset batches rather than materialised whole. The Mongo shape refused past
 * a boost-closure cap; that refusal was correct there and would be a cascade
 * nobody could run here, because the bound would have to cover a whole archive
 * rather than one post's boosts. The keyset advances on `posts.id`, so a re-run
 * after a partial failure simply re-walks from the start over what survived.
 *
 * ## RETRY CONTRACT
 *
 * Per-step failures are collected, every remaining step still runs, and the call
 * THROWS at the end — the `sharingCleanup.service.ts` throw-on-partial shape, so
 * a BullMQ worker or an operator retries against whatever survived. Every step is
 * idempotent, so a re-run converges: a second pass over an already-deleted channel
 * returns all-zero counts and does not throw.
 */

import { and, count, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { AccountKind } from '@oxyhq/contracts';
import { PostVisibility } from '@mention/shared-types';
import { CHANNEL_CASCADE, type CascadeStep } from './channelCascadeManifest';

import { getDb } from '../../db/postgres';
import { qualified } from '../../db/casing';
import { posts } from '../../db/schema/posts';
import { postAuthorships, postMentions, postRecentRepliers } from '../../db/schema/postContent';
import { articles } from '../../db/schema/articles';
import { polls, pollVotes } from '../../db/schema/polls';
import { postgates, threadgates } from '../../db/schema/gates';
import {
  authorFollowerSnapshots,
  notifications,
  pushTokens,
  trending,
} from '../../db/schema/discovery';
import {
  bookmarks,
  entityFollows,
  likes,
  muteWords,
  mutes,
  pokes,
  postSubscriptions,
} from '../../db/schema/engagement';
import {
  customFeedMembers,
  customFeeds,
  feedGenerators,
  feedInteractions,
  feedLikes,
  feedReviews,
  userFeedPreferences,
} from '../../db/schema/feeds';
import { accountListMembers, accountLists, starterPackMembers, starterPackUses, starterPacks } from '../../db/schema/lists';
import { contentLabels, labelers, moderationEnforcements, reports } from '../../db/schema/moderation';
import { endorsementOutbox, engagementOutbox } from '../../db/schema/outbox';
import { repairFetchFailures } from '../../db/schema/adminScripts';
import { lanes, laneMutes } from '../../db/schema/channels';
import { actorKeyPairs, federatedActors, federatedFollows, federationDeliveryQueue } from '../../db/schema/federation';
import { mcpAuthCodes, mcpConnections } from '../../db/schema/mcp';
import {
  mentionNodeIngestWitnesses,
  mentionRepoHeads,
  mentionSignedRecords,
  mentionUserNodes,
} from '../../db/schema/mtn';
import { userBehaviorAuthors, userBehaviors, userSettings } from '../../db/schema/userProfile';

import {
  assertPostsSafeToDelete,
  collectPostCascadeResidue,
  type PostDeletionTarget,
  type PostReferenceProbeName,
} from '../../scripts/lib/adminDeletionPreflight';
import {
  CASCADED_POST_REFERENCES,
  POST_REFERENCES_KEPT_BY_POLICY,
  POST_REFERENCES_REMOVED_BY_DATABASE,
  cascadePostReferences,
  type CascadedPostRow,
} from '../PostDeletionCascade';
import { resolveAccountKind } from '../publishAsAccount';
import { followService } from '../../connectors/activitypub/follow.service';
import { deliveryService } from '../../connectors/activitypub/delivery.service';
import { actorUrl } from '../../connectors/activitypub/constants';
import { AP_CONTEXT } from '@oxyhq/federation';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';

const LOG_PREFIX = '[ChannelDeletion]';

/**
 * How many of the channel's own posts one batch takes.
 *
 * Bounds three things at once: the `IN` list every post-scoped leg builds, the
 * size of one transaction, and the memory the boost closure can reach. It is not
 * a limit on how much can be deleted — the loop runs until the channel has no
 * posts left — so there is no size at which an operator has to intervene.
 */
const POST_BATCH_SIZE = 200;

/**
 * How far one batch's boost closure may expand before the run is REFUSED.
 *
 * The closure is unbounded in principle: a widely boosted post has as many boosts
 * as it has boosters. Past this the batch is refused rather than committed
 * half-captured, because a partially captured closure means boost rows the
 * database deletes whose polymorphic references nothing was left to find — the
 * exact orphan the capture exists to prevent. An operator hears about it; a
 * silent truncation would not be a smaller version of this, it would be the bug.
 */
const MAX_BOOST_CLOSURE_PER_BATCH = 5_000;

/**
 * What this cascade tells the preflight about the post references it does not
 * have to prove absent, in the three shapes the gate distinguishes.
 *
 * All three are DERIVED from `POST_REFERENCE_DISPOSITION` rather than restated,
 * because the disposition of a post reference is that table's decision and a copy
 * here would be free to disagree with the code that actually runs. They are typed
 * `PostReferenceProbeName[]`, so a probe renamed or added upstream breaks this
 * build instead of being silently acknowledged.
 *
 *  - {@link CASCADED_POST_REFERENCES} is a CLAIM that the delegate's legs removed
 *    the rows.
 *  - {@link POST_REFERENCES_REMOVED_BY_DATABASE} is the same claim made about the
 *    `ON DELETE CASCADE` constraints, under a name that says who did it. Folding
 *    it into the list above would say this module deleted rows it never touched.
 *  - {@link POST_REFERENCES_KEPT_BY_POLICY} is a decision that they STAY — the
 *    retained `reports.reported_id(post)` and the delivery queue whose live
 *    backlog is cancelled while its completed rows remain as a log. Declaring it
 *    as a claim instead would make the residue check report every one of them as a
 *    cascade leg that had stopped working.
 */
const REMOVED_BEFORE_THE_POSTS: readonly PostReferenceProbeName[] = CASCADED_POST_REFERENCES;
const REMOVED_BY_DATABASE: readonly PostReferenceProbeName[] = POST_REFERENCES_REMOVED_BY_DATABASE;
const KEPT_BY_POLICY: readonly PostReferenceProbeName[] = POST_REFERENCES_KEPT_BY_POLICY;

/**
 * What the residue check re-runs after a batch is gone.
 *
 * BOTH claims, not just the delegate's. `PostDeletionCascade` deliberately omits
 * the database-removed half on the live delete route, because re-running six
 * probes on every user-facing delete to verify something the schema guarantees
 * structurally is a cost nobody is buying anything with. An administrative
 * one-shot is the other case: the probes are cheap here, and they check the END
 * STATE — "no row references these posts" — rather than crediting a leg with
 * having run. That distinction is what keeps it from being the untestable-leg
 * mistake in a different costume.
 */
const RESIDUE_CLAIM: readonly PostReferenceProbeName[] = [
  ...REMOVED_BEFORE_THE_POSTS,
  ...REMOVED_BY_DATABASE,
];

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/** The columns the delegate reads off a post, plus the two only this cascade needs. */
const CASCADE_ROW_COLUMNS = {
  id: posts.id,
  oxyUserId: posts.oxyUserId,
  parentPostId: posts.parentPostId,
  federationActivityId: posts.federationActivityId,
  federationUrl: posts.federationUrl,
} as const;

/** A channel post, plus what decides whether a remote server was ever told about it. */
const CHANNEL_ROW_COLUMNS = {
  ...CASCADE_ROW_COLUMNS,
  visibility: posts.visibility,
  status: posts.status,
  boostOf: posts.boostOf,
  writtenByOxyUserId: posts.writtenByOxyUserId,
} as const;

/**
 * A post belongs to the channel by the denormalized owner cache OR by its
 * authorship owner entry.
 *
 * The two are kept in sync by the write path, but a cascade is the wrong place to
 * depend on that having held for every row — and unlike Mongo's `$elemMatch` this
 * is a real join, so the authorship half costs an index lookup rather than a
 * document scan.
 */
function ownedByChannel(channelOxyUserId: string): SQL {
  const byAuthorship = sql`exists (select 1 from ${postAuthorships} where ${qualified(postAuthorships.postId)} = ${qualified(posts.id)} and ${qualified(postAuthorships.oxyUserId)} = ${channelOxyUserId} and ${qualified(postAuthorships.role)} = 'owner')`;
  return sql`(${eq(posts.oxyUserId, channelOxyUserId)} or ${byAuthorship})`;
}

/** The AP identifiers a post additionally travels under. */
function postUris(row: Pick<CascadedPostRow, 'federationActivityId' | 'federationUrl'>): string[] {
  return [row.federationActivityId, row.federationUrl].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

/** Raised when one batch's boost closure exceeds {@link MAX_BOOST_CLOSURE_PER_BATCH}. */
export class ChannelBoostClosureTooLargeError extends Error {
  constructor(
    readonly channelOxyUserId: string,
    readonly found: number,
  ) {
    super(
      `${LOG_PREFIX} refused to expand the boost closure for ${channelOxyUserId}: one batch reaches ` +
        `more than ${MAX_BOOST_CLOSURE_PER_BATCH} boosts. Capturing a prefix of it would leave boost ` +
        'rows the database deletes whose own references nothing could find, so this needs an operator ' +
        'rather than a retry.',
    );
    this.name = 'ChannelBoostClosureTooLargeError';
  }
}

/** One batch of the channel's posts, and every boost that dies with them. */
interface PostBatch {
  /** The channel's own posts in this batch, in keyset order. */
  readonly channelPosts: readonly ChannelPostRow[];
  /** Other people's boosts of them, transitively, captured while the links are live. */
  readonly boosts: readonly CascadedPostRow[];
  /** Both, in the shape the delegate and the preflight read. */
  readonly rows: readonly CascadedPostRow[];
  /** The keyset position to resume from. */
  readonly lastId: string;
}

interface ChannelPostRow extends CascadedPostRow {
  visibility: string;
  status: string;
  boostOf: string | null;
  writtenByOxyUserId: string | null;
}

/** Everything the account-scoped steps filter on, resolved once, read-only. */
interface DeletionTargets {
  readonly channelOxyUserId: string;
  /** Remote inboxes a `Delete(actor)` would reach. */
  readonly federatedFollowers: number;
  /** The channel's own posts. */
  readonly posts: number;
  /** Other people's boosts of them. */
  readonly boostsByOthers: number;
  /** Other people's replies into the set — expected to be 0. */
  readonly repliesByOthers: number;
  /** Other people's quotes of a doomed post; kept, pointer cleared by the FK. */
  readonly quotesByOthersKept: number;
}

/**
 * Read the channel's next batch of posts and the boost closure that dies with
 * them.
 *
 * The closure is expanded TRANSITIVELY, because `boost_of` can name a boost and a
 * boost of a boost is still a card with nothing behind it — the database removes
 * it either way, which is exactly why it must be captured.
 */
async function readPostBatch(
  channelOxyUserId: string,
  after: string | null,
): Promise<PostBatch | null> {
  const db = getDb();
  const channelPosts = await db
    .select(CHANNEL_ROW_COLUMNS)
    .from(posts)
    .where(after === null ? ownedByChannel(channelOxyUserId) : and(ownedByChannel(channelOxyUserId), gt(posts.id, after)))
    .orderBy(posts.id)
    .limit(POST_BATCH_SIZE);

  if (channelPosts.length === 0) return null;

  const seen = new Set(channelPosts.map((row) => row.id));
  const boosts: CascadedPostRow[] = [];
  let frontier = [...seen];

  while (frontier.length > 0) {
    const next = await db
      .select(CASCADE_ROW_COLUMNS)
      .from(posts)
      .where(inArray(posts.boostOf, frontier))
      .limit(MAX_BOOST_CLOSURE_PER_BATCH + 1);

    frontier = [];
    for (const boost of next) {
      if (seen.has(boost.id)) continue;
      seen.add(boost.id);
      boosts.push(boost);
      frontier.push(boost.id);
    }
    if (boosts.length > MAX_BOOST_CLOSURE_PER_BATCH) {
      throw new ChannelBoostClosureTooLargeError(channelOxyUserId, boosts.length);
    }
  }

  return {
    channelPosts,
    boosts,
    rows: [...channelPosts, ...boosts],
    lastId: channelPosts[channelPosts.length - 1].id,
  };
}

/** The preflight's view of a captured batch. */
function deletionTargetsOf(rows: readonly CascadedPostRow[]): PostDeletionTarget[] {
  return rows.map((row) => ({ id: row.id, uris: postUris(row) }));
}

/** Every key a batch's posts can be named by: their ids plus their AP identifiers. */
function postKeysOf(rows: readonly CascadedPostRow[]): string[] {
  return [...new Set([...rows.map((row) => row.id), ...rows.flatMap(postUris)])];
}

/**
 * Read the account-scoped id sets and the counts a preview states. Strictly
 * read-only, so {@link previewChannelDeletion} and the dry run share it unchanged.
 */
async function resolveDeletionTargets(channelOxyUserId: string): Promise<DeletionTargets> {
  const db = getDb();
  const owned = ownedByChannel(channelOxyUserId);
  const channelPostIds = db.select({ id: posts.id }).from(posts).where(owned);

  const [[postCount], [boostCount], [replyCount], [quoteCount], [followerCount]] =
    await Promise.all([
      db.select({ n: count() }).from(posts).where(owned),
      // Boosts of a channel post that are NOT themselves the channel's — the rows
      // the FK destroys alongside, which is what a person confirming needs told.
      db
        .select({ n: count() })
        .from(posts)
        .where(and(inArray(posts.boostOf, channelPostIds), sql`not (${owned})`)),
      db
        .select({ n: count() })
        .from(posts)
        .where(and(inArray(posts.parentPostId, channelPostIds), sql`not (${owned})`)),
      db
        .select({ n: count() })
        .from(posts)
        .where(and(inArray(posts.quoteOf, channelPostIds), sql`not (${owned})`)),
      db
        .select({ n: count() })
        .from(federatedFollows)
        .where(
          and(
            eq(federatedFollows.localUserId, channelOxyUserId),
            eq(federatedFollows.direction, 'inbound'),
            eq(federatedFollows.status, 'accepted'),
          ),
        ),
    ]);

  return {
    channelOxyUserId,
    federatedFollowers: followerCount.n,
    posts: postCount.n,
    boostsByOthers: boostCount.n,
    repliesByOthers: replyCount.n,
    quotesByOthersKept: quoteCount.n,
  };
}

// ---------------------------------------------------------------------------
// The step → Postgres binding table
// ---------------------------------------------------------------------------

/**
 * The order the phases run in, and what a crash inside each one leaves behind.
 * Each name is what the executor groups manifest steps by.
 */
type CascadePhase =
  /** Undelivered outbound activities from the channel. */
  | 'federation-drain'
  /** Rows keyed on the channel's lanes. */
  | 'lanes'
  /** Rows keyed on the channel account. */
  | 'account';

/** A manifest step whose disposition belongs to `services/PostDeletionCascade.ts`. */
interface DelegatedBinding {
  readonly delegated: true;
  /**
   * The reference the delegate covers, typed `PostReferenceProbeName` so the
   * COMPILER holds the two files together: a probe renamed upstream breaks this
   * build rather than leaving a step delegated to a leg that no longer exists. It
   * is documentation with a gate on it, not a lookup key — the delegate is handed
   * the whole doomed set once and decides its own legs.
   */
  readonly leg: PostReferenceProbeName;
}

/** A manifest step the post-batch loop performs, because it is scoped to a batch. */
interface InBatchBinding {
  readonly inBatch: true;
  /** Rows affected — counted in a dry run, written in a live one. */
  readonly run: (batch: PostBatch, dryRun: boolean) => Promise<number>;
}

/** An ordinary account- or lane-scoped step. */
interface LocalStepBinding {
  readonly phase: CascadePhase;
  /**
   * Tiebreaker WITHIN a phase; steps otherwise run in manifest order. Only the
   * lane rows need it, and the reason is on that entry.
   */
  readonly order?: number;
  readonly table: PgTable;
  /** The rows this step affects. `undefined` means "no targets", so nothing runs. */
  readonly where: (targets: DeletionTargets) => SQL | undefined;
  /**
   * The live write. Absent means a plain `DELETE` of the matched rows, which is
   * every `delete-row` and `delete-entry` step; the array and pointer steps supply
   * their own `UPDATE` because the column is not interchangeable between them.
   */
  readonly update?: (targets: DeletionTargets, where: SQL) => Promise<number>;
}

type StepBinding = DelegatedBinding | InBatchBinding | LocalStepBinding;

function isDelegated(binding: StepBinding): binding is DelegatedBinding {
  return 'delegated' in binding;
}

function isInBatch(binding: StepBinding): binding is InBatchBinding {
  return 'inBatch' in binding;
}

/** A manifest entry's identity. `notifications.entityId` appears under two scopes. */
function bindingKey(step: CascadeStep): string {
  return `${step.table}.${step.column}|${step.scope}`;
}

/** The key a step reports its count under. The two-scope columns share one. */
function stepKey(step: CascadeStep): string {
  return `${step.table}.${step.column}`;
}

/** `column = <the channel's own id>`. */
function accountEq(column: PgColumn) {
  return (targets: DeletionTargets): SQL => eq(column, targets.channelOxyUserId);
}

/**
 * Remove ONE value from an array column, keeping the row.
 *
 * `array_remove` rather than a read-modify-write: it is a single statement, so two
 * concurrent cascades cannot lose each other's edit, and it is idempotent — a
 * re-run over a row that no longer contains the value modifies nothing.
 */
function pullValue(column: PgColumn, targets: DeletionTargets): SQL {
  return sql`array_remove(${column}, ${targets.channelOxyUserId})`;
}

/** Rows whose array column still contains the channel. */
function arrayContainsAccount(column: PgColumn) {
  return (targets: DeletionTargets): SQL =>
    sql`${column} && ${sql.param([targets.channelOxyUserId])}::text[]`;
}

/**
 * The ONE place a manifest step's Postgres shape is written down: which table,
 * which phase, and — where the step is not a plain delete — exactly how.
 *
 * Kept in manifest order so the two files diff against each other, and because
 * within a phase the executor runs steps in that order.
 *
 * A manifest step whose action is `'database'` has NO entry here, on purpose: it
 * is performed by a constraint, and a binding for it would be a query that
 * re-runs the `DELETE`'s own work and could never be shown to have run. A step
 * whose action is `'retain'` has none either — a binding for one would be a query
 * nobody may run.
 */
const STEP_BINDINGS: Readonly<Record<string, StepBinding>> = {
  // --- Post references no foreign key can express, DELEGATED ------------------
  // `PostDeletionCascade.cascadePostReferences` is the live delete route's own
  // implementation of these dispositions, and its `POST_REFERENCE_DISPOSITION` is
  // a `Record` over the preflight's probe list — so a reference type added
  // upstream breaks ITS build until somebody decides. A second copy here would
  // destroy that property.
  'notifications.entityId|channel-posts': { delegated: true, leg: 'notifications.entity_id' },
  'content_labels.targetId|channel-posts': {
    delegated: true,
    leg: 'content_labels.target_id(post)',
  },
  'postgates.postId|channel-posts': { delegated: true, leg: 'postgates.post_id/post_uri' },
  'postgates.postUri|channel-post-uris': { delegated: true, leg: 'postgates.post_id/post_uri' },
  'threadgates.postId|channel-posts': { delegated: true, leg: 'threadgates.post_id/post_uri' },
  'threadgates.postUri|channel-post-uris': {
    delegated: true,
    leg: 'threadgates.post_id/post_uri',
  },
  'feed_interactions.postUri|channel-post-uris': {
    delegated: true,
    leg: 'feed_interactions.post_uri',
  },

  // --- Post references executed by the batch loop -----------------------------
  // Scoped to the batch's captured id set, so they cannot be ordinary phase steps
  // — the ids only exist inside the loop, and only until the `DELETE`.
  'moderation_enforcements.subjectId|channel-posts': {
    inBatch: true,
    run: (batch, dryRun) =>
      countOrDelete(
        moderationEnforcements,
        sql`${eq(moderationEnforcements.subjectType, 'post')} and ${inArray(
          moderationEnforcements.subjectId,
          batch.rows.map((row) => row.id),
        )}`,
        dryRun,
      ),
  },
  'repair_fetch_failures.postId|channel-posts': {
    inBatch: true,
    run: (batch, dryRun) =>
      countOrDelete(
        repairFetchFailures,
        inArray(repairFetchFailures.postId, batch.rows.map((row) => row.id)),
        dryRun,
      ),
  },
  // Somebody else's postgate listing a doomed post among its detached quotes: the
  // row is theirs and stays, only the entry goes. NOT delegated — the delegate
  // deletes the postgate rows that BELONG to a doomed post, which is a different
  // question from an entry naming one inside a stranger's row.
  'postgates.detachedQuoteUris|channel-post-uris': {
    inBatch: true,
    run: async (batch, dryRun) => {
      const keys = postKeysOf(batch.rows);
      const where = sql`${postgates.detachedQuoteUris} && ${sql.param(keys)}::text[]`;
      if (dryRun) return countRows(postgates, where);
      const changed = await getDb()
        .update(postgates)
        .set({
          detachedQuoteUris: sql`(select coalesce(array_agg(elem), '{}'::text[]) from unnest(${qualified(postgates.detachedQuoteUris)}) as elem where elem <> all(${sql.param(keys)}::text[]))`,
        })
        .where(where)
        .returning({ id: postgates.id });
      return changed.length;
    },
  },

  // --- The channel's own posts -----------------------------------------------
  // Both are performed by the batch loop's own `DELETE`, which is what fires every
  // `ON DELETE CASCADE` above it. `writtenByOxyUserId` is counted BEFORE that
  // statement, because afterwards there is nothing left to count — and the number
  // means something on its own: how many of the channel's posts had a human behind
  // them. It is never used to reattribute one.
  'posts.oxyUserId|channel-account': {
    inBatch: true,
    run: (batch, dryRun) => deleteBatchPosts(batch, dryRun),
  },
  'posts.writtenByOxyUserId|channel-posts': {
    inBatch: true,
    run: (batch) =>
      Promise.resolve(batch.channelPosts.filter((row) => row.writtenByOxyUserId != null).length),
  },
  'post_authorships.oxyUserId|channel-account': {
    phase: 'account',
    table: postAuthorships,
    where: accountEq(postAuthorships.oxyUserId),
  },
  'post_mentions.oxyUserId|channel-account': {
    phase: 'account',
    table: postMentions,
    where: accountEq(postMentions.oxyUserId),
  },

  // --- Lanes -----------------------------------------------------------------
  // The lanes go LAST in their phase, so the mutes keyed on the publisher have
  // already been swept by the time the row that cascades the rest disappears.
  'lanes.ownerId|channel-account': {
    phase: 'lanes',
    order: 1,
    table: lanes,
    where: accountEq(lanes.ownerId),
  },
  'lane_mutes.laneOwnerOxyUserId|channel-account': {
    phase: 'lanes',
    order: 0,
    table: laneMutes,
    where: accountEq(laneMutes.laneOwnerOxyUserId),
  },
  'lane_mutes.viewerOxyUserId|channel-account': {
    phase: 'lanes',
    order: 0,
    table: laneMutes,
    where: accountEq(laneMutes.viewerOxyUserId),
  },

  // --- Federation ------------------------------------------------------------
  'federation_delivery_queue.senderOxyUserId|channel-account': {
    phase: 'federation-drain',
    table: federationDeliveryQueue,
    where: accountEq(federationDeliveryQueue.senderOxyUserId),
  },
  'federated_follows.localUserId|channel-account': {
    phase: 'account',
    table: federatedFollows,
    where: accountEq(federatedFollows.localUserId),
  },
  'actor_key_pairs.oxyUserId|channel-account': {
    phase: 'account',
    table: actorKeyPairs,
    where: accountEq(actorKeyPairs.oxyUserId),
  },
  'federated_actors.oxyUserId|channel-account': {
    phase: 'account',
    table: federatedActors,
    where: accountEq(federatedActors.oxyUserId),
  },

  // --- Rows keyed on the channel ACCOUNT -------------------------------------
  'notifications.entityId|channel-account': {
    phase: 'account',
    table: notifications,
    where: (targets) =>
      and(
        eq(notifications.entityType, 'profile'),
        eq(notifications.entityId, targets.channelOxyUserId),
      ),
  },
  'notifications.recipientId|channel-account': {
    phase: 'account',
    table: notifications,
    where: accountEq(notifications.recipientId),
  },
  'notifications.actorId|channel-account': {
    phase: 'account',
    table: notifications,
    where: accountEq(notifications.actorId),
  },
  'content_labels.targetId|channel-account': {
    phase: 'account',
    table: contentLabels,
    where: (targets) =>
      and(eq(contentLabels.targetType, 'user'), eq(contentLabels.targetId, targets.channelOxyUserId)),
  },
  'content_labels.createdBy|channel-account': {
    phase: 'account',
    table: contentLabels,
    where: accountEq(contentLabels.createdBy),
  },
  'reports.reporter|channel-account': {
    phase: 'account',
    table: reports,
    where: accountEq(reports.reporter),
  },
  'user_settings.oxyUserId|channel-account': {
    phase: 'account',
    table: userSettings,
    where: accountEq(userSettings.oxyUserId),
  },
  // Another person's privacy settings naming the channel; their row is theirs so
  // only the entry goes.
  'user_settings.privacyRestrictedUsers|channel-account': {
    phase: 'account',
    table: userSettings,
    where: arrayContainsAccount(userSettings.privacyRestrictedUsers),
    update: async (targets, where) =>
      (
        await getDb()
          .update(userSettings)
          .set({ privacyRestrictedUsers: pullValue(userSettings.privacyRestrictedUsers, targets) })
          .where(where)
          .returning({ id: userSettings.id })
      ).length,
  },
  'author_follower_snapshots.oxyUserId|channel-account': {
    phase: 'account',
    table: authorFollowerSnapshots,
    where: accountEq(authorFollowerSnapshots.oxyUserId),
  },
  'mention_signed_records.oxyUserId|channel-account': {
    phase: 'account',
    table: mentionSignedRecords,
    where: accountEq(mentionSignedRecords.oxyUserId),
  },
  'mention_repo_heads.oxyUserId|channel-account': {
    phase: 'account',
    table: mentionRepoHeads,
    where: accountEq(mentionRepoHeads.oxyUserId),
  },
  'mention_user_nodes.oxyUserId|channel-account': {
    phase: 'account',
    table: mentionUserNodes,
    where: accountEq(mentionUserNodes.oxyUserId),
  },
  'mention_node_ingest_witnesses.oxyUserId|channel-account': {
    phase: 'account',
    table: mentionNodeIngestWitnesses,
    where: accountEq(mentionNodeIngestWitnesses.oxyUserId),
  },
  'engagement_outbox.payloadActorOxyUserId|channel-account': {
    phase: 'account',
    table: engagementOutbox,
    where: accountEq(engagementOutbox.payloadActorOxyUserId),
  },
  'engagement_outbox.payloadPostOwnerOxyUserId|channel-account': {
    phase: 'account',
    table: engagementOutbox,
    where: accountEq(engagementOutbox.payloadPostOwnerOxyUserId),
  },
  'user_behaviors.oxyUserId|channel-account': {
    phase: 'account',
    table: userBehaviors,
    where: accountEq(userBehaviors.oxyUserId),
  },
  'user_behavior_authors.authorId|channel-account': {
    phase: 'account',
    table: userBehaviorAuthors,
    where: accountEq(userBehaviorAuthors.authorId),
  },
  'user_behaviors.hiddenAuthors|channel-account': {
    phase: 'account',
    table: userBehaviors,
    where: arrayContainsAccount(userBehaviors.hiddenAuthors),
    update: async (targets, where) =>
      (
        await getDb()
          .update(userBehaviors)
          .set({ hiddenAuthors: pullValue(userBehaviors.hiddenAuthors, targets) })
          .where(where)
          .returning({ id: userBehaviors.id })
      ).length,
  },
  'user_behaviors.mutedAuthors|channel-account': {
    phase: 'account',
    table: userBehaviors,
    where: arrayContainsAccount(userBehaviors.mutedAuthors),
    update: async (targets, where) =>
      (
        await getDb()
          .update(userBehaviors)
          .set({ mutedAuthors: pullValue(userBehaviors.mutedAuthors, targets) })
          .where(where)
          .returning({ id: userBehaviors.id })
      ).length,
  },
  'user_behaviors.blockedAuthors|channel-account': {
    phase: 'account',
    table: userBehaviors,
    where: arrayContainsAccount(userBehaviors.blockedAuthors),
    update: async (targets, where) =>
      (
        await getDb()
          .update(userBehaviors)
          .set({ blockedAuthors: pullValue(userBehaviors.blockedAuthors, targets) })
          .where(where)
          .returning({ id: userBehaviors.id })
      ).length,
  },
  'user_feed_preferences.oxyUserId|channel-account': {
    phase: 'account',
    table: userFeedPreferences,
    where: accountEq(userFeedPreferences.oxyUserId),
  },
  'mutes.mutedId|channel-account': {
    phase: 'account',
    table: mutes,
    where: accountEq(mutes.mutedId),
  },
  'mutes.userId|channel-account': {
    phase: 'account',
    table: mutes,
    where: accountEq(mutes.userId),
  },
  'mute_words.userId|channel-account': {
    phase: 'account',
    table: muteWords,
    where: accountEq(muteWords.userId),
  },
  'likes.userId|channel-account': {
    phase: 'account',
    table: likes,
    where: accountEq(likes.userId),
  },
  'bookmarks.userId|channel-account': {
    phase: 'account',
    table: bookmarks,
    where: accountEq(bookmarks.userId),
  },
  'post_subscriptions.subscriberId|channel-account': {
    phase: 'account',
    table: postSubscriptions,
    where: accountEq(postSubscriptions.subscriberId),
  },
  'post_subscriptions.authorId|channel-account': {
    phase: 'account',
    table: postSubscriptions,
    where: accountEq(postSubscriptions.authorId),
  },
  'post_recent_repliers.oxyUserId|channel-account': {
    phase: 'account',
    table: postRecentRepliers,
    where: accountEq(postRecentRepliers.oxyUserId),
  },
  'entity_follows.userId|channel-account': {
    phase: 'account',
    table: entityFollows,
    where: accountEq(entityFollows.userId),
  },
  'feed_interactions.userId|channel-account': {
    phase: 'account',
    table: feedInteractions,
    where: accountEq(feedInteractions.userId),
  },
  'feed_likes.userId|channel-account': {
    phase: 'account',
    table: feedLikes,
    where: accountEq(feedLikes.userId),
  },
  'feed_reviews.reviewerId|channel-account': {
    phase: 'account',
    table: feedReviews,
    where: accountEq(feedReviews.reviewerId),
  },
  'feed_generators.createdBy|channel-account': {
    phase: 'account',
    table: feedGenerators,
    where: accountEq(feedGenerators.createdBy),
  },
  'labelers.creatorId|channel-account': {
    phase: 'account',
    table: labelers,
    where: accountEq(labelers.creatorId),
  },
  'pokes.pokerId|channel-account': {
    phase: 'account',
    table: pokes,
    where: accountEq(pokes.pokerId),
  },
  'pokes.pokedId|channel-account': {
    phase: 'account',
    table: pokes,
    where: accountEq(pokes.pokedId),
  },
  'push_tokens.userId|channel-account': {
    phase: 'account',
    table: pushTokens,
    where: accountEq(pushTokens.userId),
  },
  'polls.createdBy|channel-account': {
    phase: 'account',
    table: polls,
    where: accountEq(polls.createdBy),
  },
  'poll_votes.userId|channel-account': {
    phase: 'account',
    table: pollVotes,
    where: accountEq(pollVotes.userId),
  },
  'articles.createdBy|channel-account': {
    phase: 'account',
    table: articles,
    where: accountEq(articles.createdBy),
  },
  'postgates.createdBy|channel-account': {
    phase: 'account',
    table: postgates,
    where: accountEq(postgates.createdBy),
  },
  'threadgates.createdBy|channel-account': {
    phase: 'account',
    table: threadgates,
    where: accountEq(threadgates.createdBy),
  },
  'account_lists.ownerOxyUserId|channel-account': {
    phase: 'account',
    table: accountLists,
    where: accountEq(accountLists.ownerOxyUserId),
  },
  'account_list_members.oxyUserId|channel-account': {
    phase: 'account',
    table: accountListMembers,
    where: accountEq(accountListMembers.oxyUserId),
  },
  'custom_feeds.ownerOxyUserId|channel-account': {
    phase: 'account',
    table: customFeeds,
    where: accountEq(customFeeds.ownerOxyUserId),
  },
  'custom_feed_members.oxyUserId|channel-account': {
    phase: 'account',
    table: customFeedMembers,
    where: accountEq(customFeedMembers.oxyUserId),
  },
  'starter_packs.ownerOxyUserId|channel-account': {
    phase: 'account',
    table: starterPacks,
    where: accountEq(starterPacks.ownerOxyUserId),
  },
  'starter_pack_members.oxyUserId|channel-account': {
    phase: 'account',
    table: starterPackMembers,
    where: accountEq(starterPackMembers.oxyUserId),
  },
  'starter_pack_uses.oxyUserId|channel-account': {
    phase: 'account',
    table: starterPackUses,
    where: accountEq(starterPackUses.oxyUserId),
  },
  'endorsement_outbox.pendingRemoveOwnerId|channel-account': {
    phase: 'account',
    table: endorsementOutbox,
    where: accountEq(endorsementOutbox.pendingRemoveOwnerId),
  },
  'endorsement_outbox.pendingRemoveMemberIds|channel-account': {
    phase: 'account',
    table: endorsementOutbox,
    where: arrayContainsAccount(endorsementOutbox.pendingRemoveMemberIds),
    update: async (targets, where) =>
      (
        await getDb()
          .update(endorsementOutbox)
          .set({
            pendingRemoveMemberIds: pullValue(endorsementOutbox.pendingRemoveMemberIds, targets),
          })
          .where(where)
          .returning({ id: endorsementOutbox.id })
      ).length,
  },
  'trending.actorIds|channel-account': {
    phase: 'account',
    table: trending,
    where: arrayContainsAccount(trending.actorIds),
    update: async (targets, where) =>
      (
        await getDb()
          .update(trending)
          .set({ actorIds: pullValue(trending.actorIds, targets) })
          .where(where)
          .returning({ id: trending.id })
      ).length,
  },
  'mcp_connections.oxyUserId|channel-account': {
    phase: 'account',
    table: mcpConnections,
    where: accountEq(mcpConnections.oxyUserId),
  },
  // Somebody else's connector whose ACTIVE account is the channel. Deleting their
  // row would revoke a person's connector over an account they merely switched to,
  // so the pointer is cleared and `mcpBundleService` falls back to the owner.
  'mcp_connections.activeOxyUserId|channel-account': {
    phase: 'account',
    table: mcpConnections,
    where: accountEq(mcpConnections.activeOxyUserId),
    update: async (_targets, where) =>
      (
        await getDb()
          .update(mcpConnections)
          .set({ activeOxyUserId: null })
          .where(where)
          .returning({ id: mcpConnections.id })
      ).length,
  },
  'mcp_auth_codes.oxyUserId|channel-account': {
    phase: 'account',
    table: mcpAuthCodes,
    where: accountEq(mcpAuthCodes.oxyUserId),
  },
};

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

/** How many rows match, without touching them. */
async function countRows(table: PgTable, where: SQL): Promise<number> {
  const [row] = await getDb().select({ n: count() }).from(table).where(where);
  return row.n;
}

/**
 * Count (dry run) or delete (live), returning the affected-row count either way.
 * The single chokepoint that keeps a dry run strictly read-only — mirrors
 * `scripts/purgeGoneFederatedActors.ts`.
 */
async function countOrDelete(table: PgTable, where: SQL, dryRun: boolean): Promise<number> {
  if (dryRun) return countRows(table, where);
  const removed = await getDb().delete(table).where(where).returning({ deleted: sql<number>`1` });
  return removed.length;
}

/**
 * Delete one batch of the channel's posts — the statement every `ON DELETE`
 * constraint in the manifest hangs off.
 *
 * By the captured id set rather than by owner, so it removes exactly what the
 * preflight cleared and the dependent legs were enumerated from: a post created
 * since the batch was read is left for the next iteration rather than deleted
 * with its dependents unswept.
 */
async function deleteBatchPosts(batch: PostBatch, dryRun: boolean): Promise<number> {
  const ids = batch.channelPosts.map((row) => row.id);
  if (dryRun) return ids.length;
  const removed = await getDb()
    .delete(posts)
    .where(inArray(posts.id, ids))
    .returning({ id: posts.id });
  return removed.length;
}

/**
 * Accumulates what happened to every manifest step, and the failures that make
 * the call throw at the end.
 *
 * FOUR disjoint accounts, because "this ran and affected N rows", "the delegate
 * owns this", "a constraint did it" and "this is deliberately kept" are four
 * different statements and collapsing them loses the only one that matters.
 * Counting a non-executing step as `0` would be the worst option:
 * indistinguishable from a step that silently stopped running, which is the exact
 * failure the manifest binding exists to catch.
 */
class CascadeRun {
  readonly steps: Record<string, number> = {};
  readonly failures: string[] = [];
  private readonly delegatedKeys = new Set<string>();
  private readonly databaseKeys = new Set<string>();
  private readonly retainedKeys = new Set<string>();

  record(key: string, countOfRows: number): void {
    this.steps[key] = (this.steps[key] ?? 0) + countOfRows;
  }

  delegate(key: string): void {
    this.delegatedKeys.add(key);
  }

  database(key: string): void {
    this.databaseKeys.add(key);
  }

  retain(key: string): void {
    this.retainedKeys.add(key);
  }

  fail(key: string, error: unknown): void {
    this.failures.push(key);
    logger.error(`${LOG_PREFIX} cascade step failed`, { step: key, error });
  }

  /**
   * A failure the delegate has ALREADY logged with its own leg name; recorded so
   * the run still throws and a retry re-runs it. Not logged a second time — two
   * entries for one failure read as two failures.
   */
  failDelegated(reference: string): void {
    this.failures.push(`PostDeletionCascade:${reference}`);
  }

  /**
   * The three non-executing key lists, made DISJOINT from `steps` and from each
   * other.
   *
   * Several columns are classified twice by scope — `notifications.entityId`,
   * `content_labels.targetId` and `reports.reportedId` each hold a post id under
   * one type discriminator and an account id under another — so one step key can
   * carry both a delegated entry and a locally executed one. Local wins, because a
   * real count is more informative than a label and because the count would
   * otherwise be silently dropped from the result. The manifest entry for the
   * non-executing half says so in its `why`, which is where a reader looks for the
   * disposition anyway.
   */
  classify(): { delegated: string[]; performedByDatabase: string[]; retained: string[] } {
    const local = new Set(Object.keys(this.steps));
    const delegated = [...this.delegatedKeys].filter((key) => !local.has(key));
    const database = [...this.databaseKeys].filter(
      (key) => !local.has(key) && !this.delegatedKeys.has(key),
    );
    return {
      delegated: delegated.sort(),
      performedByDatabase: database.sort(),
      retained: [...this.retainedKeys]
        .filter(
          (key) => !local.has(key) && !this.delegatedKeys.has(key) && !this.databaseKeys.has(key),
        )
        .sort(),
    };
  }
}

interface ScheduledStep {
  readonly step: CascadeStep;
  readonly binding: LocalStepBinding;
}
type CascadeSchedule = ReadonlyMap<CascadePhase, readonly ScheduledStep[]>;

interface Schedule {
  readonly phases: CascadeSchedule;
  /** Steps the post-batch loop runs, in manifest order. */
  readonly inBatch: ReadonlyArray<{ step: CascadeStep; binding: InBatchBinding }>;
}

/**
 * Account for every manifest step exactly once, and group the ones this service
 * executes under the phase or the loop that runs them.
 *
 * Done in ONE pass over the manifest rather than per phase, so a step with no
 * binding is reported once rather than once per phase — and so the delegated,
 * database and retained accounts are complete even in a dry run, where the
 * delegate is never called.
 */
function buildSchedule(run: CascadeRun): Schedule {
  const phases = new Map<CascadePhase, ScheduledStep[]>();
  const inBatch: Array<{ step: CascadeStep; binding: InBatchBinding }> = [];

  for (const step of CHANNEL_CASCADE) {
    // The manifest's own action decides these two, ahead of any binding lookup: a
    // retained row has no query, and a constraint-performed one must not have one.
    if (step.action === 'retain') {
      run.retain(stepKey(step));
      continue;
    }
    if (step.action === 'database') {
      run.database(stepKey(step));
      continue;
    }
    const binding = STEP_BINDINGS[bindingKey(step)];
    if (!binding) {
      run.fail(
        bindingKey(step),
        new Error(`no Postgres binding for cascade step ${bindingKey(step)}`),
      );
      continue;
    }
    if (isDelegated(binding)) {
      run.delegate(stepKey(step));
      continue;
    }
    if (isInBatch(binding)) {
      inBatch.push({ step, binding });
      continue;
    }
    const bucket = phases.get(binding.phase);
    if (bucket) bucket.push({ step, binding });
    else phases.set(binding.phase, [{ step, binding }]);
  }

  // A stable sort, so an entry without an `order` keeps its manifest position.
  for (const bucket of phases.values()) {
    bucket.sort((left, right) => (left.binding.order ?? 0) - (right.binding.order ?? 0));
  }
  return { phases, inBatch };
}

/**
 * Run every manifest step assigned to one phase.
 *
 * A step that throws still records its key (as 0) so the result stays a complete
 * description of the manifest, and the failure is collected for the throw at the
 * end. A step with NO binding records nothing — the missing key is what the
 * manifest-binding test reports.
 */
async function runPhase(
  phase: CascadePhase,
  schedule: Schedule,
  targets: DeletionTargets,
  dryRun: boolean,
  run: CascadeRun,
): Promise<void> {
  for (const { step, binding } of schedule.phases.get(phase) ?? []) {
    try {
      const where = binding.where(targets);
      if (where === undefined) {
        run.record(stepKey(step), 0);
        continue;
      }
      if (dryRun) {
        run.record(stepKey(step), await countRows(binding.table, where));
      } else if (binding.update) {
        run.record(stepKey(step), await binding.update(targets, where));
      } else {
        run.record(stepKey(step), await countOrDelete(binding.table, where, false));
      }
    } catch (error) {
      run.record(stepKey(step), 0);
      run.fail(stepKey(step), error);
    }
  }
}

// ---------------------------------------------------------------------------
// Federation
// ---------------------------------------------------------------------------

/**
 * The channel's username, resolved SERVER-SIDE from the authoritative
 * `oxyUserId` — the canonical Note ids a remote server matches against are minted
 * from it, and no request-scoped value is trusted for it.
 *
 * A resolve miss THROWS before any row is deleted, so the run is retried rather
 * than leaving remote copies with no local post left to address a later Delete
 * from. Resolved ONCE per run and reused by every batch's Tombstones.
 */
async function resolveChannelUsername(channelOxyUserId: string): Promise<string> {
  const user = await getServiceOxyClient().getUserById(channelOxyUserId);
  const username = user.username?.trim();
  if (!username) {
    throw new Error(
      `${LOG_PREFIX} cannot federate the deletion of ${channelOxyUserId}: no resolvable username`,
    );
  }
  return username;
}

/**
 * Per-post Tombstones for one batch, sent BEFORE its rows are deleted.
 *
 * Once the actor is deleted a remote server may drop the account wholesale, and
 * an instance that does not still needs each status named. `federateDelete` is
 * best-effort by design and never throws.
 *
 * Only PUBLIC + PUBLISHED posts: a draft, a scheduled post, a followers-only post
 * or one `restricted` by moderation was never advertised, so a Tombstone for it
 * would name an object the receiving instance has never heard of.
 */
async function broadcastBatchTombstones(
  batch: PostBatch,
  channelOxyUserId: string,
  username: string,
): Promise<void> {
  for (const post of batch.channelPosts) {
    if (post.visibility !== PostVisibility.PUBLIC || post.status !== 'published') continue;
    await followService.federateDelete({ id: post.id }, channelOxyUserId, username);
  }
}

/**
 * Tell the fediverse the actor is gone, BEFORE anything the delivery path reads
 * is deleted: `deliverToFollowers` resolves its inboxes from the
 * `federated_follows` rows, which the account phase removes.
 */
async function broadcastActorDelete(
  channelOxyUserId: string,
  username: string,
): Promise<void> {
  const actor = actorUrl(username);
  await deliveryService.deliverToFollowers(
    {
      '@context': AP_CONTEXT,
      id: `${actor}#delete-${Date.now()}`,
      type: 'Delete',
      actor,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: actor,
    },
    channelOxyUserId,
    username,
  );
}

// ---------------------------------------------------------------------------
// Counter repair
// ---------------------------------------------------------------------------

/**
 * The posts the channel LIKED, read while its `likes` rows still exist.
 *
 * Ordering is load-bearing and is why this is its own function rather than a read
 * inside the repair: the account phase deletes `likes.user_id = <channel>`, so a
 * repair that discovered these afterwards would find nothing and silently leave
 * every one of those counters an increment too high. Called before that phase,
 * used after it.
 */
async function readLikedPostIds(channelOxyUserId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ postId: likes.postId })
    .from(likes)
    .where(eq(likes.userId, channelOxyUserId));
  return rows.map((row) => row.postId);
}

/**
 * Repair the denormalized counters on posts that SURVIVE this run but lose an
 * engagement record to it.
 *
 * TWO cases, and the ones that are NOT here are structural rather than omissions:
 *
 *  - A channel post that BOOSTED somebody else's surviving post. Its own boosts
 *    are inside the removed set by construction (the closure is seeded from it),
 *    so only an original OUTSIDE the set can need repairing.
 *  - A `Like` the channel left on somebody else's surviving post.
 *  - NOT `stats_comments_count`: a channel post is never a reply to somebody else
 *    (the reply gate refuses a `channel` author at five sites) and a channel
 *    thread's continuations answer the channel's own posts, which are inside the
 *    removed set.
 *  - NOT `stats_federated_boosts_count`: it counts inbound Announces, and a
 *    channel is a local author.
 *
 * Each decrement is guarded on `> 0`, mirroring the live `Undo(Announce)` /
 * unlike teardown, so a counter that already lags cannot underflow. Deleted posts
 * drop out on their own — an id no longer in `posts` matches nothing.
 */
async function repairSurvivingCounters(
  boostedOriginalIds: readonly string[],
  likedPostIds: readonly string[],
  dryRun: boolean,
): Promise<{ boostCounters: number; likeCounters: number }> {
  return {
    boostCounters: await decrementStat(boostedOriginalIds, 'boosts', dryRun),
    likeCounters: await decrementStat(likedPostIds, 'likes', dryRun),
  };
}

/**
 * One guarded bulk decrement. A failure is LOGGED and swallowed rather than
 * thrown, which is the opposite of every other step here and deliberate: the ids
 * being repaired were derived from rows this run has already deleted, so a retry
 * computes an EMPTY repair set and can never make good on it. Failing the job
 * would therefore lose the deletion's success without saving the counter. A stale
 * denormalized count is reconcilable on its own
 * (`scripts/recomputeFederatedEngagement.ts`); a half-reported cascade is not.
 *
 * The two counters are named by a literal union rather than passed as a
 * `PgColumn`, because `.set()` is keyed by the drizzle PROPERTY name and building
 * that key dynamically would need a cast the compiler could not check — the exact
 * shape that lets a typo write to a column nobody meant.
 */
async function decrementStat(
  postIds: readonly string[],
  stat: 'boosts' | 'likes',
  dryRun: boolean,
): Promise<number> {
  if (postIds.length === 0) return 0;
  const column = stat === 'boosts' ? posts.statsBoostsCount : posts.statsLikesCount;
  const where = and(inArray(posts.id, [...postIds]), sql`${column} > 0`);
  if (where === undefined) return 0;
  try {
    // The dry-run figure counts the SAME predicate the live write uses, so it is
    // not an optimistic guess about a post that may no longer exist.
    if (dryRun) return countRows(posts, where);
    const updated = await getDb()
      .update(posts)
      .set(
        stat === 'boosts'
          ? { statsBoostsCount: sql`${posts.statsBoostsCount} - 1` }
          : { statsLikesCount: sql`${posts.statsLikesCount} - 1` },
      )
      .where(where)
      .returning({ id: posts.id });
    return updated.length;
  } catch (error) {
    logger.error(`${LOG_PREFIX} could not repair a counter on a surviving post`, { stat, error });
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The account this was pointed at is not a channel, so nothing was read and
 * nothing was written.
 *
 * The message distinguishes the two causes ON PURPOSE, because the operator
 * response is not the same one: "resolved as personal" means the id is wrong and
 * the run must never be repeated as-is, while "could not be resolved" means Oxy
 * could not answer and the same command is worth retrying once identity is back.
 * A single "not a channel" message would make the second look like the first, and
 * the natural reaction to the first — go and find the right id — is exactly the
 * wrong reaction to the second.
 */
export class NotAChannelAccountError extends Error {
  /** The kind Oxy answered with, or `null` when the read produced no answer. */
  readonly resolvedKind: AccountKind | null;

  constructor(oxyUserId: string, resolvedKind: AccountKind | null) {
    super(
      resolvedKind === null
        ? `${LOG_PREFIX} refused: the Oxy account kind of ${oxyUserId} could not be resolved, and ` +
            'deleting an account whose kind is unknown is not a risk this takes'
        : `${LOG_PREFIX} refused: ${oxyUserId} resolved as ${resolvedKind}, not a channel`,
    );
    this.name = 'NotAChannelAccountError';
    this.resolvedKind = resolvedKind;
  }
}

/**
 * Refuse anything that is not a channel, before a single row is read.
 *
 * `resolveAccountKind` is fail-soft to `null` by design — the reply gate needs an
 * identity outage not to refuse every reply on the site — so the DECISION is the
 * caller's, and here it is no. The two directions are not comparable: refusing
 * delays an administrative action that can be re-run, while allowing destroys a
 * person's posts irreversibly if the id turns out to name a personal account.
 *
 * The `catch` is deliberate belt-and-braces rather than dead code: the fail-soft
 * contract lives in another module and could be tightened there without anybody
 * looking at this call site, and a rejection that propagated would abort the run
 * with an error that says nothing about why.
 */
async function assertChannelAccount(oxyUserId: string): Promise<void> {
  let kind: AccountKind | null;
  try {
    kind = await resolveAccountKind(oxyUserId);
  } catch (error) {
    logger.error(`${LOG_PREFIX} could not resolve the account kind`, error);
    throw new NotAChannelAccountError(oxyUserId, null);
  }
  if (kind !== 'channel') {
    logger.warn(`${LOG_PREFIX} refused a deletion for a non-channel account`, {
      oxyUserId,
      resolvedKind: kind,
    });
    throw new NotAChannelAccountError(oxyUserId, kind);
  }
}

export interface ChannelDeletionPreview {
  channelOxyUserId: string;
  /** The channel's own posts. */
  posts: number;
  /** Other people's boosts of them, which the database destroys alongside. */
  boostsByOthers: number;
  /** Other people's replies into the set. A channel cannot be replied to, so 0. */
  replies: number;
  /** Other people's quotes of a doomed post: kept, pointer cleared. */
  quotesByOthersKept: number;
  /** Remote inboxes the `Delete(actor)` will reach. */
  federatedFollowers: number;
}

function buildPreview(targets: DeletionTargets): ChannelDeletionPreview {
  return {
    channelOxyUserId: targets.channelOxyUserId,
    posts: targets.posts,
    boostsByOthers: targets.boostsByOthers,
    replies: targets.repliesByOthers,
    quotesByOthersKept: targets.quotesByOthersKept,
    federatedFollowers: targets.federatedFollowers,
  };
}

/**
 * What deleting this channel would cost, without touching anything.
 *
 * Gated on the account kind exactly like the deletion itself: a preview of "every
 * post this person has ever written" is not a harmless read to hand back for an
 * account nobody established is a channel.
 *
 * `replies` should always be 0 — the reply gate refuses a `channel` author at
 * five sites — and a non-zero value is a finding, not a number to accept.
 */
export async function previewChannelDeletion(
  channelOxyUserId: string,
): Promise<ChannelDeletionPreview> {
  await assertChannelAccount(channelOxyUserId);
  return buildPreview(await resolveDeletionTargets(channelOxyUserId));
}

export interface ChannelDeletionResult {
  /**
   * Affected-row counts for the steps THIS service executed, keyed EXACTLY
   * `${step.table}.${step.column}`.
   *
   * A key whose column is classified under two scopes appears here when EITHER
   * scope runs locally, and the count is that local work only — the other scope's
   * disposition is on its manifest entry.
   */
  steps: Record<string, number>;
  /**
   * Manifest keys whose disposition belongs to
   * `PostDeletionCascade.cascadePostReferences`. Listed without a count on
   * purpose: the delegate throws on a failed leg rather than reporting
   * per-reference totals, and inventing a `0` here would be indistinguishable
   * from a step that never ran.
   */
  delegated: string[];
  /**
   * Manifest keys an `ON DELETE` constraint performs. Listed without a count for
   * the same reason, and with a stronger one besides: nothing in this process
   * ever sees those rows, so any number here would be fabricated.
   */
  performedByDatabase: string[];
  /** Manifest keys deliberately KEPT — see each entry's `why` for the reason. */
  retained: string[];
  preview: ChannelDeletionPreview;
  dryRun: boolean;
}

/**
 * Destroy one channel's content and every Mention row pointing at it.
 *
 * The order below is the whole design; each phase says what a crash inside it
 * leaves behind, and none of those states is unrecoverable by a re-run.
 */
export async function deleteChannelContent(
  channelOxyUserId: string,
  options: { dryRun: boolean },
): Promise<ChannelDeletionResult> {
  const { dryRun } = options;

  // 0. Refuse anything that is not a channel, before any read of the post set and
  //    long before any write or federation call. Pointed at a personal account
  //    this destroys a person's writing, and no route existing today is the
  //    absence of an accident rather than a defence against one.
  await assertChannelAccount(channelOxyUserId);

  const run = new CascadeRun();
  const schedule = buildSchedule(run);

  // 1. Read the preview counts. Read-only, so a crash here has changed nothing.
  const targets = await resolveDeletionTargets(channelOxyUserId);
  const preview = buildPreview(targets);
  logger.info(`${LOG_PREFIX} resolved deletion targets`, {
    dryRun,
    posts: preview.posts,
    boostsByOthers: preview.boostsByOthers,
    replies: preview.replies,
    quotesByOthersKept: preview.quotesByOthersKept,
    federatedFollowers: preview.federatedFollowers,
  });

  // 2. Drain the channel's undelivered outbound activities. The manifest requires
  //    this BEFORE the actor Delete, or a queued Create races it and republishes a
  //    post on the receiving instance. A crash here leaves some queued activities
  //    that a re-run drains; nothing has been told the channel is gone yet.
  await runPhase('federation-drain', schedule, targets, dryRun, run);

  // 3. The channel's posts, in keyset batches. Everything about a batch — the
  //    preflight, the Tombstones, the delegate, the local post-scoped legs and the
  //    `DELETE` — happens while its captured ids are still meaningful.
  //
  //    A crash mid-loop leaves the channel with fewer posts and a fediverse that
  //    has been told about the ones already gone. A re-run walks from the start
  //    over what survived.
  const username =
    !dryRun && targets.federatedFollowers > 0
      ? await resolveChannelUsername(channelOxyUserId)
      : null;
  const boostedOriginals = await destroyChannelPosts(
    channelOxyUserId,
    schedule,
    dryRun,
    username,
    run,
  );

  // 4. Tell the fediverse the actor itself is gone. Nothing delivery reads has
  //    been deleted yet — the `federated_follows` rows it resolves inboxes from go
  //    in the account phase below. A crash here leaves an actor remote servers may
  //    already have dropped while its local account rows survive; a re-run re-sends
  //    (Delete is idempotent remotely) and completes the cascade.
  if (username) {
    await broadcastActorDelete(channelOxyUserId, username);
  }

  // 5. Which posts the channel liked, read while its `likes` rows still exist —
  //    the account phase below deletes them, and a repair that looked afterwards
  //    would find nothing and leave every one of those counters an increment too
  //    high with no error anywhere.
  const likedPostIds = await readLikedPostIds(channelOxyUserId);

  // 6. Lane rows, then the account-keyed rows. Within the lane phase the mutes are
  //    swept by publisher and viewer BEFORE the lanes they hang off, so a mute is
  //    never left to `lane_mutes.lane_id`'s cascade alone — that constraint covers
  //    the lane key, and the two account-keyed columns carry no constraint at all.
  await runPhase('lanes', schedule, targets, dryRun, run);
  await runPhase('account', schedule, targets, dryRun, run);

  // 7. Counters on posts that SURVIVE but lost an engagement record. Deliberately
  //    not part of `steps`: no manifest entry describes a counter, and inventing a
  //    key would break the set equality that binds this file to the manifest.
  const counters = await repairSurvivingCounters(boostedOriginals, likedPostIds, dryRun);
  logger.info(`${LOG_PREFIX} repaired counters on surviving posts`, {
    dryRun,
    boostCounters: counters.boostCounters,
    likeCounters: counters.likeCounters,
  });

  if (run.failures.length > 0) {
    throw new Error(
      `${LOG_PREFIX} ${run.failures.length} cascade step(s) failed for ${channelOxyUserId} ` +
        `(${run.failures.join(', ')}) — the run will be retried against whatever survived`,
    );
  }

  const { delegated, performedByDatabase, retained } = run.classify();
  return { steps: run.steps, delegated, performedByDatabase, retained, preview, dryRun };
}

/**
 * Walk the channel's posts in keyset batches, destroying each one completely
 * before reading the next.
 *
 * Returns the ids of SURVIVING posts that lost a boost to this run — a channel
 * post that boosted somebody else's post, collected per batch because that is the
 * only moment its `boost_of` is still readable.
 */
async function destroyChannelPosts(
  channelOxyUserId: string,
  schedule: Schedule,
  dryRun: boolean,
  username: string | null,
  run: CascadeRun,
): Promise<string[]> {
  const boostedOriginals: string[] = [];
  let after: string | null = null;

  // Open every batch-scoped step's account at zero BEFORE the loop, so a channel
  // with no posts still reports them rather than leaving five manifest keys
  // unaccounted for.
  //
  // Derived from the SCHEDULE, never from the manifest, and that is the whole
  // difference: a step whose binding is removed drops out of `schedule.inBatch`,
  // is not seeded, and fails the union assertion — which is exactly what
  // pre-seeding from the manifest would have hidden. What is claimed here is only
  // "this step was reached", which is true the moment the loop is entered.
  for (const { step } of schedule.inBatch) run.record(stepKey(step), 0);

  for (;;) {
    const batch: PostBatch | null = await readPostBatch(channelOxyUserId, after);
    if (!batch) break;
    after = batch.lastId;

    const removedIds = new Set(batch.rows.map((row) => row.id));
    for (const post of batch.channelPosts) {
      if (post.boostOf && !removedIds.has(post.boostOf)) boostedOriginals.push(post.boostOf);
    }

    // Prove the deletion cannot strand a reference nobody cleans. Read-only, and
    // deliberately BEFORE the Tombstones rather than after: a refusal here is
    // permanent until an operator acts, and broadcasting first would leave remote
    // servers holding a Tombstone for posts that are still live locally, on every
    // retry. It runs in a dry run too, so a blocker surfaces before a live run.
    await assertPostsSafeToDelete(
      `channelDeletion:${channelOxyUserId}`,
      deletionTargetsOf(batch.rows),
      {
        removedByCascade: [...REMOVED_BEFORE_THE_POSTS, ...REMOVED_BY_DATABASE],
        // Stated separately from the claim above because it is the opposite kind
        // of statement: these rows are kept on purpose, so the residue check must
        // not demand their absence.
        keptByPolicy: KEPT_BY_POLICY,
        // The graph probe would otherwise refuse the run for the quotes and
        // replies `ON DELETE SET NULL` clears — a strictly stronger disposition
        // than the dangling pointer the allowance describes. `boost_of` stays
        // covered, and the closure captured above is what keeps it satisfied.
        allowDanglingReplyReferences: true,
      },
    );

    if (username) {
      await broadcastBatchTombstones(batch, channelOxyUserId, username);
    }

    // The delegate, then the local post-scoped legs, then the `DELETE` — all in
    // ONE transaction. The delegate THROWS on a failed leg, and that is only
    // coherent inside a transaction: a leg that fails rolls the batch back, the
    // posts are NOT deleted, and a retry can still reach the rows it left. Outside
    // one, the same throw would report a partly-completed batch whose leftovers
    // nothing could find.
    try {
      if (dryRun) {
        for (const { step, binding } of schedule.inBatch) {
          run.record(stepKey(step), await binding.run(batch, true));
        }
      } else {
        await getDb().transaction(async (tx) => {
          await cascadePostReferences(batch.rows, tx);
          for (const { step, binding } of schedule.inBatch) {
            run.record(stepKey(step), await binding.run(batch, false));
          }
        });
      }
    } catch (error) {
      run.failDelegated(`batch@${batch.lastId}`);
      logger.error(`${LOG_PREFIX} a post batch failed and was rolled back`, {
        channelOxyUserId,
        lastId: batch.lastId,
        error,
      });
      continue;
    }

    // Verify what the batch CLAIMED to remove actually went, with nothing
    // acknowledged. OUTSIDE the transaction on purpose: inside it the probes would
    // read the transaction's own uncommitted deletes and pass by construction,
    // which is a check that cannot fail. Skipped in a dry run, where every claim is
    // trivially unmet because nothing was deleted.
    if (!dryRun) {
      const residue = await collectPostCascadeResidue(
        deletionTargetsOf(batch.rows),
        RESIDUE_CLAIM,
      );
      if (residue.length > 0) {
        logger.error(`${LOG_PREFIX} cascade claimed references it did not remove`, {
          channelOxyUserId,
          residue,
        });
      }
    }
  }

  return boostedOriginals;
}
