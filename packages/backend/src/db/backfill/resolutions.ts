/**
 * The documented decisions — the THIRD way to clear a blocking audit finding.
 *
 * An audit refuses the copy when production holds rows the Postgres schema
 * would reject. There are exactly three ways forward, and all three are
 * decisions rather than switches:
 *
 * 1. **Fix the data** in MongoDB, before the run.
 * 2. **Widen the schema** so the rows are legal.
 * 3. **Write a rule here**, saying in prose what the migration should do and
 *    reporting every row it acts on BY ID.
 *
 * There is no fourth way, and in particular there is **no override flag**. A
 * flag would let an operator under time pressure convert "the schema would
 * reject 400 rows" into "the run finished", which is the failure mode this file
 * exists to make impossible. Taking option 3 does not silence anything either:
 * the finding is still computed, still counted, still printed — now carrying
 * the rule that answers it.
 *
 * ## The two kinds of rule, and what is declared today
 *
 * - **Orphan rules** ({@link ORPHAN_RESOLUTIONS}) act on a row whose reference
 *   names no parent. **None is declared**, and that is correct: which of a
 *   post's dangling references is dropped and which is nulled is a decision
 *   about real data, and no audit has run against `mention-production` yet.
 *   Inventing one in advance would be guessing — it would act, the report would
 *   say it acted, and nobody would have decided.
 * - **Value rules** act on a VALUE the schema no longer accepts.
 *   {@link DROP_UNREAD_FEED_ENTITY_FOLLOWS} is the one declared rule, and it is
 *   declared because the decision was already made and written down in
 *   `schema/engagement.ts` — which states outright that the backfill "must
 *   actively drop rows rather than copy them" for a retired
 *   `entityfollows.entityType`. This file is where that instruction reports
 *   itself by id instead of happening silently inside a transform.
 *
 * Note what did NOT happen: the rule does not make its finding disappear. The
 * `EnumAudit` on `entity_follows.entity_type` still runs, still counts the
 * rows, and still prints them — now carrying the rule that answers them.
 *
 * ## A rule-recorded drop is not data loss, and the difference is enforced
 *
 * {@link ResolutionContext.dropDocument} is the ONLY channel by which a
 * transform may emit nothing for a document. A transform that just returns is
 * still a `dropped-document` finding, which blocks and which no rule may ever
 * clear. The two failures look identical from a row count, so they are
 * separated at the point of decision rather than inferred afterwards.
 *
 * ## Rules are narrow BY CONSTRUCTION
 *
 * Every guard in {@link resolveOrphanedReferences} exists because a widened
 * predicate DELETES PRODUCTION ROWS. Only a declared table, only its one
 * declared column, only a non-null string value, and only when that value is
 * absent from the parent set THIS PHASE supplied. An empty parent set stands
 * the rule down; an unloaded one refuses the run.
 */

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '../casing';
import { isUnresolvedAtprotoHandle, UNRESOLVED_HANDLE } from '../../connectors/atproto/unresolvedHandle';
import type { MongoSource } from './mongoSource';
import {
  singlePrimaryKeyProperty,
  tableName,
  type CollectionPlan,
} from './plan';
import { describeId, type MongoDocument } from './values';
import { posts } from '../schema/posts';
import { postRecentRepliers } from '../schema/postContent';

// ---------------------------------------------------------------------------
// what a rule IS
// ---------------------------------------------------------------------------

/**
 * One documented decision.
 *
 * `finding` and `decision` are prose on purpose. The point of a rule is that a
 * human decided something and wrote down what and why; a rule whose reason is
 * "see the code" is a rule nobody can review.
 */
export interface ResolutionRule {
  /** Stable id, quoted in the report and in tests. */
  readonly id: string;
  /** The collection whose documents it acts on. */
  readonly collection: string;
  /** The audit finding this answers, in the words the audit would use. */
  readonly finding: string;
  /** What the migration does about it, and why that is the right answer. */
  readonly decision: string;
}

/** What a rule does to a row whose reference names no parent. */
export type OrphanAction =
  /** Drop the row entirely. The schema's own answer when the column is NOT NULL. */
  | 'drop-row'
  /** Write the column NULL and keep the row. Only ever for a NULLABLE column. */
  | 'null-column';

/** What makes a rule fire. */
export type OrphanTrigger =
  /** The value names no row in the parent table Postgres holds. */
  | 'absent-parent'
  /** A SIBLING row in the same document was dropped by another rule. */
  | 'parent-dropped';

/**
 * One relation a rule is declared over.
 *
 * Everything derivable is derived: `tableName`, `property` and `columnName`
 * come off the drizzle table and column rather than being restated, so a
 * renamed column cannot leave a rule pointing at a name that no longer exists.
 */
export interface OrphanRelation {
  readonly rule: ResolutionRule;
  readonly action: OrphanAction;
  readonly trigger: OrphanTrigger;
  /** For a `parent-dropped` cascade: the rule whose removal triggers it. */
  readonly cascadesFrom?: OrphanRelation;
  /**
   * Why `drop-row` rather than `null-column`, when the column is NULLABLE.
   *
   * Required in that case and only that case: dropping a row whose column could
   * legally have held NULL is discarding data the schema would have accepted,
   * so the reason has to be written down.
   */
  readonly whyNotNull?: string;
  /** Columns copied verbatim into the report, as the record's evidence. */
  readonly carry?: readonly PgColumn[];
  /** The collection whose documents produce the offending rows. */
  readonly collection: string;
  readonly table: PgTable;
  readonly tableName: string;
  readonly column: PgColumn;
  /** The column's TypeScript PROPERTY name — what an emitted row is keyed by. */
  readonly property: string;
  /** The column's SQL name — what the report prints. */
  readonly columnName: string;
  readonly targetTable: PgTable;
  /** The Mongo collection behind the parent table, for the report's prose. */
  readonly parentCollection: string;
}

/** The fields a caller supplies; the rest are derived. */
export interface OrphanResolutionInput {
  readonly rule: ResolutionRule;
  readonly action: OrphanAction;
  readonly collection: string;
  readonly table: PgTable;
  readonly column: PgColumn;
  readonly targetTable: PgTable;
  readonly parentCollection: string;
  readonly trigger?: OrphanTrigger;
  readonly cascadesFrom?: OrphanRelation;
  readonly whyNotNull?: string;
  readonly carry?: readonly PgColumn[];
}

/**
 * Declare an orphan resolution, deriving every name from the schema.
 *
 * @throws {Error} When `action` is `drop-row` on a NULLABLE column with no
 *   `whyNotNull`. Dropping a row the schema would have accepted with a NULL is
 *   a choice, and an undocumented choice is how data goes missing quietly.
 */
export function orphanResolution(input: OrphanResolutionInput): OrphanRelation {
  const nullable = !input.column.notNull;
  if (input.action === 'drop-row' && nullable && input.whyNotNull === undefined) {
    throw new Error(
      `${input.rule.id} drops rows on ${tableName(input.table)}.${sqlColumnName(input.column)}, ` +
        'but that column is NULLABLE — so writing NULL would have kept the row and ' +
        'satisfied the constraint. Declare `whyNotNull` with the reason the row ' +
        'goes instead, or use `null-column`.'
    );
  }
  return {
    rule: input.rule,
    action: input.action,
    trigger: input.trigger ?? 'absent-parent',
    ...(input.cascadesFrom === undefined ? {} : { cascadesFrom: input.cascadesFrom }),
    ...(input.whyNotNull === undefined ? {} : { whyNotNull: input.whyNotNull }),
    ...(input.carry === undefined ? {} : { carry: input.carry }),
    collection: input.collection,
    table: input.table,
    tableName: tableName(input.table),
    column: input.column,
    property: input.column.name,
    columnName: sqlColumnName(input.column),
    targetTable: input.targetTable,
    parentCollection: input.parentCollection,
  };
}

/**
 * Rows with a retired `entityfollows.entityType`.
 *
 * `schema/engagement.ts` states this as an instruction — "the one place in this
 * schema where the backfill must actively drop rows rather than copy them" —
 * and this is that instruction, written where it reports itself BY ID.
 */
export const DROP_UNREAD_FEED_ENTITY_FOLLOWS: ResolutionRule = {
  id: 'drop-unread-feed-entity-follows',
  collection: 'entityfollows',
  finding:
    "entityfollows.entityType = 'feed' is not one of hashtag | list. The CHECK " +
    'on entity_follows.entity_type would reject these rows.',
  decision:
    "Rows with entityType:'feed' are DROPPED. They were written by a historical " +
    'code path and are read by NOTHING: a custom-feed subscription is a ' +
    '`FeedLike` row (POST /feeds/:id/like), which is what moves ' +
    '`CustomFeed.subscriberCount` and what every feed surface reads — ' +
    "`EntityFollow{entityType:'feed'}` moves nothing and is queried by no " +
    'source, service or controller. Both the Mongoose enum and the Postgres ' +
    'CHECK already declare only hashtag|list; these rows exist because Mongoose ' +
    'never ran `runValidators`, so the enum was documentation. Copying them ' +
    'would mean widening a constraint to admit data with no reader, which is ' +
    'precisely the Mongo baggage the port exists to leave behind. Every dropped ' +
    'row is reported BY ID under this rule.',
};

export const MAP_LEGACY_PUSH_TOKEN_TYPE: ResolutionRule = {
  id: 'map-legacy-push-token-type',
  collection: 'pushtokens',
  finding:
    'pushtokens.type = "android" is not one of fcm | apns | unknown. The CHECK ' +
    'on push_tokens.type would reject these rows.',
  decision:
    '"android" is REWRITTEN to "fcm"; any other unaccepted value becomes ' +
    '"unknown". Measured on the whole collection — 11 documents — before ' +
    'choosing: all eleven carry `platform: "android"` and a 142-character ' +
    'token, ten of them already say `type: "fcm"`, and the single "android" row ' +
    'is the OLDEST (2026-06-15) while every row written after 2026-07-12 says ' +
    '"fcm". The decisive one: the same user (6981c9178fcdefaf81988ffb) owns ' +
    'both that row AND two later "fcm" rows, so this is one device family ' +
    'either side of a writer change, not a different transport. FCM *is* the ' +
    'Android transport, so the two spellings name the same thing and the value ' +
    'is a historical one rather than a bad one. Dropping the row instead would ' +
    'discard a live push registration (`enabled: true`) to avoid writing a ' +
    'value the target vocabulary already has a place for. The fallback to ' +
    '"unknown" is what keeps the rule NARROW BY CONSTRUCTION: it is defined ' +
    'over the complement of the accepted set, which the column supplies, so a ' +
    'future unaccepted value is handled honestly instead of being silently ' +
    'mapped to a transport nobody verified. Every rewritten row is reported by ' +
    'id, carrying the value it had.',
};

/**
 * Duplicate `federatedactors` rows for ONE actor, produced by an unindexed
 * concurrent upsert.
 *
 * The finding is 569 colliding `uri` groups covering 1,156 documents, measured
 * against `mention-production` on 2026-08-03 — and it is still growing, which is
 * why this is a COPY-TIME rule and not a script somebody runs the night before.
 * The writer is `findOneAndUpdate({uri}, …, {upsert:true})` in
 * `connectors/activitypub/actor.service.ts` and its atproto twin in
 * `connectors/atproto/profile.mapper.ts`. MongoDB only guarantees an upsert
 * inserts once when a UNIQUE INDEX covers the filter; `models/FederatedActor.ts`
 * declares `uri`, `acct` and `(domain, username)` unique, but `autoIndex` is off
 * in production and no migration ever created them, so two concurrent
 * resolutions of a first-seen actor both miss the read and both insert.
 *
 * The port already fixes the writer — `db/federation/actorRepository.ts` upserts
 * `ON CONFLICT (uri) DO UPDATE` against a real constraint — so this rule cleans
 * up what the unindexed years produced and nothing recreates it afterwards.
 */
export const KEEP_FRESHEST_FEDERATED_ACTOR: ResolutionRule = {
  id: 'keep-freshest-federated-actor',
  collection: 'federatedactors',
  finding:
    'Several federatedactors documents share one `uri` — and, through it, one ' +
    '`acct` and one `(domain, username)`. federated_actors_uri_key, ' +
    'federated_actors_acct_key and federated_actors_domain_username_key would ' +
    'each reject all but one of them.',
  decision:
    'The row with the GREATEST `lastFetchedAt` survives (a document carrying ' +
    'none sorts last); ties break on `_id` DESCENDING so the choice is ' +
    'deterministic. Every other row in the group is DROPPED and reported by id. ' +
    '\n\n' +
    'Why most-recently-fetched and not created-first, which is the intuitive ' +
    'rule: the rows were IDENTICAL at insert — they are the same remote actor ' +
    'fetched twice, milliseconds apart (519 of the 569 groups were created ' +
    'within 10ms and NOT ONE spans more than a second). They differ today only ' +
    'because every later `findOneAndUpdate({uri})` updated whichever row the ' +
    'collection scan reached first, so exactly one row of each group kept being ' +
    'refreshed and the rest froze at their insert values — 577 of the 587 ' +
    'discarded rows were never fetched again at all. That makes ' +
    '"most-recently-synced" and "most-complete" the SAME row, and makes ' +
    'created-first actively wrong: the maintained row is the lowest `_id` in ' +
    '433 groups and the highest in 134, so ordering by `_id` would discard the ' +
    'live row in roughly a quarter of them. ' +
    '\n\n' +
    'Nothing is lost. Measured across all 569 groups: no discarded row holds an ' +
    '`oxyUserId` the survivor lacks and no two rows point at different Oxy ' +
    'users (566 identical, 3 survivor-only, 0 the other way, 0 conflicting); ' +
    'only 2 groups have a discarded row carrying any non-empty value the ' +
    'survivor lacks, and those are one `summary` and one `lastOutboxSyncAt` — ' +
    'the latter being the sticky cooldown stamp a fresh row is better off ' +
    'without. A discarded row never leads on `postsCount`, follower counts, ' +
    'backfill progress or profile-field count, so a MERGE would be machinery ' +
    'for a case that does not occur. Nothing references an actor by `_id` ' +
    'either — `federatedfollows` keys on `remoteActorUri` and no post carries ' +
    'an actor id — so a dropped row strands no child. ' +
    '\n\n' +
    'THE DROP IS SCOPED TO `uri` ON PURPOSE. Rows sharing a `uri` are one actor ' +
    'fetched twice; that is what makes discarding a duplicate lossless. Rows ' +
    'that share an `acct` or a `(domain, username)` under DIFFERENT `uri`s are ' +
    'DIFFERENT actors that a derivation bug gave one identity, and dropping ' +
    'those would delete real accounts. The grouping must never be widened to ' +
    '`acct` or `(domain, username)`; those rows are answered by the SECOND ' +
    'remedy below, which removes nothing. ' +
    '\n\n' +
    'REMEDY TWO — RE-KEY, for a row whose `acct` is Bluesky\'s ' +
    '`handle.invalid`. That is the AppView\'s error string for a handle whose ' +
    'DNS/DID verification failed, identical for every affected account, so it ' +
    'identifies nobody: production holds 21 rows carrying it and they are 21 ' +
    'DISTINCT Bluesky DIDs. `acct` and `username` are rewritten to the row\'s ' +
    'own `uri`, which for an atproto actor IS its DID — the stable identifier ' +
    'the protocol actually guarantees, already unique, and impossible to ' +
    'confuse with a real handle because it contains a `:` that no DNS name may. ' +
    'Nothing is dropped and no account is lost. ' +
    '\n\n' +
    'This is the SAME substitution the connector now applies at ingest ' +
    '(`atprotoIdentityHandle`), so a re-keyed row lands in exactly the shape the ' +
    'fixed writer would have produced — the backlog gets the current rule, not a ' +
    'special case, and nothing downstream has to know these rows predate the fix. ' +
    'oxy-api accepts it unchanged: `normalizeFederatedResolveUsername` splits on ' +
    'the FIRST `@`, so `did:plc:…@bsky.social` binds to `bsky.social` like any ' +
    'other handle. ' +
    '\n\n' +
    'The two remedies are ONE decision — give every row an identity that is ' +
    'actually its own, and remove only the rows that are not a separate thing at ' +
    'all — which is why they are one rule with one id rather than two. Each ' +
    'affected document is reported individually, saying which remedy it got.',
};

/**
 * A reply or thread link whose target the migration does not produce.
 *
 * Measured on `mention-production` (2026-08-03): 459 rows on `parent_post_id`
 * and 379 on `thread_id`. Both columns are NULLABLE and both declare
 * `ON DELETE set null`, so NULL is not a workaround here — it is the answer the
 * schema already gives when the parent goes away, applied one moment earlier.
 *
 * The post is KEPT. It is somebody's writing, it carries its own text, media
 * and engagement, and the only thing missing is a pointer to a post Mention
 * never held. Dropping it to satisfy a link would delete the content to save
 * the reference.
 *
 * Nulling the column does NOT quietly turn a reply into a top-level post:
 * `plans/posts.ts` derives `isReply` from `parentPostId !== null ||
 * federationInReplyTo !== null` while BUILDING the row, and this rule runs
 * afterwards on the built row — so a federated reply keeps `isReply` true and
 * keeps `federation.inReplyTo`, which is the URI the parent would be fetched by
 * if it ever arrives. The post stays a reply; it stops claiming a local parent
 * that does not exist.
 */
export const NULL_LINK_TO_A_POST_MENTION_NEVER_HELD: ResolutionRule = {
  id: 'null-link-to-a-post-mention-never-held',
  collection: 'posts',
  finding:
    'posts.parent_post_id and posts.thread_id name a `posts` row the migration ' +
    'does not produce. Both columns are NULLABLE, so writing NULL would keep ' +
    'the row — but that is a decision, not a default.',
  decision:
    'The column is written NULL and the POST IS KEPT. Both relations declare ' +
    '`ON DELETE set null`, so this is the schema\'s own answer to a parent that ' +
    'is not there, taken at copy time rather than at delete time. The ' +
    'alternative — dropping the post — would discard text, media and ' +
    'engagement in order to preserve a pointer to something Mention never had.' +
    '\n\n' +
    'The reply does not stop being a reply. `isReply` is derived while the row ' +
    'is built, from `parentPostId` OR `federation.inReplyTo`, and this rule ' +
    'runs on the built row — so a federated reply keeps `isReply` true and ' +
    'keeps the `inReplyTo` URI, which is how the parent would be matched if it ' +
    'ever lands. What is lost is a local id that resolved to nothing.' +
    '\n\n' +
    'Every affected post is reported BY ID, carrying the value that was ' +
    'nulled, so the link is recoverable from the report if a parent arrives ' +
    'later.',
};

/**
 * A "recently replied" face whose post the migration does not produce.
 *
 * 457 rows, measured on `mention-production` (2026-08-03). `post_id` is NOT
 * NULL, so there is no value that satisfies the constraint: the row cannot be
 * written at all, and dropping it is the only outcome available. That is why
 * this carries no `whyNotNull` — nothing is being chosen.
 *
 * It costs nothing either way. `plans/content.ts` establishes what this table
 * is: a read-model projection of who replied recently, drawn as faces on a
 * post, which `PostRecentReplierService` rewrites on the next reply and
 * `EngagementProjectionReconciliationService` repairs wholesale. A row here
 * describes a post that will not exist in Postgres, so it is a cached face on
 * a page nobody can open.
 */
export const DROP_RECENT_REPLIER_OF_A_VANISHED_POST: ResolutionRule = {
  id: 'drop-recent-replier-of-a-vanished-post',
  collection: 'post_recent_repliers',
  finding:
    'post_recent_repliers.post_id names a `posts` row the migration does not ' +
    'produce. The column is NOT NULL, so no value satisfies the constraint and ' +
    'the row cannot be written at all.',
  decision:
    'The row is DROPPED, which is the only outcome a NOT NULL foreign key ' +
    'leaves available — there is no value to write instead. Nothing is lost ' +
    'that a reader could observe: this table is a recency PROJECTION (the ' +
    'faces shown on a post), rebuilt by `PostRecentReplierService` on the next ' +
    'reply and repaired wholesale by ' +
    '`EngagementProjectionReconciliationService`. The dropped rows describe ' +
    'posts that will not exist in Postgres, so they are cached faces on a page ' +
    'that cannot be opened. Every dropped row is reported BY ID.',
};

/**
 * A boost of a post Mention does not hold.
 *
 * This is the one rule here that removes a post, so the evidence is stated
 * rather than asserted.
 *
 * TWO DIFFERENT QUANTITIES SIT NEXT TO EACH OTHER IN THIS REPORT, and they will
 * be confused unless they are named: **347 is the count of boost ROWS** the
 * audit would reject, while **257 is the count of distinct missing ORIGINALS**
 * those rows point at (part of the 722 distinct absent parents across all four
 * relations). Many boosts can name one vanished original, so the row count is
 * the larger number and it is the one a rule acts on. A ruling written against
 * 257 would be a ruling about the wrong population.
 *
 * Measured against `mention-production` (2026-08-03), over ALL 348 such rows
 * live at the time — not a sample:
 *
 * - every one is `type: 'boost'` and `status: 'published'`;
 * - ZERO carry any `content.text`;
 * - ZERO carry any media;
 * - ZERO carry a like, reply, quote or boost of their own;
 * - ZERO are referenced by any reply, quote, boost, `Like` row or
 *   recent-replier row.
 *
 * A boost row's entire content IS the pointer. `PostHydrationService` embeds
 * the boosted original at `maxDepth >= 1` and the body is intentionally empty,
 * so a boost whose `boostOf` names nothing renders blank TODAY, in production,
 * before this migration touches it. Keeping the row by writing NULL would not
 * preserve anything a reader can see — it would produce a post with no
 * content, no target and no way to render, which is strictly worse than not
 * having it: `type: 'boost'` with `boostOf: NULL` is a shape no writer
 * produces and no reader expects.
 *
 * 347 of the 348 are federated (an Announce arrived for an original Mention
 * never stored) and span 2024-04 to 2026-08 — never-landed originals, not
 * deletions, which the referrers' locality is what establishes: every one
 * federated, zero local.
 *
 * The single local row is the test account boosting a post created two seconds
 * earlier that was then deleted. That one is a PRODUCT finding and not a
 * migration one: **the delete path leaves boosts behind**. It is recorded here
 * because refusing to claim one cause for all 348 is what makes both claims
 * usable, and it wants fixing in the app rather than in this rule.
 *
 * The set is LIVE — the 348th arrived 81 seconds after the audit's bound
 * closed. So the ids this rule reports are produced by the COPY as it runs and
 * are never read from a list an audit froze; a precomputed list would miss
 * exactly the rows that arrived since, copy them, and violate the foreign key
 * having reported nothing. `backfillOrphanResolutions.test.ts` pins that by
 * planning the resolutions BEFORE the offending document exists.
 */
export const DROP_BOOST_OF_A_POST_MENTION_NEVER_HELD: ResolutionRule = {
  id: 'drop-boost-of-a-post-mention-never-held',
  collection: 'posts',
  finding:
    'posts.boost_of names a `posts` row the migration does not produce. The ' +
    'column is NULLABLE, so writing NULL would keep the row — but that is a ' +
    'decision, not a default.',
  decision:
    'The BOOST POST IS DROPPED, and every dropped id is reported. These posts ' +
    'are unrenderable in production TODAY, before the migration touches them: ' +
    "a boost's body is intentionally empty and its entire content is the " +
    'pointer, which `PostHydrationService` follows to embed the original. A ' +
    'boost whose target does not exist already renders blank.' +
    '\n\n' +
    'Measured over ALL 348 such rows live in `mention-production` on ' +
    '2026-08-03, not a sample: every one is `type: boost` and `published`; ' +
    'none carries text; none carries media; none carries a like, reply, quote ' +
    'or boost of its own; and none is referenced by any reply, quote, boost, ' +
    '`Like` row or recent-replier row. So the drop discards no writing and ' +
    'strands no child.' +
    '\n\n' +
    'NULL is the worse answer, which is why this is a drop and not a ' +
    '`null-column`. It would keep a `type: boost` row with `boostOf: NULL` — a ' +
    'shape no writer produces and no reader expects — leaving a permanently ' +
    'blank entry in its author\'s profile and in any feed that includes ' +
    'boosts, indistinguishable from a rendering bug. Dropping it removes a row ' +
    'that already shows nothing.' +
    '\n\n' +
    '347 of the 348 are federated: an Announce arrived for an original Mention ' +
    'never stored, spanning 2024-04 to 2026-08. The one local row is the test ' +
    'account boosting a post created two seconds earlier and since deleted — ' +
    'deleting a post does not delete boosts of it. Different causes, same ' +
    'remedy, and the id of each is in the report.',
};

/** Rules that act on a VALUE rather than on a missing parent. */
const VALUE_RESOLUTIONS: readonly ResolutionRule[] = [
  DROP_UNREAD_FEED_ENTITY_FOLLOWS,
  MAP_LEGACY_PUSH_TOKEN_TYPE,
  KEEP_FRESHEST_FEDERATED_ACTOR,
];

/**
 * Every declared orphan resolution.
 *
 * These four are the answer to the first `--audit-only` run against
 * production, which reported exactly these relations and nothing else:
 * `post_recent_repliers.post_id` 457, `posts.boost_of` 347,
 * `posts.parent_post_id` 459, `posts.thread_id` 379 (run 8, 2026-08-03).
 *
 * Every one of them points at `posts.id`, and none of them is a schema defect:
 * they are references to posts Mention never held — overwhelmingly federated,
 * where a reply or an Announce arrived for an original that was never fetched.
 * The remedy differs by what the column can hold and by what the row is worth
 * without it, which is why there are three rules rather than one.
 */
export const ORPHAN_RESOLUTIONS: readonly OrphanRelation[] = [
  orphanResolution({
    rule: NULL_LINK_TO_A_POST_MENTION_NEVER_HELD,
    action: 'null-column',
    collection: 'posts',
    table: posts,
    column: posts.parentPostId,
    targetTable: posts,
    parentCollection: 'posts',
  }),
  orphanResolution({
    rule: NULL_LINK_TO_A_POST_MENTION_NEVER_HELD,
    action: 'null-column',
    collection: 'posts',
    table: posts,
    column: posts.threadId,
    targetTable: posts,
    parentCollection: 'posts',
  }),
  orphanResolution({
    rule: DROP_RECENT_REPLIER_OF_A_VANISHED_POST,
    action: 'drop-row',
    collection: 'post_recent_repliers',
    table: postRecentRepliers,
    column: postRecentRepliers.postId,
    targetTable: posts,
    parentCollection: 'posts',
  }),
  orphanResolution({
    rule: DROP_BOOST_OF_A_POST_MENTION_NEVER_HELD,
    action: 'drop-row',
    collection: 'posts',
    table: posts,
    column: posts.boostOf,
    targetTable: posts,
    parentCollection: 'posts',
    whyNotNull:
      'Writing NULL would keep a `type: boost` row whose entire content is the ' +
      'pointer being nulled — a shape no writer produces and no reader ' +
      'expects, rendering blank forever in its author\'s profile and in every ' +
      'feed that includes boosts. Measured over all 348 live rows: none ' +
      'carries text, media or engagement, and none is referenced by anything. ' +
      'The row already shows nothing; the drop removes it rather than ' +
      'preserving an empty frame.',
    carry: [posts.type, posts.oxyUserId, posts.createdAt],
  }),
];

/**
 * Every rule the report enumerates, including ones that did nothing.
 *
 * Derived from {@link ORPHAN_RESOLUTIONS} plus any standalone value rules, so a
 * declared rule cannot be missing from the report by omission.
 */
export const RESOLUTION_RULES: readonly ResolutionRule[] = dedupeRules([
  ...ORPHAN_RESOLUTIONS.map((relation) => relation.rule),
  ...VALUE_RESOLUTIONS,
]);

function dedupeRules(rules: readonly ResolutionRule[]): ResolutionRule[] {
  const seen = new Set<string>();
  const out: ResolutionRule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push(rule);
  }
  return out;
}

const ORPHAN_RESOLUTIONS_BY_TABLE = new Map<string, OrphanRelation[]>();
for (const relation of ORPHAN_RESOLUTIONS) {
  const existing = ORPHAN_RESOLUTIONS_BY_TABLE.get(relation.tableName);
  if (existing) existing.push(relation);
  else ORPHAN_RESOLUTIONS_BY_TABLE.set(relation.tableName, [relation]);
}

const CASCADE_RESOLUTIONS: readonly OrphanRelation[] = ORPHAN_RESOLUTIONS.filter(
  (relation) => relation.trigger === 'parent-dropped'
);

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

/** One document a rule acted on. */
export interface ResolutionRecord {
  readonly rule: ResolutionRule;
  /** The source `_id`, so the operator can look the row up in Mongo. */
  readonly documentId: string;
  /**
   * WHICH part of the document, when one document can be acted on more than
   * once by the same rule.
   *
   * One document routinely produces several rows — a `posts` document produces
   * a row per media item, per mention, per source — so two of them naming two
   * absent parents are two separate acts. Without this they would collapse into
   * one record and the report would name only one of them.
   */
  readonly within?: string;
  /** What changed about this document, specifically. */
  readonly detail: string;
  /**
   * Columns of the row, carried verbatim — {@link OrphanRelation.carry}.
   *
   * This is the report's payload rather than its prose: for a dropped row it is
   * whatever identifies the thing that outlives the row (a media file id, a
   * federation activity URI), and nothing else will know it afterwards.
   */
  readonly evidence?: Readonly<Record<string, string>>;
}

/** Per-rule roll-up for the run report. */
export interface ResolutionSummary {
  readonly rule: ResolutionRule;
  readonly documents: number;
  readonly documentIds: readonly string[];
  readonly records: readonly ResolutionRecord[];
}

/**
 * Collects what the rules actually did.
 *
 * Deduped on `(rule, document, within)`, because a transform is run more than
 * once against the same document BY DESIGN — the deferred-self-reference pass
 * re-streams the collection, the referential audit runs every transform, and
 * the verifier re-runs it to compute its expectation. Recording the same fact
 * four times would inflate a count the operator is meant to check against the
 * audit's.
 */
export class ResolutionLog {
  private readonly records = new Map<string, ResolutionRecord>();
  /** Documents a rule removed WHOLE, by collection — see `dropDocument`. */
  private readonly dropped = new Map<string, Set<string>>();
  /** Record keys a durable writer has already been handed — see {@link drain}. */
  private readonly persisted = new Set<string>();

  record(entry: ResolutionRecord): void {
    this.records.set(`${entry.rule.id} ${entry.documentId} ${entry.within ?? ''}`, entry);
  }

  /**
   * Record that a rule removed an entire document, so it produces no row.
   *
   * Kept as a SET of document ids per collection rather than a counter, for the
   * same reason {@link record} is keyed rather than incremented: a transform is
   * re-run several times per document (the deferred pass, the referential
   * audit, both verifier passes), and a counter would multiply by four.
   */
  dropDocument(collection: string, documentId: string): void {
    const existing = this.dropped.get(collection);
    if (existing) existing.add(documentId);
    else this.dropped.set(collection, new Set([documentId]));
  }

  /** How many documents of this collection a rule removed whole. */
  documentsDroppedIn(collection: string): number {
    return this.dropped.get(collection)?.size ?? 0;
  }

  /**
   * Did a rule remove THIS document whole?
   *
   * Membership rather than the count above, because the caller
   * (`auditColumnCoverageForPlan`) has to decide per document, and a count
   * cannot answer that: the set is keyed by id precisely so a transform re-run
   * across four passes records one drop, which also means a before/after delta
   * reads zero for every pass after the first.
   */
  wasDropped(collection: string, documentId: string): boolean {
    return this.dropped.get(collection)?.has(documentId) === true;
  }

  /**
   * Every rule with what it did, INCLUDING the rules that did nothing.
   *
   * A rule reporting zero documents is information: it says the rule is still
   * declared and this data did not need it.
   */
  summary(): readonly ResolutionSummary[] {
    return this.summarize([...this.records.entries()]);
  }

  /**
   * Records no durable writer has been handed yet, MARKING them handed over.
   *
   * The audit trail was written once, after the copy returned — so a run that
   * DIED wrote nothing, and the durable record was empty for exactly the runs
   * that need one. A failed 26-minute attempt resolved hundreds of rows and
   * recorded none of them.
   *
   * A `finally` is NOT the fix and is worth naming, because it looks like one:
   * a write issued on a connection whose transaction has aborted executes
   * nothing at all until a rollback, while raising nothing and reading as
   * handled. Draining as the copy goes means the rows are already durable when
   * the failure happens, which needs no cooperation from the failure.
   *
   * Idempotent by KEY rather than by count: a transform is re-run several times
   * per document (the deferred pass, the referential audit, both verifier
   * passes) and {@link record} overwrites on the same key, so draining twice
   * cannot write a record twice.
   */
  drain(): readonly ResolutionSummary[] {
    const fresh = [...this.records.entries()].filter(([key]) => !this.persisted.has(key));
    for (const [key] of fresh) this.persisted.add(key);
    return this.summarize(fresh);
  }

  /** Every rule with the subset of records given, in a stable order. */
  private summarize(
    entries: ReadonlyArray<readonly [string, ResolutionRecord]>
  ): readonly ResolutionSummary[] {
    return RESOLUTION_RULES.map((rule) => {
      const records = entries
        .map(([, entry]) => entry)
        .filter((entry) => entry.rule.id === rule.id)
        .sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0));
      return {
        rule,
        documents: records.length,
        documentIds: records.map((entry) => entry.documentId),
        records,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// the pre-pass
// ---------------------------------------------------------------------------

/**
 * What the documented rules are GOING to do, decided once before the copy.
 *
 * A rule that needs to compare documents against each other — "of these three
 * colliding rows, which survives?" — cannot answer from inside a transform,
 * which sees one document at a time. The pre-pass computes those answers ONCE,
 * against the source, and every phase then reads the same decision.
 *
 * Currently empty because no rule needs one yet. The seam exists so the first
 * one does not have to invent it, and so `--audit-only` and the copy provably
 * share the same decisions rather than computing them separately.
 */
export interface ResolutionPlan {
  /**
   * Rows a rule has decided to act on, keyed by rule id.
   *
   * A rule reads its own entry; nothing reads another rule's. Empty until a
   * rule is declared.
   */
  readonly actedOn: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * One `federatedactors` document, reduced to what the survivor choice reads.
 *
 * `lastFetchedAt` is `unknown` because it is whatever Mongo holds. A document
 * written before the field existed has none, and a `Date` is the only shape
 * worth ordering by — {@link fetchedAtMillis} decides that once rather than at
 * two comparison sites.
 */
interface ActorDuplicateCandidate {
  readonly id: string;
  readonly lastFetchedAt: unknown;
}

/**
 * When an actor row was last refreshed, as a number, or `-Infinity` for never.
 *
 * NULLS LAST is the whole point and is why this is not `Date.parse`: a row with
 * no `lastFetchedAt` was never fetched after its insert, which makes it the LEAST
 * eligible survivor, and any finite sentinel would sort it above a real 1970
 * timestamp. `-Infinity` cannot.
 */
function fetchedAtMillis(value: unknown): number {
  if (value instanceof Date) {
    const millis = value.getTime();
    return Number.isNaN(millis) ? Number.NEGATIVE_INFINITY : millis;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * The rows of one colliding group that do NOT survive, in the rule's order.
 *
 * Exported for the tests, which pin the ORDERING rather than a fixture: the
 * choice is the rule, so it is what has to be exercised against a pair, a
 * three-way group and a twenty-one-way one — a pair cannot distinguish
 * "sorted correctly" from "reversed", and it is the size that made two earlier
 * readings of this data wrong.
 */
export function federatedActorDuplicatesToDrop(
  group: readonly ActorDuplicateCandidate[]
): string[] {
  if (group.length < 2) return [];
  const ordered = [...group].sort((a, b) => {
    const byFetched = fetchedAtMillis(b.lastFetchedAt) - fetchedAtMillis(a.lastFetchedAt);
    if (byFetched !== 0) return byFetched;
    // `_id` DESCENDING. Only reachable when two rows were fetched at the same
    // millisecond or never — the survivor is then arbitrary but must not be
    // RANDOM, or two phases of one run could disagree about which row to write.
    // Descending matches `findActorByOxyUserId`'s own tie-break
    // (`last_fetched_at desc nulls last, id desc`), so the migration and the
    // live reader pick the same row by construction rather than by review.
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return ordered.slice(1).map((row) => row.id);
}

/**
 * One sentinel-acct row, reduced to what the re-key needs.
 *
 * `uri` is carried because it IS the replacement identity — an atproto actor's
 * `uri` is its DID — so the pre-pass can refuse a row that has none rather than
 * emitting a re-key with nothing to re-key to.
 */
interface SentinelActorCandidate extends ActorDuplicateCandidate {
  /** The row's protocol URI — for an atproto actor, its DID. */
  readonly uri: string;
  /** Whether its stored `acct` is Bluesky's unresolved-handle sentinel. */
  readonly sentinel: boolean;
}

/**
 * Every `federatedactors` document {@link KEEP_FRESHEST_FEDERATED_ACTOR} acts on.
 *
 * Grouped in MongoDB rather than streamed and grouped here: the collection is
 * ~63,000 documents and only the fields the choice reads are projected, so the
 * whole answer is two aggregations returning the colliding groups alone.
 */
async function planFederatedActorDuplicates(source: MongoSource): Promise<{
  /** Rows the drop remedy removes. */
  readonly dropped: ReadonlySet<string>;
  /**
   * EVERY row of EVERY `uri`-colliding group, dropped or not.
   *
   * The re-key remedy excludes all of them, and that exclusion is load-bearing
   * rather than tidy: a sentinel row sharing its `uri` with another row cannot
   * be safely re-keyed, because the transform would re-key BOTH and land two
   * rows on one `uri`. Worse, merely PUTTING such a row in `actedOn` makes the
   * `uri` finding look answered — `resolvesUniquenessGroup` counts ids, not
   * remedies — so the group would sail past the audit and fail at COPY time
   * against the constraint. Both halves have to stand the row down.
   */
  readonly inUriGroup: ReadonlySet<string>;
}> {
  const dropped = new Set<string>();
  const inUriGroup = new Set<string>();
  // No existence check, deliberately: an aggregation over a collection that
  // does not exist returns an empty cursor, which is the same answer a guard
  // would produce and cannot be wrong.
  //
  // `source.count()` looks like the guard to reach for and is NOT usable here.
  // It answers from a MEMOISED `listCollections()` — captured once, on the first
  // call anywhere in the process — so a collection created after that snapshot
  // counts as 0 and would stand this rule down silently, leaving every
  // collision to block with no indication the pre-pass had been skipped. That
  // is not hypothetical: it is what the first version of this function did, and
  // the tests below caught it only because they assert the rule ACTED rather
  // than that the copy succeeded.
  const groups = await source
    .collection('federatedactors')
    .aggregate<{ rows?: unknown }>(
      [
        // Grouped on `uri` ALONE — see the rule's `decision`. Widening this to
        // `acct` or `(domain, username)` would delete distinct actors.
        {
          $group: {
            _id: '$uri',
            rows: { $push: { id: '$_id', uri: '$uri', acct: '$acct', lastFetchedAt: '$lastFetchedAt' } },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ],
      // 569 groups today, but the number is growing while the unindexed writer
      // is live, and a `$group` over the whole collection is exactly the shape
      // that outgrows the 100 MB in-memory limit unannounced.
      { allowDiskUse: true }
    )
    .toArray();

  for (const group of groups) {
    const candidates = readCandidates(group.rows);
    for (const row of candidates) inUriGroup.add(row.id);
    // A `uri` group containing a SENTINEL-acct row is left entirely alone, so
    // the finding blocks and a human looks at it.
    //
    // Not a hypothetical tidiness guard — it is what keeps the two remedies
    // from contradicting each other. The transform decides which remedy a row
    // gets from the row itself, and it checks the sentinel FIRST (that is the
    // only check that can be made from one document). A row that is both a
    // sentinel AND a `uri` duplicate would therefore be re-keyed instead of
    // dropped, leaving two rows sharing a `uri` and violating the very
    // constraint this rule exists to satisfy. Refusing the whole group is the
    // fail-closed answer, and it costs nothing today: production's 21 sentinel
    // rows carry 21 DISTINCT DIDs, so no such group exists.
    if (candidates.some((row) => row.sentinel)) continue;
    for (const id of federatedActorDuplicatesToDrop(candidates)) dropped.add(id);
  }
  return { dropped, inUriGroup };
}

/** Parse one `$group` bucket's pushed rows, discarding anything unusable. */
function readCandidates(rows: unknown): SentinelActorCandidate[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (row === null || typeof row !== 'object') return [];
    const entry = row as { id?: unknown; uri?: unknown; acct?: unknown; lastFetchedAt?: unknown };
    // A document with no `_id` cannot be named in the report, and a rule that
    // cannot report what it acted on has not answered anything — leaving it out
    // keeps the group unresolved, which blocks. Not reachable in Mongo, written
    // because the alternative is a silent drop.
    if (entry.id === undefined || entry.id === null) return [];
    return [
      {
        id: String(entry.id),
        uri: typeof entry.uri === 'string' ? entry.uri : '',
        sentinel: typeof entry.acct === 'string' && isUnresolvedAtprotoHandle(entry.acct),
        lastFetchedAt: entry.lastFetchedAt,
      },
    ];
  });
}

/**
 * Every sentinel-acct row whose re-key RESOLVES its collision — all but the
 * freshest of each group.
 *
 * The transform re-keys EVERY sentinel row, the freshest included, so the whole
 * population lands in the shape the fixed writer produces. This set is narrower
 * on purpose: it is the rows that have to MOVE for the group to stop colliding,
 * which is the question `resolvesUniquenessGroup` asks (all but one). The
 * freshest row's re-key is normalisation — the group would already be legal
 * without it — so counting it here would make the rule look like it empties the
 * group and the finding would block.
 *
 * Every row belonging to a `uri`-colliding group is excluded — see
 * {@link planFederatedActorDuplicates}'s `inUriGroup`. That is what keeps the
 * two remedies from claiming one document, and it is not vacuous: a sentinel
 * row that shares a `uri` slipped through an earlier version of this and made
 * the `uri` finding read as answered while the copy would have violated the
 * constraint.
 */
async function planSentinelActorRekeys(
  source: MongoSource,
  excluded: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  const rekeyed = new Set<string>();
  const groups = await source
    .collection('federatedactors')
    .aggregate<{ rows?: unknown }>(
      [
        // Matched on the VALUE rather than scanned: the sentinel is one exact
        // string, so Mongo answers from `acct` alone.
        { $match: { acct: UNRESOLVED_HANDLE } },
        {
          $group: {
            _id: '$acct',
            rows: { $push: { id: '$_id', uri: '$uri', acct: '$acct', lastFetchedAt: '$lastFetchedAt' } },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
      ],
      { allowDiskUse: true }
    )
    .toArray();

  for (const group of groups) {
    // A row with no `uri` has no DID to be re-keyed ONTO, so it is left out and
    // its group keeps blocking — the same fail-closed answer as a missing `_id`.
    const candidates = readCandidates(group.rows).filter(
      (row) => row.uri.length > 0 && !excluded.has(row.id)
    );
    for (const id of federatedActorDuplicatesToDrop(candidates)) rekeyed.add(id);
  }
  return rekeyed;
}

/**
 * Run every rule's pre-pass against the source.
 *
 * Takes the source rather than reaching for one, so the audit phase and the
 * copy phase provably run it against the same database.
 */
export async function planResolutions(source: MongoSource): Promise<ResolutionPlan> {
  // Drops FIRST: the re-key set is computed against them so one document can
  // never be claimed by both remedies.
  const { dropped, inUriGroup } = await planFederatedActorDuplicates(source);
  // Excluded by `inUriGroup`, not by `dropped`: a sentinel row in a REFUSED uri
  // group was never dropped, and re-keying it would both break the `uri`
  // constraint and make that group's finding look answered.
  const rekeyed = await planSentinelActorRekeys(source, inUriGroup);
  return {
    actedOn: new Map([[KEEP_FRESHEST_FEDERATED_ACTOR.id, new Set([...dropped, ...rekeyed])]]),
  };
}

// ---------------------------------------------------------------------------
// the context a transform runs under
// ---------------------------------------------------------------------------

/** Everything a transform needs to apply the documented rules. */
export interface ResolutionContext {
  /** Rows a rule has decided to act on, by rule id. */
  readonly actedOn: ReadonlyMap<string, ReadonlySet<string>>;
  /** Record that a rule changed what a document becomes. */
  readonly record: (entry: ResolutionRecord) => void;
  /**
   * Record that a documented rule removes an entire document.
   *
   * The transform then emits NOTHING for it, which would otherwise read as a
   * `dropped-document` finding — the check that says a transform is losing
   * data. Both are real and they must stay distinguishable: a drop nobody
   * decided is a bug that blocks and no rule may clear, while a drop a rule
   * recorded BY ID is a decision that has already been reviewed. This is the
   * channel that separates them, and it is the only thing `droppedDocuments`
   * subtracts.
   *
   * A transform that simply returns without emitting and without calling this
   * still blocks, which is the correct default.
   */
  readonly dropDocument: (
    rule: ResolutionRule,
    collection: string,
    documentId: string,
    detail: string,
    /**
     * The `within` key to record under, when a ROW-level record for the same
     * rule and document already exists and this one SUPERSEDES it.
     *
     * `ResolutionLog.record` is keyed on `(rule, document, within)`, so a drop
     * that follows a row-level drop of the same document under the same rule
     * must reuse that key or the rule reports twice for one document — a count
     * the operator checks against the audit's. See `transformDocument`.
     */
    within?: string
  ) => void;
  /** How many documents of this collection a rule removed whole. */
  readonly documentsDroppedIn: (collection: string) => number;
  /**
   * Did a rule remove THIS document whole — so it produces no row at all?
   *
   * Asked by the column-coverage audit, which counts a source field against the
   * column it lands in. A rule-dropped document emits nothing, so it can
   * contribute nothing to the populated side; counting it on the source side
   * makes the two counts describe different sets of documents and manufactures
   * a coverage gap that is not one.
   *
   * Deliberately NOT "emitted no rows", which is a wider predicate and would
   * silence a real finding: a transform that returns without emitting and
   * WITHOUT calling {@link dropDocument} is an undecided drop, and
   * `dropped-document` exists to block exactly that. Only a drop a rule
   * recorded by id is excluded here.
   */
  readonly wasDropped: (collection: string, documentId: string) => boolean;
  /**
   * Does a rule already answer this uniqueness collision?
   *
   * Asked by `auditUniqueness`, so `audit.ts` needs no knowledge of any
   * particular rule. True only when the rule acts on all but ONE of the group's
   * rows — the survivor. A group it would empty entirely, or one it does not
   * touch, is NOT resolved and still blocks: FAIL-CLOSED, because only a human
   * can say whether a collision the rule was not written for matters.
   *
   * With no rules declared this answers `false` for everything, so every
   * collision blocks. That is the correct inert state, not a stub.
   */
  readonly resolvesUniquenessGroup: (rule: ResolutionRule, ids: readonly string[]) => boolean;
}

/** Bind a plan and a log into the context a transform is called with. */
export function createResolutionContext(
  plan: ResolutionPlan,
  log: ResolutionLog
): ResolutionContext {
  return {
    actedOn: plan.actedOn,
    record: (entry) => {
      log.record(entry);
    },
    dropDocument: (rule, collection, documentId, detail, within) => {
      log.record({ rule, documentId, detail, ...(within === undefined ? {} : { within }) });
      log.dropDocument(collection, documentId);
    },
    documentsDroppedIn: (collection) => log.documentsDroppedIn(collection),
    wasDropped: (collection, documentId) => log.wasDropped(collection, documentId),
    resolvesUniquenessGroup: (rule, ids) => {
      const acted = plan.actedOn.get(rule.id);
      if (acted === undefined || ids.length < 2) return false;
      // All but ONE. A rule that would empty the group has not decided which row
      // survives, so it has not answered the finding.
      return ids.filter((id) => acted.has(id)).length === ids.length - 1;
    },
  };
}

// ---------------------------------------------------------------------------
// the parent set a rule decides against
// ---------------------------------------------------------------------------

/**
 * The parent rows a rule decides against — supplied per phase, never cached.
 *
 * ## Why this is a parameter and not a snapshot
 *
 * The rules answer one question: "will this reference name a row Postgres
 * holds?" The only correct set to ask that of is the one the FOREIGN KEY will
 * check against, and a set read from MongoDB minutes earlier is not it.
 * Production Mongo takes writes throughout the cutover, so such a set is stale
 * by construction, and a row created inside that window is indistinguishable
 * from a parent deleted years ago. This is not hypothetical: the sibling
 * migration measured its `users` count moving 60,673 → 60,843 → 60,847 across
 * one attempt's three passes, and its overreach guard caught a rule about to
 * remove 8 rows whose parents were alive.
 *
 * So there is no cached set. Each phase supplies the set it can PROVE:
 *
 * | phase | the set | why it is exact |
 * |---|---|---|
 * | copy | `select id from <parent>` at the start of the LEVEL | the FK checks that same table microseconds later, and levels are topological so every parent row is already committed |
 * | audit | the ids the traversal has emitted so far | nothing is written yet, and level order means the parents are complete before a child is inspected |
 * | verify | the same query as the copy | it is checking what the copy wrote |
 *
 * ## It REFUSES rather than degrades
 *
 * {@link keysFor} throws for a table nobody loaded. There is deliberately no
 * fallback: a rule that quietly answered from the wrong parent set is precisely
 * the bug this shape exists to prevent, and "the set was unavailable" must stop
 * the run rather than change the answer. An EMPTY set is a different thing and
 * is honoured — it means the parent table holds nothing, which makes the rules
 * inert and leaves the orphans blocking, which is the decision a human has to
 * make anyway.
 *
 * ## What this does NOT fix
 *
 * It does not make the copy a snapshot. A row written to Mongo after its level
 * is copied is not in Postgres, and a child of it copied later still dangles —
 * that is a cutover-design problem (a write freeze, or a delta pass), not one a
 * predicate can solve, and nothing here pretends otherwise.
 */
export interface ParentKeys {
  /**
   * Every primary key the parent table holds, for the phase asking.
   *
   * @throws {MissingParentKeysError} When that table was not loaded.
   */
  keysFor(table: PgTable): ReadonlySet<string>;
}

/** Raised when a rule needs a parent set nobody supplied. */
export class MissingParentKeysError extends Error {
  constructor(
    readonly table: string,
    readonly loaded: readonly string[]
  ) {
    super(
      `No parent keys were loaded for ${table}, so a documented resolution ` +
        'cannot decide whether a reference to it resolves. Loaded: ' +
        `${loaded.join(', ') || '(none)'}. The run is refused rather than ` +
        'answered from a different set — deciding against the wrong parents is ' +
        'exactly the failure this contract exists to prevent.'
    );
    this.name = 'MissingParentKeysError';
  }
}

/** Bind an already-loaded map of parent keys into a {@link ParentKeys}. */
export function parentKeysFrom(loaded: ReadonlyMap<string, ReadonlySet<string>>): ParentKeys {
  return {
    keysFor(table) {
      const keys = loaded.get(tableName(table));
      if (keys === undefined) {
        throw new MissingParentKeysError(tableName(table), [...loaded.keys()]);
      }
      return keys;
    },
  };
}

/**
 * A parent set for a pass that is NOT deciding references at all.
 *
 * THREE distinct answers exist here and only two of them were reachable before
 * the first orphan resolution was declared, which is why this is a late
 * addition rather than part of the original design:
 *
 *  - **unloaded** (`parentKeysFrom(new Map())`) — THROWS. The copy must never
 *    decide a reference against a set nobody built, so the run is refused.
 *  - **loaded and empty** — stands the rules down. "This table holds no rows
 *    yet" is a real answer and it is honoured.
 *  - **not consulted** — this. The caller runs transforms for a purpose that
 *    has nothing to do with references (measuring defaulted columns, or
 *    building the key set the reference check will later use), so there is no
 *    reference decision to get wrong.
 *
 * The first two were indistinguishable in practice while `ORPHAN_RESOLUTIONS`
 * was empty, because `resolveOrphanedReferences` returned before ever calling
 * `keysFor`. Declaring the first resolution on `posts` woke that path up and
 * the audit's own defaulted-column pass — which had always passed an unloaded
 * set, correctly, since it decides nothing — started refusing the whole run.
 *
 * **The COPY must never use this.** Its fail-closed refusal is the thing that
 * stops a reference being decided against the wrong parents; this exists only
 * for passes that make no such decision, and `backfillOrphanResolutions.test.ts`
 * pins that the copy still refuses an unloaded set.
 */
export function parentKeysNotConsulted(): ParentKeys {
  const none: ReadonlySet<string> = new Set();
  return { keysFor: () => none };
}

/** Every parent table an `absent-parent` rule decides against. */
export function parentTablesForRules(): PgTable[] {
  const seen = new Set<string>();
  const tables: PgTable[] = [];
  for (const relation of ORPHAN_RESOLUTIONS) {
    // A cascade reads no parent set: its trigger is a removal this run
    // performed, not a row's presence anywhere.
    if (relation.trigger !== 'absent-parent') continue;
    const name = tableName(relation.targetTable);
    if (seen.has(name)) continue;
    seen.add(name);
    tables.push(relation.targetTable);
  }
  return tables;
}

// ---------------------------------------------------------------------------
// running a transform under the rules
// ---------------------------------------------------------------------------

/** One documented rule that fired on one emitted row. */
export interface AppliedOrphanResolution {
  readonly relation: OrphanRelation;
  /** The value the row carried — absent from the parent set, which is why it fired. */
  readonly value: string;
}

/**
 * One row a document produced, with what the documented rules did to it.
 *
 * `source` and `written` are BOTH carried, and the split is the whole point:
 *
 * - The **audit** checks references on `source`, so every orphan is still
 *   found, counted and named even when a rule removes the row that carried it.
 *   A rule that made the finding disappear would be a silenced check, which
 *   this file exists not to be.
 * - Everything that WRITES uses `written`, and cannot write a dropped row by
 *   accident: `written` is `null` for one, so a consumer has to handle the null
 *   before it has a row at all.
 */
export interface ResolvedRow {
  readonly table: PgTable;
  /** The row the transform built. Never written; it is the report's evidence. */
  readonly source: Record<string, unknown>;
  /** The row to WRITE, or `null` when a rule drops it entirely. */
  readonly written: Record<string, unknown> | null;
  /** Every rule that acted on it. Empty for the overwhelming majority of rows. */
  readonly applied: readonly AppliedOrphanResolution[];
}

/** What a record names when the document carries no `_id` to name it by. */
const UNIDENTIFIED_DOCUMENT = '(document has no _id)';

/**
 * The key a document is recorded under — by `dropDocument`, by every resolution
 * record, and by anything that later asks whether one of those fired.
 *
 * Exported because {@link ResolutionContext.wasDropped} is a lookup, and a
 * lookup whose key is derived a SECOND time somewhere else is a lookup that
 * silently misses the moment the two derivations drift. One definition means
 * the audit cannot ask about a key the log never wrote.
 */
export function resolutionDocumentId(doc: MongoDocument): string {
  return describeId(doc) ?? UNIDENTIFIED_DOCUMENT;
}

/**
 * Run a plan's transform and apply the documented ROW-level resolutions to
 * everything it emits.
 *
 * EVERY caller of `plan.transform` goes through this — the copy, both of the
 * verifier's passes, and the referential audit — which is what makes the
 * decisions identical across them by construction rather than by four call
 * sites remembering. It is also why orphan rules are NOT written inside the
 * transforms: a transform describes the MAPPING, one document to its rows, and
 * a rule that erases a row is not part of that description.
 */
export function transformDocument(
  plan: CollectionPlan,
  doc: MongoDocument,
  resolutions: ResolutionContext,
  /**
   * The parent rows to decide against — {@link ParentKeys}.
   *
   * A required PARAMETER rather than something the context carries, so no
   * caller can run a transform without saying which set of parents it is
   * entitled to answer from. The type system is the enforcement: the phase that
   * knows is the phase that supplies.
   */
  parents: ParentKeys,
  emit: (row: ResolvedRow) => void
): void {
  const documentId = resolutionDocumentId(doc);

  // The document's rows are COLLECTED before any is emitted, because a cascade
  // is a question about a SIBLING row: "was the parent this row names removed?"
  // Resolving as rows arrive would answer it from whatever had been seen so
  // far, making the outcome depend on the order a transform happens to emit in.
  // Buffering is one document's worth of rows, which the transform has already
  // built anyway.
  const built: Array<{ table: PgTable; row: Record<string, unknown> }> = [];
  plan.transform(
    doc,
    (table, row) => {
      built.push({ table, row });
    },
    resolutions
  );

  // Pass 1 — the rules that read the SOURCE: a value naming a parent Postgres
  // does not hold.
  const resolved = built.map((entry) =>
    resolveOrphanedReferences(entry.table, entry.row, documentId, resolutions, parents)
  );

  // Pass 1b — a rule that drops the plan's PRIMARY row drops the DOCUMENT.
  //
  // This is not a cascade over declared relations, and it must not be confused
  // with one. A `CollectionPlan`'s `childTables` exist ONLY to hang off its
  // `table`: every row a plan emits into a child table carries a foreign key to
  // the row it emits into `table`, declared `ON DELETE CASCADE` in the schema.
  // So a rule that removes that one row has removed the only thing every other
  // row of the document points at, and writing the rest is writing rows whose
  // parent the same document decided not to write.
  //
  // Found by the copy, not by reasoning: `drop-boost-of-a-post-mention-never-held`
  // removes the `posts` row and the run died 26 minutes in on
  // `post_authorships_post_id_posts_id_fk`. The rule's own decision says the
  // drop "strands no child" — true of every Mongo collection that REFERS to a
  // boost (replies, quotes, boosts, likes, recent repliers, all measured), and
  // silent about the child rows the boost's OWN document emits. `authorship[]`
  // is required on every post, so every one of the 348 dropped boosts stranded
  // exactly one.
  //
  // Deliberately not `cascadeWithinDocument`: that mechanism needs a declared
  // relation per child table and would have to be extended again for every
  // child added — and it cannot chain, so a grandchild (`post_variant_media`
  // under `post_content_variants`) would still be stranded. Dropping the whole
  // document needs no enumeration and has no depth.
  //
  // The mirror-image risk — that removing NINE child rows instead of one parent
  // row strands something OUTSIDE the document — is measured, not assumed. Of
  // the nine tables the posts plan writes, exactly two are the target of any
  // foreign key at all (`post_variant_media` and `post_variant_alt_texts`, both
  // pointing at `post_content_variants`), and both references come from rows the
  // SAME document emits, which this pass removes in the same step. Nothing
  // outside a document points at any of these ids, so the drop cannot manufacture
  // an orphan in the other direction.
  //
  // `every` rather than `some`, and it is load-bearing for a FLATTENING plan
  // (`post_recent_repliers` emits one row per replier). Today all its rows carry
  // the one `postId`, so the rule's answer is the same for every one of them and
  // the document is all-or-nothing. A future plan where only SOME primary rows
  // drop still produces rows, so the document must survive — `some` would delete
  // the ones nothing was wrong with.
  const primaryRows = resolved.filter((row) => tableName(row.table) === tableName(plan.table));
  const primaryDrop =
    primaryRows.length > 0 &&
    primaryRows.every((row) => row.written === null && row.applied.length > 0)
      ? primaryRows[0]?.applied.find((entry) => entry.relation.action === 'drop-row')
      : undefined;
  if (primaryDrop !== undefined) {
    const siblings = resolved.filter((row) => row !== primaryRows[0] && row.written !== null);
    resolutions.dropDocument(
      primaryDrop.relation.rule,
      plan.collection,
      documentId,
      `${tableName(plan.table)}.${primaryDrop.relation.columnName} is ` +
        `${JSON.stringify(primaryDrop.value)}, which no ` +
        `\`${primaryDrop.relation.parentCollection}\` document holds, so the row ` +
        'is dropped — and with it the WHOLE document: ' +
        (siblings.length === 0
          ? 'it emitted no other row.'
          : `${siblings.length} further row(s) in ` +
            `${[...new Set(siblings.map((row) => tableName(row.table)))].sort().join(', ')}, ` +
            'each of which carries a foreign key to the dropped row and would ' +
            'violate it. The schema declares ON DELETE CASCADE for every one.'),
      // The same `within` the row-level record used, so the two collapse into
      // ONE record rather than reporting this document twice under one rule.
      primaryDrop.value
    );
    for (const row of resolved) emit({ ...row, written: null });
    return;
  }

  // Pass 2 — the declared CONSEQUENCES of pass 1, and only within this document.
  for (const row of cascadeWithinDocument(resolved, documentId, resolutions)) emit(row);
}

/**
 * Apply the declared `parent-dropped` cascades to one document's rows.
 *
 * The narrowness is the whole design, so it is worth stating what this CANNOT
 * do. It cannot reach a row from another document. It cannot fire on a relation
 * nobody declared, even one pointing at the same table — an undeclared relation
 * still blocks. And it cannot chain: a row this removes is not itself a
 * trigger, because triggers are matched against the keys pass 1 removed, not
 * against everything gone by the end.
 */
function cascadeWithinDocument(
  rows: readonly ResolvedRow[],
  documentId: string,
  resolutions: ResolutionContext
): readonly ResolvedRow[] {
  if (CASCADE_RESOLUTIONS.length === 0) return rows;

  // What pass 1 removed, by table and primary key.
  const removed = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.written !== null || row.applied.length === 0) continue;
    const key = singlePrimaryKeyProperty(row.table);
    if (key === null) continue;
    const value = row.source[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    const name = tableName(row.table);
    const keys = removed.get(name);
    if (keys) keys.add(value);
    else removed.set(name, new Set([value]));
  }
  if (removed.size === 0) return rows;

  return rows.map((row) => {
    if (row.written === null) return row;
    const name = tableName(row.table);
    for (const relation of CASCADE_RESOLUTIONS) {
      if (relation.tableName !== name) continue;
      const value = row.source[relation.property];
      if (typeof value !== 'string' || value.length === 0) continue;
      if (!(removed.get(tableName(relation.targetTable))?.has(value) ?? false)) continue;
      return cascadedRow(row, relation, value, documentId, resolutions);
    }
    return row;
  });
}

/** The row a cascade removes, recorded and returned unwritten. */
function cascadedRow(
  row: ResolvedRow,
  relation: OrphanRelation,
  value: string,
  documentId: string,
  resolutions: ResolutionContext
): ResolvedRow {
  const key = singlePrimaryKeyProperty(relation.table);
  const rowId = key === null ? null : row.source[key];
  const evidence = carriedColumns(relation, row.source);

  resolutions.record({
    rule: relation.rule,
    documentId,
    // The ROW's own key, not the offending value: one document produces many
    // children of one parent, so keying on the parent id would collapse them
    // into a single record and the report would name one of the rows it
    // stranded.
    within: typeof rowId === 'string' ? rowId : value,
    detail:
      `${relation.tableName}.${relation.columnName} is ${JSON.stringify(value)}, ` +
      `a \`${tableName(relation.targetTable)}\` row that ` +
      `\`${relation.cascadesFrom?.rule.id ?? '(unknown rule)'}\` removes. The ROW ` +
      'is dropped with it: ON DELETE CASCADE is what the schema declares for ' +
      'this relation, and the removal it names has already happened.',
    ...(evidence === null ? {} : { evidence }),
  });

  return {
    table: row.table,
    source: row.source,
    written: null,
    applied: [...row.applied, { relation, value }],
  };
}

/**
 * Apply every declared orphan resolution to one emitted row.
 *
 * NARROW BY CONSTRUCTION, and the narrowness is worth spelling out because a
 * widened predicate here DELETES PRODUCTION ROWS:
 *
 * - Only a table named in {@link ORPHAN_RESOLUTIONS} is considered at all;
 *   every other row returns with `written === source` and nothing recorded.
 * - Only the ONE declared column of each entry is read.
 * - A NULL, absent or non-string value is left alone — a NULL component
 *   satisfies the constraint unconditionally, so there is no orphan to answer.
 * - The value must be ABSENT from the parent set THIS PHASE supplied — the rows
 *   Postgres holds when the level is copied, never a snapshot of Mongo taken
 *   earlier.
 * - An EMPTY parent set stands the rule down entirely; an UNLOADED one refuses
 *   the run ({@link MissingParentKeysError}).
 */
function resolveOrphanedReferences(
  table: PgTable,
  row: Record<string, unknown>,
  documentId: string,
  resolutions: ResolutionContext,
  parents: ParentKeys
): ResolvedRow {
  const declared = ORPHAN_RESOLUTIONS_BY_TABLE.get(tableName(table));
  if (declared === undefined) return { table, source: row, written: row, applied: [] };

  const applied: AppliedOrphanResolution[] = [];
  let dropped = false;
  let written = row;

  for (const relation of declared) {
    // THROWS for a table nobody loaded — never a fallback. An EMPTY set is a
    // different answer and is honoured.
    const known = parents.keysFor(relation.targetTable);
    if (known.size === 0) continue;
    const value = row[relation.property];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (known.has(value)) continue;

    applied.push({ relation, value });
    if (relation.action === 'drop-row') dropped = true;
    else written = { ...written, [relation.property]: null };

    // Read off the SOURCE row: the columns a rule carries describe what the row
    // pointed at, and for a dropped row there will be nothing else left to read
    // them from.
    const evidence = carriedColumns(relation, row);

    resolutions.record({
      rule: relation.rule,
      documentId,
      // One document can produce several rows for the same relation, so the
      // record is keyed by the offending value too rather than collapsing them.
      within: value,
      detail:
        `${relation.tableName}.${relation.columnName} is ${JSON.stringify(value)}, ` +
        `which no \`${relation.parentCollection}\` document holds. ` +
        (relation.action === 'drop-row'
          ? 'The ROW is dropped and nothing else about it is written; ON DELETE ' +
            "CASCADE is the schema's own answer to a missing parent. " +
            (relation.whyNotNull === undefined
              ? 'The column is NOT NULL, so no value satisfies the constraint.'
              : 'The column is NULLABLE and NULL was deliberately not written — ' +
                'see the rule.')
          : 'The COLUMN is written NULL and the row is KEPT; the column is ' +
            'nullable with ON DELETE SET NULL, which is exactly where that ' +
            'policy puts a row whose parent is gone. Every other column is ' +
            'written verbatim.'),
      ...(evidence === null ? {} : { evidence }),
    });
  }

  return { table, source: row, written: dropped ? null : written, applied };
}

/**
 * The columns a rule carries, read off the row it is acting on.
 *
 * `null` when the rule carries none. A declared column the row does not hold is
 * REPORTED as `(absent)` rather than omitted: a worklist entry silently missing
 * its key would be worse than one that says the key was not there.
 */
function carriedColumns(
  relation: OrphanRelation,
  row: Record<string, unknown>
): Record<string, string> | null {
  if (relation.carry === undefined || relation.carry.length === 0) return null;
  const carried: Record<string, string> = {};
  for (const column of relation.carry) {
    const value = row[column.name];
    carried[sqlColumnName(column)] =
      value === null || value === undefined ? '(absent)' : String(value);
  }
  return carried;
}
