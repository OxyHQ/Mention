/**
 * One-shot HARD-PURGE of confirmed-dead (410 Gone) federated identities.
 *
 * WHY
 *   `pruneGoneFederatedActors` TOMBSTONES a remote actor whose profile fetch
 *   returns 410 Gone (`federated_actors.suspended = true` + oxy-api ARCHIVE via
 *   `/federation/actor-gone`). Archiving is reversible and leaves every reference
 *   in place: the row, the linked Oxy identity, its posts, follow edges, likes,
 *   notifications, MTN records. After an archive pass confirmed a set of actors are
 *   permanently gone (7,704 in prod at the time of writing), this script is the
 *   IRREVERSIBLE follow-up — it removes the explicitly supported references
 *   below, then removes the identity in Oxy. A fail-closed preflight refuses the
 *   actor when any other known reference exists.
 *
 *   Because it is irreversible, every candidate is RE-VERIFIED against the remote
 *   server immediately before anything is deleted (see below). A candidate that has
 *   resurrected since the archive pass is NOT purged — its tombstone is cleared and
 *   it is left fully intact.
 *
 * SCOPE GATE (safety)
 *   Operates ONLY on `federated_actors` rows with `suspended = true` — the archive pass's
 *   confirmed-410 set. A non-suspended (live) actor is NEVER touched, even when
 *   targeted by `--actor` (the gate is part of the base filter, not an option).
 *   atproto actors are excluded (`protocol != 'atproto'`): 410-on-actor-fetch is an
 *   ActivityPub notion — a Bluesky DID has no AP actor endpoint to return 410.
 *
 * RE-VERIFY (self-correcting; the reason this is safe to run)
 *   Per candidate, re-fetch the actor via the SAME signed path the live code and
 *   the prune sweep use (`signedFetch(uri, AP_CONTENT_TYPE)`), then:
 *     - 410 Gone   → CONFIRMED gone; proceed to the destructive cascade below.
 *     - 2xx OK      → RESURRECTED since the archive pass. Do NOT delete anything —
 *                     clear the tombstone (`suspended = false`) and skip.
 *     - anything else / transient error → `unverified`; leave the actor fully
 *                     intact for a later run. ONLY a definitive 410 destroys data.
 *
 * DELETE ORDER (per confirmed-gone actor with owner id X and actor uri U)
 *   Mention references are removed FIRST, the Oxy identity is removed SECOND, and
 *   the `federated_actors` row (the retry anchor) is dropped LAST — see "ORDERING
 *   GUARANTEE" for why this exact order is the one that can never orphan an Oxy
 *   user:
 *     1. Posts owned by X and their
 *        engagement cascade: delete `Like`/`Bookmark` docs on those post ids AND
 *        the boost `Post`s (`type:'boost'`, `boostOf` ∈ those ids) that would
 *        otherwise render blank, then delete the authored posts themselves.
 *        (Other users' ORIGINAL replies to X's posts are deliberately LEFT — they
 *        are their authors' content, not X's; prod found 0 such replies. They keep
 *        their now-dangling `parentPostId`, which hydration already tolerates.)
 *     2. `$pull` X from every other post's `mentions[]`.
 *     3. `Like` docs X authored (`userId:X`).
 *     4. `federated_follows` edges referencing U (`remote_actor_uri = U`) — both
 *        directions (inbound + outbound) key the remote side by uri.
 *     5. `EntityFollow` (`userId:X`).
 *     6. `Notification` (`recipientId:X` OR `actorId:X`).
 *     7. Defensive local-only rows a federated actor should never have but is
 *        purged if present, each keyed on `oxyUserId:X`: `UserSettings`,
 *        `UserBehavior`, `UserFeedPreference`, `AuthorFollowerSnapshot`,
 *        `actor_key_pairs`, `MentionUserNode`, `MentionRepoHead`,
 *        `MentionSignedRecord`, `MentionNodeIngestWitness`.
 *     8. Oxy identity: `deleteFederatedActorIdentity(X)` → oxy-api hard-deletes the
 *        Oxy `User` + its follow edges (both directions, counts repaired) + blocks
 *        + caches. Only when this returns `deleted`/`absent` (identity CONFIRMED
 *        gone) do we continue.
 *     9. delete the `federated_actors` row — the anchor, dropped LAST.
 *
 * ORDERING GUARANTEE (why no Oxy user is ever orphaned on partial failure)
 *   Two invariants, in tension, resolved by the exact order above:
 *     (a) Mention refs BEFORE the Oxy identity — a mid-cascade failure leaves the
 *         Oxy `User` still LIVE and the `federated_actors` anchor intact, so a re-run
 *         reconciles it and no surviving Mention content ever points at a deleted
 *         Oxy user.
 *     (b) The `federated_actors` anchor is dropped ONLY AFTER the Oxy delete returns
 *         `deleted`/`absent`. If the Oxy delete returns `failed` (transient) or
 *         `skipped` (permanent 4xx), the anchor is KEPT and the actor is reported
 *         `partial` — so a LIVE Oxy user always has a surviving `federated_actors`
 *         row a re-run will re-process. The candidate set is `{ suspended:true }`;
 *         a dropped anchor is invisible to any future run, so dropping it before
 *         the Oxy identity is confirmed gone would strand a live Oxy user with no
 *         record to finish the delete. That never happens here.
 *   (This deliberately reorders the naive "row then identity" listing: the row must
 *   outlive an unconfirmed Oxy delete.)
 *
 * FLAGS (plain argv):
 *   --dry-run          COUNT what WOULD be deleted per collection (and per-actor +
 *                      totals); call NOTHING destructive — no Mongo delete, no
 *                      tombstone clear, no oxy-api actor-delete. The re-verify still
 *                      runs so the summary reflects reality.
 *   --limit N          cap the number of actors processed (a canary budget).
 *   --actor <uri>      restrict to one actor by its stored `federated_actors.uri`
 *                      (still gated to the suspended, non-atproto set).
 *   --concurrency N    actors probed/purged in parallel (default 8, clamped to 32).
 *
 * Idempotent + forward-only: batched by a stable ASCENDING actor `id` cursor. Re-running
 * is safe — a purged actor is gone from the candidate set; a `partial` actor
 * re-verifies 410, re-runs the (now no-op) deletes, and retries the Oxy delete.
 *
 * RUN AS A FARGATE ONE-SHOT (post-deploy, in-VPC — the oxy-api call needs the
 * service credential + in-VPC egress):
 *   bun packages/backend/dist/src/scripts/purgeGoneFederatedActors.js --dry-run
 *   CONFIRM_ADMIN_MUTATION=purgeGoneFederatedActors \
 *     bun packages/backend/dist/src/scripts/purgeGoneFederatedActors.js --limit 100
 *
 * RUN OVER THE SSM TUNNEL (prod Mongo forwarded to 127.0.0.1:47017) — DRY-RUN ONLY
 * is meaningful here; a live run's oxy-api call needs in-VPC service auth:
 *   MONGODB_URI='mongodb://127.0.0.1:47017/?directConnection=true' \
 *   NODE_ENV=production \
 *   bun packages/backend/src/scripts/purgeGoneFederatedActors.ts --dry-run --limit 50
 */

import mongoose from 'mongoose';
import { and, count, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { PostType } from '@mention/shared-types';
import { connectToDatabase } from '../utils/database';
import { connectPostgres, getDb } from '../db/postgres';
import {
  countActors,
  deleteActorsByUris,
  scanActors,
  updateActorSuspended,
  type ActorScanFilter,
} from '../db/federation/actorRepository';
import { posts } from '../db/schema/posts';
import { postAuthorships, postMentions } from '../db/schema/postContent';
import { bookmarks, entityFollows, likes } from '../db/schema/engagement';
import { authorFollowerSnapshots, notifications } from '../db/schema/discovery';
import { userBehaviors, userSettings } from '../db/schema/userProfile';
import { userFeedPreferences } from '../db/schema/feeds';
import { deleteFollowsFor, findFollows } from '../db/federation/followRepository';
import {
  deleteActorKeyPair,
  hasActorKeyPair,
} from '../db/federation/actorKeyPairRepository';
import {
  mentionNodeIngestWitnesses,
  mentionRepoHeads,
  mentionSignedRecords,
  mentionUserNodes,
} from '../db/schema/mtn';
import { deleteFederatedActorIdentity } from '../connectors/identity';
import type { DeleteActorIdentityOutcome } from '@oxyhq/federation/node';
import { signedFetch } from '../connectors/activitypub/helpers';
import { AP_CONTENT_TYPE } from '../connectors/activitypub/constants';
import { logger } from '../utils/logger';
import { mapWithConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '../utils/concurrency';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  DeletionPreflightError,
  assertActorSafeToDelete,
  assertPostsSafeToDelete,
  type PostDeletionTarget,
} from './lib/adminDeletionPreflight';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

/** Actors scanned per page (stable actor `id` cursor pagination). */
const PAGE_SIZE = 500;

/**
 * Hard wall-clock cap on the read-only remote re-verification. The destructive
 * cascade is not raced because a losing Promise cannot be cancelled and must not
 * continue mutating after the caller reports a timeout.
 */
const ACTOR_PURGE_TIMEOUT_MS = 60_000;

/** The `federated_actors` fields the purge reads. */
interface ActorRow {
  id: string;
  uri: string;
  acct: string;
  oxyUserId?: string;
}

/** Re-verify verdict. Only `gone` (410) proceeds to the destructive cascade. */
type Verdict = 'gone' | 'resurrected' | 'unverified';

/**
 * Terminal state of a single actor:
 *  - `purged`      — confirmed 410; all refs + Oxy identity + anchor removed.
 *  - `partial`     — confirmed 410; Mention refs removed but the Oxy delete did not
 *                    confirm (transient/permanent), so the anchor was KEPT for retry.
 *  - `resurrected` — re-verify returned 200; tombstone cleared, nothing deleted.
 *  - `unverified`  — re-verify non-410/transient, or a per-actor error; left intact.
 */
type PurgeOutcome = 'purged' | 'partial' | 'resurrected' | 'unverified';

/** How the Oxy identity delete resolved (or why it was not attempted). */
type OxyDisposition = DeleteActorIdentityOutcome | 'dry-run' | 'no-user' | 'not-reached';

/** Per-collection deletion counts (deleted, or WOULD-delete under `--dry-run`). */
interface CollectionCounts {
  authoredPosts: number;
  boostsOfAuthored: number;
  likesOnAuthored: number;
  bookmarksOnAuthored: number;
  mentionsDelinked: number;
  likesByActor: number;
  federatedFollows: number;
  entityFollows: number;
  notifications: number;
  userSettings: number;
  userBehavior: number;
  userFeedPreference: number;
  authorFollowerSnapshots: number;
  actorKeyPairs: number;
  mentionUserNodes: number;
  mentionRepoHeads: number;
  mentionSignedRecords: number;
  mentionNodeIngestWitnesses: number;
  federatedActor: number;
}

/** Every collection-count key, for zeroing + summing without missing a field. */
const COLLECTION_KEYS: readonly (keyof CollectionCounts)[] = [
  'authoredPosts',
  'boostsOfAuthored',
  'likesOnAuthored',
  'bookmarksOnAuthored',
  'mentionsDelinked',
  'likesByActor',
  'federatedFollows',
  'entityFollows',
  'notifications',
  'userSettings',
  'userBehavior',
  'userFeedPreference',
  'authorFollowerSnapshots',
  'actorKeyPairs',
  'mentionUserNodes',
  'mentionRepoHeads',
  'mentionSignedRecords',
  'mentionNodeIngestWitnesses',
  'federatedActor',
];

function emptyCounts(): CollectionCounts {
  const counts = {} as CollectionCounts;
  for (const key of COLLECTION_KEYS) counts[key] = 0;
  return counts;
}

function addCounts(into: CollectionCounts, from: CollectionCounts): void {
  for (const key of COLLECTION_KEYS) into[key] += from[key];
}

interface ActorPurgeResult {
  outcome: PurgeOutcome;
  oxy: OxyDisposition;
  counts: CollectionCounts;
}

interface Flags {
  dryRun: boolean;
  limit?: number;
  actor?: string;
  concurrency: number;
}

interface RunCounters {
  scanned: number;
  purged: number;
  partial: number;
  resurrected: number;
  unverified: number;
  blocked: number;
  oxyDeleted: number;
  oxyAbsent: number;
  oxySkipped: number;
  oxyFailed: number;
  totals: CollectionCounts;
}

// --- argv parsing (plain, mirrors pruneGoneFederatedActors) ------------------

/** Read the value of `--flag <value>` / `--flag=value` from argv. */
function readFlagValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1];
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function parseFlags(argv: string[]): Flags {
  const dryRun = argv.includes('--dry-run');

  const rawLimit = readFlagValue(argv, '--limit');
  let limit: number | undefined;
  if (rawLimit !== undefined) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--limit must be a positive integer (got "${rawLimit}")`);
    }
    limit = parsed;
  }

  const actor = readFlagValue(argv, '--actor')?.trim() || undefined;

  const rawConcurrency = readFlagValue(argv, '--concurrency');
  let concurrency = DEFAULT_CONCURRENCY;
  if (rawConcurrency !== undefined) {
    const parsed = Number.parseInt(rawConcurrency, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--concurrency must be a positive integer (got "${rawConcurrency}")`);
    }
    concurrency = Math.min(parsed, MAX_CONCURRENCY);
  }

  return { dryRun, limit, actor, concurrency };
}

// --- per-actor timeout (mirrors pruneGoneFederatedActors) --------------------

/** Distinct rejection raised when a read-only actor probe exceeds the cap. */
class ActorPurgeTimeoutError extends Error {
  constructor(ms: number) {
    super(`actor probe exceeded ${ms}ms hard timeout`);
    this.name = 'ActorPurgeTimeoutError';
  }
}

/**
 * Race only the read-only remote probe. The destructive cascade is deliberately
 * outside this race: JavaScript promises are not cancellable, so timing out a
 * mutating promise could report failure while its writes continued in the
 * background.
 */
function withActorTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActorPurgeTimeoutError(ms)), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// --- Mongo count-or-delete helpers -------------------------------------------

/**
 * Count (under `--dry-run`) or delete (live) the rows matching `where`, returning
 * the affected-row count either way. The single chokepoint that keeps dry-run
 * strictly read-only: NOTHING destructive runs when `dryRun` is set.
 *
 * ## Why this replaced a Mongoose `countOrDelete`
 *
 * Every table below moved to Postgres in an earlier batch, and this cascade kept
 * deleting from the Mongo collection of the same name — a `deleteMany` against a
 * collection nothing writes any more, which reports success having removed
 * nothing. That is worse than an unfinished port, because
 * `assertActorSafeToDelete` WAIVES the matching reference probes for this caller
 * (`allowGoneActorCascade`) precisely ON THE STRENGTH of this cascade. The gate
 * therefore did not block and the cascade did not clean: a purge completed,
 * reported real counts, and left the actor's likes, entity follows,
 * notifications, settings and follower snapshots behind, pointing at an identity
 * that no longer exists. Confirmed against a real row before the fix.
 *
 * `returning` is what makes the live count real — a delete without it hands back
 * a driver result whose shape is the driver's business, and a wrong read of it
 * would silently report 0 purged rows on a successful purge.
 */
async function countOrDelete(
  table: PgTable,
  idColumn: PgColumn,
  where: SQL,
  dryRun: boolean,
): Promise<number> {
  const db = getDb();
  if (dryRun) {
    const [row] = await db.select({ total: count() }).from(table).where(where);
    return row?.total ?? 0;
  }
  return (await db.delete(table).where(where).returning({ id: idColumn })).length;
}

/**
 * De-link X from every OTHER post's `mentions[]`. Under `--dry-run` this counts the
 * posts that WOULD be modified; live it `$pull`s and returns the modified count.
 */
async function delinkMentions(oxyUserId: string, dryRun: boolean): Promise<number> {
  // `post_mentions` is a child TABLE, so de-linking is a delete of the rows
  // naming this user rather than a `$pull` on an embedded array. The dry-run
  // count is of POSTS, not rows, matching what the live branch reports — the
  // unique `(post_id, oxy_user_id)` index makes the two equal, and counting
  // distinct posts says so rather than relying on it.
  const db = getDb();
  if (dryRun) {
    const [row] = await db
      .select({ count: sql<number>`count(distinct ${postMentions.postId})::int` })
      .from(postMentions)
      .where(eq(postMentions.oxyUserId, oxyUserId));
    return row?.count ?? 0;
  }
  const deleted = await db
    .delete(postMentions)
    .where(eq(postMentions.oxyUserId, oxyUserId))
    .returning({ postId: postMentions.postId });
  return new Set(deleted.map((row) => row.postId)).size;
}

// --- per-actor re-verify + cascade -------------------------------------------

/**
 * Re-fetch the actor via the SAME signed path the live code and the prune sweep
 * use, and classify. ONLY a definitive 410 is `gone`; a 2xx is `resurrected`; every
 * other status, a network error, or a malformed URI is `unverified`.
 */
async function verifyStillGone(uri: string): Promise<Verdict> {
  let res: Response;
  try {
    res = await signedFetch(uri, AP_CONTENT_TYPE);
  } catch (err) {
    logger.warn('[purgeGoneFederatedActors] re-verification fetch failed; actor left intact', {
      error: err,
    });
    return 'unverified';
  }

  if (res.status === 410) return 'gone';
  if (res.ok) return 'resurrected';

  logger.info('[purgeGoneFederatedActors] re-verification returned a non-gone status', {
    status: res.status,
  });
  return 'unverified';
}

/**
 * Delete the posts authored by X and cascade their engagement so nothing dangles:
 * the boost `Post`s that mirror those posts (they render blank once the original is
 * gone) and the `Like`/`Bookmark` docs on ANY of those post ids. Returns the counts
 * for step 1 of {@link purgeActor}.
 */
async function purgeAuthoredPosts(oxyUserId: string, dryRun: boolean, counts: CollectionCounts): Promise<void> {
  const db = getDb();
  const postSummary = {
    id: posts.id,
    activityId: posts.federationActivityId,
    url: posts.federationUrl,
  } as const;

  const authored = await db
    .select(postSummary)
    .from(posts)
    .where(or(
      eq(posts.oxyUserId, oxyUserId),
      // The OWNER entry in the authorship table — the authority the denormalized
      // `oxy_user_id` merely projects, so a post whose projection was never
      // written is still found.
      sql`exists (
        select 1 from ${postAuthorships}
        where ${postAuthorships.postId} = ${posts.id}
          and ${postAuthorships.oxyUserId} = ${oxyUserId}
          and ${postAuthorships.role} = 'owner'
      )`,
    ));
  if (authored.length === 0) return;

  const authoredIds = authored.map((p) => p.id);

  // Boosts (by ANYONE) of X's posts.
  const boosts = await db
    .select(postSummary)
    .from(posts)
    .where(and(eq(posts.type, PostType.BOOST), inArray(posts.boostOf, authoredIds)));
  const boostIds = boosts.map((p) => p.id);
  const allDeletedIds = [...authoredIds, ...boostIds];

  const deletionTargets: PostDeletionTarget[] = [...authored, ...boosts].map((post) => ({
    id: post.id,
    uris: [post.activityId, post.url].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  }));
  await assertPostsSafeToDelete(
    `purgeGoneFederatedActors:${oxyUserId}:posts`,
    deletionTargets,
    { removedByCascade: ['likes.post_id', 'bookmarks.post_id'] },
  );

  // Cascade engagement on every post about to be deleted (X's posts + their boosts)
  // FIRST, so no Like/Bookmark is left pointing at a deleted post.
  // Both tables carry `ON DELETE CASCADE` to `posts.id`, so the rows would go
  // with the posts anyway. Removing them FIRST is still what the step is for: it
  // is the difference between a cascade nobody chose and one this script states,
  // and the reported count is a count of rows that actually existed.
  counts.likesOnAuthored = await countOrDelete(
    likes, likes.id, inArray(likes.postId, allDeletedIds), dryRun,
  );
  counts.bookmarksOnAuthored = await countOrDelete(
    bookmarks, bookmarks.id, inArray(bookmarks.postId, allDeletedIds), dryRun,
  );
  // Then the posts themselves: the boosts, then X's authored posts. Every child
  // row goes with them by `ON DELETE CASCADE`, so there is no per-table cleanup
  // to keep in step here.
  counts.boostsOfAuthored = dryRun
    ? boostIds.length
    : (await db.delete(posts).where(inArray(posts.id, boostIds)).returning({ id: posts.id })).length;
  counts.authoredPosts = dryRun
    ? authoredIds.length
    : (await db.delete(posts).where(inArray(posts.id, authoredIds)).returning({ id: posts.id })).length;
}

/**
 * Purge ONE confirmed-gone actor (or, under `--dry-run`, count what would be
 * purged). Assumes the caller already re-verified 410. Fail-soft is provided by the
 * pool: a throw here is captured as that actor's rejected slot and never aborts the
 * sweep, and because every throw happens BEFORE the anchor is dropped, the actor
 * stays reconcilable by a later run.
 */
async function purgeConfirmedGone(actor: ActorRow, flags: Flags): Promise<ActorPurgeResult> {
  const counts = emptyCounts();
  const oxyUserId = actor.oxyUserId?.trim();

  await assertActorSafeToDelete(
    `purgeGoneFederatedActors:${actor.acct}`,
    { oxyUserId, actorUri: actor.uri },
    { allowGoneActorCascade: true },
  );

  // Steps 1-3, 5-7 are all keyed on the owner id X — only meaningful when the row
  // links to one. A suspended federated actor should always have an `oxyUserId`,
  // but a legacy row without one is still purgeable (uri-keyed refs + the anchor).
  if (oxyUserId) {
    await purgeAuthoredPosts(oxyUserId, flags.dryRun, counts); // 1
    counts.mentionsDelinked = await delinkMentions(oxyUserId, flags.dryRun); // 2
    counts.likesByActor = await countOrDelete(
      likes, likes.id, eq(likes.userId, oxyUserId), flags.dryRun,
    ); // 3
  }

  // 4. Federated follow edges — uri-keyed, so this runs even without an owner id.
  //     Same dry-run contract as `countOrDelete`: a dry run counts and writes
  //     nothing, a live run deletes and reports how many rows went.
  counts.federatedFollows = flags.dryRun
    ? (await findFollows({ remoteActorUri: actor.uri })).length
    : await deleteFollowsFor({ remoteActorUri: actor.uri });

  if (oxyUserId) {
    counts.entityFollows = await countOrDelete(
      entityFollows, entityFollows.id, eq(entityFollows.userId, oxyUserId), flags.dryRun,
    ); // 5
    counts.notifications = await countOrDelete(
      notifications,
      notifications.id,
      or(
        eq(notifications.recipientId, oxyUserId),
        eq(notifications.actorId, oxyUserId),
      ) as SQL,
      flags.dryRun,
    ); // 6
    // 7. Defensive local-only rows, each keyed on oxyUserId. Blocks are not
    // duplicated here: Oxy owns them and deletes them with the identity below.
    //
    // FOUR of these tables have no Postgres WRITER yet — `user_behaviors`,
    // `user_feed_preferences`, `mention_user_nodes` and
    // `mention_node_ingest_witnesses` — so each of these steps removes nothing
    // today. They are ported anyway rather than skipped: an inert step that is
    // correct costs one query, while a skipped one becomes the same silent gap
    // the day their writers land, and nothing would flag it. Read their
    // emptiness as "not yet written", never as coverage.
    counts.userSettings = await countOrDelete(
      userSettings, userSettings.id, eq(userSettings.oxyUserId, oxyUserId), flags.dryRun,
    );
    counts.userBehavior = await countOrDelete(
      userBehaviors, userBehaviors.id, eq(userBehaviors.oxyUserId, oxyUserId), flags.dryRun,
    );
    counts.userFeedPreference = await countOrDelete(
      userFeedPreferences,
      userFeedPreferences.id,
      eq(userFeedPreferences.oxyUserId, oxyUserId),
      flags.dryRun,
    );
    counts.authorFollowerSnapshots = await countOrDelete(
      authorFollowerSnapshots,
      authorFollowerSnapshots.id,
      eq(authorFollowerSnapshots.oxyUserId, oxyUserId),
      flags.dryRun,
    );
    counts.actorKeyPairs = flags.dryRun
      ? ((await hasActorKeyPair(oxyUserId)) ? 1 : 0)
      : await deleteActorKeyPair(oxyUserId);
    counts.mentionUserNodes = await countOrDelete(
      mentionUserNodes, mentionUserNodes.id, eq(mentionUserNodes.oxyUserId, oxyUserId), flags.dryRun,
    );
    // The MTN chain lives in Postgres. Same contract as `countOrDelete`: a dry run
    // COUNTS and writes nothing; a live run deletes and reports how many rows went.
    // `returning` is what makes the live count real — a delete with no `returning`
    // hands back a driver result whose shape is the driver's business, and a wrong
    // read of it would silently report 0 purged rows on a successful purge.
    counts.mentionRepoHeads = flags.dryRun
      ? (
          await getDb()
            .select({ total: count() })
            .from(mentionRepoHeads)
            .where(eq(mentionRepoHeads.oxyUserId, oxyUserId))
        )[0].total
      : (
          await getDb()
            .delete(mentionRepoHeads)
            .where(eq(mentionRepoHeads.oxyUserId, oxyUserId))
            .returning({ id: mentionRepoHeads.id })
        ).length;
    counts.mentionSignedRecords = flags.dryRun
      ? (
          await getDb()
            .select({ total: count() })
            .from(mentionSignedRecords)
            .where(eq(mentionSignedRecords.oxyUserId, oxyUserId))
        )[0].total
      : (
          await getDb()
            .delete(mentionSignedRecords)
            .where(eq(mentionSignedRecords.oxyUserId, oxyUserId))
            .returning({ id: mentionSignedRecords.id })
        ).length;
    counts.mentionNodeIngestWitnesses = await countOrDelete(
      mentionNodeIngestWitnesses,
      mentionNodeIngestWitnesses.id,
      eq(mentionNodeIngestWitnesses.oxyUserId, oxyUserId),
      flags.dryRun,
    );
  }

  // Dry-run never touches the Oxy identity or the anchor — report what WOULD happen.
  if (flags.dryRun) {
    counts.federatedActor = 1;
    return { outcome: 'purged', oxy: 'dry-run', counts };
  }

  // 8. Oxy identity — the LAST irreversible reference before the anchor. A row
  // without an owner id has no Oxy identity to delete (treated as confirmed-gone).
  const oxy: OxyDisposition = oxyUserId ? await deleteFederatedActorIdentity(oxyUserId) : 'no-user';
  const oxyConfirmedGone = oxy === 'deleted' || oxy === 'absent' || oxy === 'no-user';

  if (!oxyConfirmedGone) {
    // `skipped` (permanent 4xx) or `failed` (transient): KEEP the actor
    // anchor so a live Oxy user is never stranded without a record to reconcile it.
    logger.warn(
      '[purgeGoneFederatedActors] Oxy identity deletion was not confirmed; retaining actor anchor',
      { result: oxy },
    );
    return { outcome: 'partial', oxy, counts };
  }

  // 9. Drop the anchor LAST — only now that the Oxy identity is confirmed gone.
  counts.federatedActor = await deleteActorsByUris([actor.uri]);
  return { outcome: 'purged', oxy, counts };
}

/**
 * Re-verify one actor and, on a confirmed 410, run the destructive cascade. A 2xx
 * clears the tombstone (resurrected); anything else leaves the actor intact.
 */
async function processActor(actor: ActorRow, flags: Flags): Promise<ActorPurgeResult> {
  const verdict = await withActorTimeout(
    verifyStillGone(actor.uri),
    ACTOR_PURGE_TIMEOUT_MS,
  );

  if (verdict === 'resurrected') {
    if (flags.dryRun) {
      logger.info('[purgeGoneFederatedActors] resurrected actor tombstone would be cleared');
    } else {
      await updateActorSuspended(actor.id, false);
      logger.info('[purgeGoneFederatedActors] cleared resurrected actor tombstone');
    }
    return { outcome: 'resurrected', oxy: 'not-reached', counts: emptyCounts() };
  }

  if (verdict === 'unverified') {
    return { outcome: 'unverified', oxy: 'not-reached', counts: emptyCounts() };
  }

  logger.info('[purgeGoneFederatedActors] processing confirmed-gone actor', {
    dryRun: flags.dryRun,
  });
  return purgeConfirmedGone(actor, flags);
}

// --- scan driver -------------------------------------------------------------

/**
 * Base filter — the SAFETY GATE. Always the suspended, non-atproto set;
 * `--actor <uri>` narrows to one actor WITHOUT loosening the gate (a non-suspended
 * or atproto uri simply matches nothing).
 */
function buildFilter(flags: Flags): ActorScanFilter {
  return {
    suspended: true,
    protocolNot: 'atproto',
    ...(flags.actor ? { uri: flags.actor } : {}),
  };
}

function recordOxy(counters: RunCounters, oxy: OxyDisposition): void {
  switch (oxy) {
    case 'deleted':
      counters.oxyDeleted += 1;
      break;
    case 'absent':
      counters.oxyAbsent += 1;
      break;
    case 'skipped':
      counters.oxySkipped += 1;
      break;
    case 'failed':
      counters.oxyFailed += 1;
      break;
    // 'dry-run' | 'no-user' | 'not-reached' — not an oxy-api outcome to tally.
    default:
      break;
  }
}

async function purgeGoneFederatedActors(): Promise<void> {
  const startedAt = Date.now();
  const flags = parseFlags(process.argv.slice(2));

  const counters: RunCounters = {
    scanned: 0,
    purged: 0,
    partial: 0,
    resurrected: 0,
    unverified: 0,
    blocked: 0,
    oxyDeleted: 0,
    oxyAbsent: 0,
    oxySkipped: 0,
    oxyFailed: 0,
    totals: emptyCounts(),
  };
  let remaining = flags.limit;

  try {
    assertAdminMutationAllowed({
      scriptName: 'purgeGoneFederatedActors',
      dryRun: flags.dryRun,
    });
    await connectToDatabase();
    // The MTN chain rows this purge removes live in Postgres, so the cascade
    // needs BOTH connections open before the first actor is processed.
    await connectPostgres();
    logger.info('[purgeGoneFederatedActors] connected', {
      dryRun: flags.dryRun,
      narrowedScope: Boolean(flags.actor),
      concurrency: flags.concurrency,
      limit: flags.limit,
    });

    const baseFilter = buildFilter(flags);
    const total = await countActors(baseFilter);
    logger.info(`[purgeGoneFederatedActors] ${total} suspended candidate actor(s) to re-verify`);

    let lastId: string | undefined;

    for (;;) {
      if (remaining !== undefined && remaining <= 0) break;

      const pageLimit = remaining !== undefined ? Math.min(PAGE_SIZE, remaining) : PAGE_SIZE;
      const page: ActorRow[] = await scanActors(baseFilter, { afterId: lastId, limit: pageLimit });
      if (page.length === 0) break;

      // The page is already sliced to the remaining budget, so processing the WHOLE
      // page in a bounded pool can never overshoot `--limit`. Only the read-only
      // remote probe is timed; a mutating cascade always settles before tallying.
      const settledResults = await mapWithConcurrency(page, flags.concurrency, (actor) =>
        processActor(actor, flags),
      );

      // Tally sequentially in `_id` order AFTER the pool drains: every counter is
      // mutated exactly once per actor on a single call stack, so nothing races.
      for (let i = 0; i < page.length; i++) {
        counters.scanned += 1;
        if (remaining !== undefined) remaining -= 1;

        const settled = settledResults[i];
        if (settled.status === 'rejected') {
          // One bad actor never aborts the sweep. Probe timeouts happen before any
          // mutation; write failures preserve the anchor by purge ordering.
          const err = settled.reason;
          if (err instanceof DeletionPreflightError) {
            logger.warn('[purgeGoneFederatedActors] actor blocked by deletion preflight', {
              error: err,
            });
            counters.blocked += 1;
          } else if (err instanceof ActorPurgeTimeoutError) {
            logger.warn('[purgeGoneFederatedActors] actor purge timed out; actor left intact', {
              durationMs: ACTOR_PURGE_TIMEOUT_MS,
            });
            counters.unverified += 1;
          } else {
            logger.warn('[purgeGoneFederatedActors] actor purge failed; actor left intact', {
              error: err,
            });
            counters.unverified += 1;
          }
          continue;
        }

        const result = settled.value;
        addCounts(counters.totals, result.counts);
        recordOxy(counters, result.oxy);
        switch (result.outcome) {
          case 'purged':
            counters.purged += 1;
            break;
          case 'partial':
            counters.partial += 1;
            break;
          case 'resurrected':
            counters.resurrected += 1;
            break;
          case 'unverified':
            counters.unverified += 1;
            break;
        }
      }

      lastId = page[page.length - 1].id;
      logger.info(
        `[purgeGoneFederatedActors] progress: scanned ${counters.scanned}, purged ${counters.purged}, ` +
          `partial ${counters.partial}, blocked ${counters.blocked}, resurrected ${counters.resurrected}, ` +
          `unverified ${counters.unverified}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[purgeGoneFederatedActors] done (${flags.dryRun ? 'DRY-RUN' : 'LIVE'}, ${elapsedSeconds}s): ` +
        `candidates ${counters.scanned}, verified-gone ${counters.purged + counters.partial + counters.blocked} ` +
        `(purged ${counters.purged}, partial ${counters.partial}, blocked ${counters.blocked}), ` +
        `resurrected ${counters.resurrected}, ` +
        `unverified ${counters.unverified}`,
    );
    logger.info(
      `[purgeGoneFederatedActors] oxy-api actor-delete: deleted ${counters.oxyDeleted}, absent ${counters.oxyAbsent}, ` +
        `skipped ${counters.oxySkipped}, failed ${counters.oxyFailed}`,
    );
    logger.info(
      `[purgeGoneFederatedActors] per-collection ${flags.dryRun ? 'WOULD-delete' : 'deleted'} totals:`,
      Object.fromEntries(COLLECTION_KEYS.map((key) => [key, counters.totals[key]])),
    );

    assertAdminRunComplete('purgeGoneFederatedActors', {
      partial: counters.partial,
      blocked: counters.blocked,
      unverified: counters.unverified,
      oxySkipped: counters.oxySkipped,
      oxyFailed: counters.oxyFailed,
    });
  } catch (error) {
    logger.error('[purgeGoneFederatedActors] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis connections, media
  // cache workers) can keep the event loop alive, so the process would otherwise
  // sit RUNNING after the work completes. Mirrors the other one-shot scripts.
  purgeGoneFederatedActors()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[purgeGoneFederatedActors] unhandled failure', error);
      process.exit(1);
    });
}

export default purgeGoneFederatedActors;
