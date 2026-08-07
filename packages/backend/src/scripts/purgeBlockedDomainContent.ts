/**
 * One-shot cleanup: remove the content we ALREADY ingested from domains we now
 * block.
 *
 * WHY
 *   `FEDERATION_BLOCKED_DOMAINS` enforcement (inbound push + outbound pull) stops
 *   a blocked instance syncing INTO Mention from the moment it is set. It does
 *   nothing about what arrived BEFORE. Measured against production, 196 domains
 *   suspended by two or more of the three largest independent blocklist
 *   publishers still hold 6,401 posts and 1,135 actors of ours. Several are
 *   hate-speech or CSAM-adjacent, so leaving that content in place is not a
 *   neutral default.
 *
 * THE DOMAIN SET IS THE CONFIGURED BLOCKLIST — NOT `isBlockedDomain`
 *   The live predicate `isBlockedDomain` ALSO returns true for our OWN
 *   ActivityPub domains and the Oxy identity apex, because those publish our own
 *   users and must never be fetched as remote. Driving a DELETE off it would make
 *   an empty `FEDERATION_BLOCKED_DOMAINS` target every local user's content —
 *   the worst possible failure for this script. So the target set is built from
 *   `config.federation.blockedDomains` ONLY, our own domains are subtracted from
 *   it explicitly (an operator cannot blocklist us into deleting ourselves), and
 *   an empty result REFUSES to run rather than sweeping nothing (or everything).
 *   {@link buildBlockedContentDomains} is that whole decision, in one place.
 *
 * WHAT A LOCAL USER SEES AFTERWARDS — the interaction policy, decided per shape
 *   The removed posts are other people's. Local users interacted with them, and
 *   each shape gets an explicit decision rather than whatever falls out of the
 *   delete order:
 *
 *   - A local REPLY to a removed post is KEPT, `parentPostId` left dangling.
 *     It is the user's own words and deleting it would destroy their content to
 *     punish someone else's. `PostHydrationService` already tolerates a missing
 *     parent (it soft-fails the parent lookup): the reply still renders, still
 *     marks itself a reply, and simply loses the "Replying to @…" handle. Same
 *     treatment `purgeGoneFederatedActors` gives replies to a 410'd actor.
 *   - A local QUOTE of a removed post is KEPT, `quoteOf` left dangling. The
 *     user's own text renders normally; `attachNestedContext` resolves
 *     `quotedPost` to null, so the quote CARD disappears and the removed content
 *     is not shown.
 *   - A local BOOST of a removed post is DELETED. A boost carries no words of
 *     its own — its body is deliberately empty and it renders entirely from
 *     `boostOf`. Once the original is gone it is a mirror of removed content, and
 *     hydration would render it as a permanent "unavailable" placeholder card.
 *     Deleting it removes an amplification, not an authored thought.
 *   - LIKES and BOOKMARKS on a removed post are DELETED. They are pointers, not
 *     content, and a surviving row would dangle against a post id that no longer
 *     resolves.
 *   - LIKES and BOOKMARKS a blocked actor left on a SURVIVING local post are
 *     DELETED THROUGH THE COUNTER-PRESERVING TEARDOWN
 *     ({@link materializeEngagementTombstone}), so the local author's like count
 *     drops in lockstep instead of being left permanently inflated by engagement
 *     from an instance we no longer accept.
 *   - A blocked actor's BOOST of a surviving local post is deleted with the same
 *     guarded `stats.boostsCount` / `stats.federatedBoostsCount` decrements the
 *     live `Undo(Announce)` path performs.
 *   - A local post whose THREAD ROOT was removed is KEPT, `threadId` left
 *     dangling — the same reasoning as a reply, and `buildContext` simply emits a
 *     thread id that resolves to nothing.
 *   - NOTIFICATIONS are deleted three ways: those whose `entityId` is a removed
 *     post (a local user's own notification about content that no longer
 *     exists), and those addressed to or raised by a blocked actor.
 *   - POST-SCOPED moderation rows (`Report` with `reportedType: POST`,
 *     `ContentLabel` with `targetType: 'post'`) are deleted WITH their subject.
 *     A report asking for this content to be removed is satisfied by removing it,
 *     and one left behind names an id no moderation surface can load. Rows about
 *     the ACTOR are retained, which is consistent: the identity survives too.
 *   - `stats.commentsCount` on a surviving post whose reply we removed is
 *     deliberately NOT adjusted. Mention's own `deletePost` does not adjust it
 *     either, so a reply count can already exceed the replies on screen; making
 *     this script the only writer of a counter nothing else maintains would put
 *     it in a state no other code path can produce. Reported, not silently fixed.
 *
 * THE OXY IDENTITY IS RETAINED — this is NOT the gone-actor purge
 *   `purgeGoneFederatedActors` deletes the Oxy `User` behind a federated actor,
 *   but only after RE-VERIFYING a 410 from the remote server. We cannot make that
 *   claim here and must not imply it: a blocked instance is alive, we have simply
 *   stopped accepting it. Blocking is our policy about their content, not an
 *   assertion that their identity ceased to exist. Retaining the identity also
 *   keeps the `Report` and `ContentLabel` rows local users filed ABOUT these
 *   actors — evidence about exactly the domains being blocked — which deleting
 *   the user would strand or destroy. So this script removes their content, their
 *   engagement, their follow edges and the `FederatedActor` anchor, and leaves the
 *   Oxy identity alone. {@link assertActorAnchorSafeToDelete} is the preflight
 *   for precisely that narrower claim.
 *
 * PHASES (each resumable under its own cursor scope)
 *   1. `actors`       — for every `FederatedActor` whose `domain`/`uri` host is
 *                       blocked: their posts (+ the dependent cascade above) and
 *                       the references keyed to them.
 *   2. `orphan-posts` — posts whose `federation.actorUri` host is blocked but
 *                       that phase 1 did not reach, because their actor row was
 *                       pruned or never linked to an Oxy user. This is the part a
 *                       naive "posts by actors we hold from that domain" count
 *                       misses entirely.
 *   3. `media`        — `FederatedMediaCache` entries whose `remoteUrl` host is
 *                       blocked. Cached BYTES in our S3 are deleted before the
 *                       row, so a purge never orphans an object it can no longer
 *                       name.
 *   4. `anchors`      — the `FederatedActor` rows themselves, LAST. An anchor is
 *                       the only record a re-run can find an actor by, so it
 *                       outlives every step that can fail; and by running after
 *                       phase 2 its preflight is asked whether anything still
 *                       names the actor in a world where the uri-keyed posts are
 *                       already gone.
 *
 * SAFETY
 *   - `DRY_RUN=1` is fully supported and writes NOTHING: every destructive step
 *     funnels through {@link countOrDelete}, which counts instead.
 *   - A mutating run requires `CONFIRM_ADMIN_MUTATION=purgeBlockedDomainContent`.
 *   - Bounded batches throughout; never one unbounded `deleteMany` over the
 *     corpus.
 *   - Resumable + idempotent: progress is recorded in the database after every
 *     page (a Fargate one-shot's filesystem dies with the task), and a completed
 *     run re-run matches nothing.
 *   - `assertPostsSafeToDelete` runs before every post deletion; a blocked batch
 *     is skipped and counted, never forced.
 *
 * WHICH STORE THIS DELETES FROM
 *   Postgres, for everything except `feed_interactions`. That is not a detail:
 *   this script used to delete the MONGO collection for fourteen entities whose
 *   rows had already moved, so every one of those deletes matched nothing, and
 *   `renderDomainTable` reported the zeros as "this domain held no such content"
 *   to the person who had just authorised a deletion. Worse, the preflight in
 *   front of it WAIVES exactly those reference probes on the strength of this
 *   cascade (`CASCADED_POST_REFERENCES`), so the gate did not block and the
 *   cascade did not clean.
 *
 *   `feed_interactions` is the single exception and it deletes from BOTH, because
 *   both hold rows that are real — see {@link purgeFeedInteractions}. It is the
 *   one entity in the cascade whose live writer is still Mongo.
 *
 * ENV
 *   DRY_RUN=1                 report only, write nothing (default: mutating,
 *                             which additionally requires the confirmation below)
 *   CONFIRM_ADMIN_MUTATION    must equal `purgeBlockedDomainContent` for a live run
 *   PURGE_LIMIT               cap on actors processed in phase 1 (a canary budget)
 *   PURGE_DOMAIN              restrict every phase to ONE blocked domain
 *   RESET_CURSOR=1            forget recorded progress and start from the top
 *
 * RUN AS A FARGATE ONE-SHOT (the blocklist is passed to the TASK; this script
 * never writes configuration of any kind):
 *   FEDERATION_BLOCKED_DOMAINS=a.example,b.example DRY_RUN=1 \
 *     bun packages/backend/dist/src/scripts/purgeBlockedDomainContent.js
 *   FEDERATION_BLOCKED_DOMAINS=a.example,b.example \
 *     CONFIRM_ADMIN_MUTATION=purgeBlockedDomainContent \
 *     bun packages/backend/dist/src/scripts/purgeBlockedDomainContent.js
 */

import { createHash } from 'node:crypto';
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { PostType } from '@mention/shared-types';
import { config } from '../config';
import { connectPostgres, getDb } from '../db/postgres';
import { bookmarks, entityFollows, likes, postSubscriptions } from '../db/schema/engagement';
import { notifications } from '../db/schema/discovery';
import { posts } from '../db/schema/posts';
import {
  postAuthorships,
  postMedia,
  postMentions,
  postRecentRepliers,
} from '../db/schema/postContent';
import { polls } from '../db/schema/polls';
import { articles } from '../db/schema/articles';
import { postgates, threadgates } from '../db/schema/gates';
import { feedInteractions } from '../db/schema/feeds';
import { engagementOutbox } from '../db/schema/outbox';
import { contentLabels, reports } from '../db/schema/moderation';
import { authoredBy } from '../db/posts/postRepository';
import {
  countActors,
  deleteActorsByUris,
  scanActors,
} from '../db/federation/actorRepository';
import { countFollows, deleteFollowsFor } from '../db/federation/followRepository';
import {
  countMediaCacheRowsByUrls,
  deleteMediaCacheRowsByUrls,
  findMediaCacheRowsByUrls,
  pageMediaCacheRows,
} from '../db/federation/mediaCacheRepository';
import {
  countDeliveriesReferencingObjects,
  deleteDeliveriesReferencingObjects,
} from '../db/federation/deliveryQueueRepository';
import {
  recordPurgeOutcomes,
  recordPurgeRun,
  toLedgerCounts,
} from '../db/blocklist/blockedDomainPurgeRepository';
import { canonicalFederationHost } from '@oxyhq/federation';
import { getBlockedDomainPolicy } from '../connectors/activitypub/federationBlockPolicy';
import { OWN_DOMAINS } from '../connectors/activitypub/ownDomain';
import {
  materializeEngagementTombstone,
} from '../services/PostEngagementCommandService';
import { deleteCachedMedia, isMediaCacheEnabled } from '../services/mediaCache/oxyMediaStore';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  DeletionPreflightError,
  assertActorAnchorSafeToDelete,
  assertPostsSafeToDelete,
  collectPostCascadeResidue,
  type PostDeletionTarget,
  type PostReferenceProbeName,
} from './lib/adminDeletionPreflight';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';
import {
  clearAdminScriptCursor,
  readAdminScriptCursor,
  recordAdminScriptCursor,
} from './lib/adminScriptCursor';

/** This script's own name — the token its mutation guard and cursor rows use. */
const SCRIPT_NAME = 'purgeBlockedDomainContent';

/** Rows read per page in every `_id`-cursor scan. */
const PAGE_SIZE = 500;

/** Posts handled per destructive batch (the `$in` width of every cascade query). */
const POST_BATCH_SIZE = 200;

/** Engagement rows a blocked actor's counter-preserving teardown handles per page. */
const ENGAGEMENT_PAGE_SIZE = 200;

/**
 * Every post reference this script's own cascade removes — the manifest handed
 * to the deletion preflight, and re-verified against the end state afterwards.
 *
 * It is deliberately the COMPLETE probe list minus nothing: a post reference
 * this script does not clean would block its own batches forever. Because the
 * names are compiler-checked, a probe added to the shared module later is NOT in
 * here, so the preflight starts refusing until someone teaches this cascade
 * about it — which is the correct failure.
 */
export const CASCADED_POST_REFERENCES: readonly PostReferenceProbeName[] = [
  'notifications.entity_id',
  'polls.post_id',
  'articles.post_id',
  'postgates.post_id/post_uri',
  'threadgates.post_id/post_uri',
  'post_recent_repliers.post_id',
  'engagement_outbox.payload_post_id',
  'reports.reported_id(post)',
  'content_labels.target_id(post)',
  'feed_interactions.post_uri',
  'federation_delivery_queue.activity_json',
  'likes.post_id',
  'bookmarks.post_id',
  // Removed by `ON DELETE CASCADE` when the post row goes, with no leg of its
  // own: unlike `likes`/`bookmarks`, which are deleted explicitly so their
  // denormalized counters can be decremented first, a correction trail has no
  // counter anywhere but on the post that is being destroyed. The residue check
  // re-runs the probe afterwards, so the claim is verified rather than asserted.
  'post_corrections.post_id',
];

/** Cursor scope names — one resumable territory per phase. */
const SCOPE_ACTORS = 'actors';
const SCOPE_ORPHAN_POSTS = 'orphan-posts';
const SCOPE_MEDIA = 'media';
const SCOPE_ANCHORS = 'anchors';

// --- environment -------------------------------------------------------------

function readBooleanEnv(name: string): boolean {
  return ['1', 'true', 'yes'].includes((process.env[name] || '').trim().toLowerCase());
}

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return parsed;
}

/** Everything the run's behaviour depends on, resolved once at start-up. */
export interface PurgeOptions {
  dryRun: boolean;
  limit?: number;
  domain?: string;
  resetCursor: boolean;
}

function readOptions(): PurgeOptions {
  return {
    dryRun: readBooleanEnv('DRY_RUN'),
    limit: readPositiveIntEnv('PURGE_LIMIT'),
    domain: canonicalFederationHost(process.env.PURGE_DOMAIN || '') || undefined,
    resetCursor: readBooleanEnv('RESET_CURSOR'),
  };
}

// --- the target domain set ---------------------------------------------------

/**
 * Canonical hostname of a URL, or `null` when it is not parseable as one.
 *
 * `canonicalFederationHost` is the federation ENGINE's own comparison form — the
 * function `createDomainPolicy` uses to decide whether an incoming host is one
 * we refused. This script deletes, so it must ask that question with the
 * engine's function and not a local rendition of it: a canonicaliser that
 * normalised one spelling differently would target content for a domain the
 * engine never blocked, and there is no undo. An earlier hand-copy here stripped
 * a trailing dot, which the engine does not — `example.com.` in the blocklist
 * matches nothing at the wire, but the stripped form matched `example.com`, so
 * that instance's content was in scope for a block that was never in force. For
 * an irreversible action, broader-than-enforcement is the one direction that
 * cannot be allowed, and the way to guarantee it is to run the same code.
 */
export function hostOf(value: string): string | null {
  try {
    return canonicalFederationHost(new URL(value).hostname);
  } catch {
    return null;
  }
}

/** Raised when the configured blocklist cannot produce a safe target set. */
export class EmptyBlocklistError extends Error {
  constructor(detail: string) {
    super(`[${SCRIPT_NAME}] refusing to run: ${detail}`);
    this.name = 'EmptyBlocklistError';
  }
}

/**
 * Build the set of domains whose content this run removes.
 *
 * Deliberately NOT `isBlockedDomain`: that predicate also matches our own
 * ActivityPub domains and the Oxy identity apex, so an empty blocklist would
 * resolve to "everything we publish ourselves". Here the blocklist is the ONLY
 * source, our own domains are subtracted from it whatever an operator
 * configured, and an empty result throws instead of running.
 *
 * `configured` is the COMMITTED POLICY UNIONED WITH the environment lever, which
 * is the one place the two are treated alike — and only because a human is
 * confirming this exact run by name through `CONFIRM_ADMIN_MUTATION`. The
 * AUTOMATIC path is the opposite and reads the reviewed policy only: nothing
 * unattended may be triggered by a value someone can change in a console with no
 * diff, no author and no review.
 */
export function buildBlockedContentDomains(
  configured: readonly string[],
  ownDomains: readonly string[],
  restrictTo?: string,
): ReadonlySet<string> {
  const own = new Set(ownDomains.map(canonicalFederationHost).filter((entry) => entry.length > 0));
  const targets = new Set<string>();
  for (const entry of configured) {
    const domain = canonicalFederationHost(entry);
    if (domain.length === 0) continue;
    // Subtracted rather than rejected: a blocklist that happens to name us is a
    // configuration mistake, and the safe reading of it is "block them, never
    // ourselves" — not "delete every local user's content".
    if (own.has(domain)) {
      logger.warn(`[${SCRIPT_NAME}] ignoring an own domain found in the blocklist`, { domain });
      continue;
    }
    targets.add(domain);
  }

  if (targets.size === 0) {
    throw new EmptyBlocklistError(
      'neither the committed policy nor FEDERATION_BLOCKED_DOMAINS names a domain '
      + 'outside our own.',
    );
  }

  if (restrictTo === undefined) return targets;

  if (!targets.has(restrictTo)) {
    throw new EmptyBlocklistError(
      `PURGE_DOMAIN "${restrictTo}" is not in the configured blocklist.`,
    );
  }
  return new Set([restrictTo]);
}

// --- counters ----------------------------------------------------------------

/**
 * Everything a run removes (or, under `DRY_RUN`, WOULD remove), tallied per
 * domain and in total. Every field is a count of documents affected, so the
 * dry-run report and the live report are the same shape and directly comparable.
 */
export interface PurgeCounts {
  /** `FederatedActor` anchor rows. */
  actors: number;
  /** Posts authored by a blocked actor (phase 1). */
  posts: number;
  /** Posts matched ONLY by `federation.actorUri` — what the naive count misses. */
  orphanPosts: number;
  /** Boosts of removed posts authored by SOMEONE ELSE (deleted: empty mirrors). */
  boostsByOthers: number;
  /** Replies by someone else to a removed post (KEPT — counted to show the impact). */
  repliesByOthersKept: number;
  /** Quotes by someone else of a removed post (KEPT — counted to show the impact). */
  quotesByOthersKept: number;
  /** Posts by someone else whose thread ROOT was removed (KEPT). */
  threadRootsKept: number;
  likesOnRemovedPosts: number;
  bookmarksOnRemovedPosts: number;
  postSubscriptions: number;
  polls: number;
  articles: number;
  postgates: number;
  threadgates: number;
  /** Ranking telemetry pointing at a removed post. */
  feedInteractions: number;
  /** Pending outbound engagement events for a removed post. */
  engagementOutbox: number;
  /** Post-scoped moderation reports removed with their subject. */
  reports: number;
  /** Post-scoped moderation labels removed with their subject. */
  contentLabels: number;
  /** Queued outbound deliveries naming a removed post. */
  federationDeliveries: number;
  /** Notifications whose `entityId` is a removed post. */
  notificationsByEntity: number;
  /** Notifications addressed to, or raised by, a blocked actor. */
  notificationsByActor: number;
  /** Likes a blocked actor left on a SURVIVING post (counter-preserving teardown). */
  likesByBlockedActors: number;
  bookmarksByBlockedActors: number;
  /** Surviving posts whose boost counters were repaired after a boost was removed. */
  boostCountersRepaired: number;
  /** `PostRecentReplier` projections deleted with their post. */
  recentReplierProjections: number;
  /** Surviving projections a blocked actor was pulled out of. */
  recentReplierEntriesPulled: number;
  /** Posts a blocked actor was de-linked from in `mentions[]`. */
  mentionsDelinked: number;
  federatedFollows: number;
  /**
   * Of those, ACCEPTED OUTBOUND edges — a local user who chose to follow an
   * account there. The sharpest signal that a domain is one real people here
   * wanted: across all 196 measured blocklist domains it is zero, so any
   * non-zero value is the shape of a mistake and the automatic path stops on it.
   */
  localFollowsRemoved: number;
  entityFollows: number;
  /** `FederatedMediaCache` rows removed. */
  mediaCacheRows: number;
  /** Cached objects deleted from Oxy S3 before their row. */
  mediaObjects: number;
}

const COUNT_KEYS: readonly (keyof PurgeCounts)[] = [
  'actors',
  'posts',
  'orphanPosts',
  'boostsByOthers',
  'repliesByOthersKept',
  'quotesByOthersKept',
  'threadRootsKept',
  'likesOnRemovedPosts',
  'bookmarksOnRemovedPosts',
  'postSubscriptions',
  'polls',
  'articles',
  'postgates',
  'threadgates',
  'feedInteractions',
  'engagementOutbox',
  'reports',
  'contentLabels',
  'federationDeliveries',
  'notificationsByEntity',
  'notificationsByActor',
  'likesByBlockedActors',
  'bookmarksByBlockedActors',
  'boostCountersRepaired',
  'recentReplierProjections',
  'recentReplierEntriesPulled',
  'mentionsDelinked',
  'federatedFollows',
  'localFollowsRemoved',
  'entityFollows',
  'mediaCacheRows',
  'mediaObjects',
];

export function emptyCounts(): PurgeCounts {
  const counts = {} as PurgeCounts;
  for (const key of COUNT_KEYS) counts[key] = 0;
  return counts;
}

/** Issue counters — every one of these fails the run at any non-zero value. */
interface RunIssues {
  /** Post batches a deletion preflight refused. Nothing was deleted for them. */
  preflightBlocked: number;
  /** Cached media objects whose S3 delete failed, so their row was kept. */
  mediaObjectDeleteFailed: number;
  /** Pages whose resume cursor could not be persisted. */
  cursorWriteFailed: number;
  /** Blocked-actor engagement rows the counter-preserving teardown left behind. */
  engagementResidue: number;
  /** References the cascade claimed to remove but that survived the batch. */
  cascadeResidue: number;
}

/**
 * How big the corpus this run measured itself against actually is.
 *
 * Read off the SAME paged scans the run already performs, so it costs nothing
 * extra and can never disagree with what was swept. It exists because an
 * absolute ceiling tuned on today's numbers silently becomes either meaningless
 * or unreachable as the corpus grows — the automatic path's limits are shares of
 * these, not fixed counts.
 */
export interface PurgeCorpus {
  /** Posts carrying `federation.actorUri`, i.e. everything we hold from anywhere. */
  federatedPosts: number;
  /** `FederatedActor` rows, all domains. */
  federatedActors: number;
}

/** The full result of a run — returned so tests can assert on it directly. */
export interface PurgeReport {
  dryRun: boolean;
  domains: number;
  corpus: PurgeCorpus;
  totals: PurgeCounts;
  /** Per-domain breakdown, so a review can see which domain costs what. */
  byDomain: Map<string, PurgeCounts>;
  issues: RunIssues;
}

/** The per-domain bucket, created on first use. */
function bucketFor(report: PurgeReport, domain: string): PurgeCounts {
  const existing = report.byDomain.get(domain);
  if (existing) return existing;
  const created = emptyCounts();
  report.byDomain.set(domain, created);
  return created;
}

/** Add `delta` to a domain's bucket AND the run totals in one step. */
function record(report: PurgeReport, domain: string, key: keyof PurgeCounts, delta: number): void {
  if (delta === 0) return;
  bucketFor(report, domain)[key] += delta;
  report.totals[key] += delta;
}

// --- the one destructive chokepoint -----------------------------------------

/**
 * Count (under `DRY_RUN`) or delete (live) the rows matching `where`, returning
 * the affected count either way.
 *
 * This is the SINGLE place a row is removed, which is what makes the dry-run
 * guarantee checkable rather than a claim: no other code path in this module
 * calls `db.delete`, except the three repository functions that ARE one
 * (`deleteActorsByUris`, `deleteFollowsFor`, `deleteMediaCacheRowsByUrls`) and
 * the one collection this script still deletes from Mongo (see
 * {@link purgeFeedInteractions}).
 *
 * `returning` is what makes the live count real — a delete without it hands back
 * a driver result whose shape is the driver's business, and a wrong read of it
 * would silently report 0 removed rows on a successful purge.
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
 * {@link countOrDelete} for a table whose Mongo original was one DOCUMENT PER
 * POST holding an array, and whose counter therefore means posts rather than
 * rows.
 *
 * Counting distinct posts on both sides is what keeps the reported number
 * comparable to the one the Mongo version produced — and, more usefully, keeps it
 * from changing meaning with the data: rows would report a post with three
 * repliers as three projections.
 */
async function countOrDeleteDistinctPosts(
  table: PgTable,
  postIdColumn: PgColumn,
  where: SQL,
  dryRun: boolean,
): Promise<number> {
  const db = getDb();
  if (dryRun) {
    const [row] = await db
      .select({ total: sql<number>`count(distinct ${postIdColumn})::int` })
      .from(table)
      .where(where);
    return row?.total ?? 0;
  }
  const removed = await db.delete(table).where(where).returning({ postId: postIdColumn });
  return new Set(removed.map((row) => row.postId)).size;
}

/**
 * `feed_interactions` — the ONE lane that deletes from BOTH stores, because both
 * hold rows that are real.
 *
 * This used to delete from BOTH stores and sum the counts, because the table was
 * half-ported in the unusual direction: everything around it was Postgres — the
 * table, its indexes, the expiry sweep, the deletion preflight's
 * `feed_interactions.post_uri` probe, the backfill that populates it — while the
 * only writer in the running application still wrote Mongo.
 *
 * `trackFeedInteraction` now writes Postgres, so the Mongo half is a delete that
 * matches nothing new, and it is gone as that docblock said it should be.
 *
 * One consequence worth stating rather than discovering: rows written to the
 * Mongo collection BEFORE the writer ported are no longer purged by this script.
 * They are not reachable by anything — no reader remains, the collection is not
 * copied by a second backfill, and its 90-day TTL expires them on its own — but
 * "the purge no longer touches them" is a true sentence about a blocked domain's
 * residue, so it belongs here rather than in a commit message.
 */
async function purgeFeedInteractions(
  postKeys: readonly string[],
  dryRun: boolean,
): Promise<number> {
  return countOrDelete(
    feedInteractions,
    feedInteractions.id,
    inArray(feedInteractions.postUri, [...postKeys]),
    dryRun,
  );
}

// --- post cascade ------------------------------------------------------------

/** The `posts` columns every cascade decision reads. */
interface PostRow {
  id: string;
  type: string;
  oxyUserId: string | null;
  boostOf: string | null;
  federationActivityId: string | null;
  federationUrl: string | null;
  federationActorUri: string | null;
  contentPollId: string | null;
  contentArticleId: string | null;
}

/**
 * The projection, as a drizzle select shape.
 *
 * `media` is NOT on it, unlike the Mongo document it replaces: media is a child
 * TABLE (`post_media`) rather than an embedded array, so the remote URLs are a
 * query — see {@link remoteMediaUrlsFor}. Nothing is lost by that; the origin URL
 * is actually better preserved, since `post_media.remote_url` keeps it after the
 * media cache has rewritten `media_id` to an Oxy file id, which the Mongo shape
 * overwrote.
 */
const POST_CASCADE_COLUMNS = {
  id: posts.id,
  type: posts.type,
  oxyUserId: posts.oxyUserId,
  boostOf: posts.boostOf,
  federationActivityId: posts.federationActivityId,
  federationUrl: posts.federationUrl,
  federationActorUri: posts.federationActorUri,
  contentPollId: posts.contentPollId,
  contentArticleId: posts.contentArticleId,
} as const;

/**
 * Every remote media URL a batch of posts references.
 *
 * BOTH columns, because they hold the same URL at different points in the media
 * cache's life: `media_id` carries a raw remote URL until the cache rewrites it
 * to an Oxy file id, at which point the origin moves to `remote_url`. Reading
 * only the first — the literal translation of the Mongo `media[].id` read — would
 * find the bytes of posts the cache never got to and miss exactly the ones it
 * DID cache, which are the ones with bytes in our S3.
 */
async function remoteMediaUrlsFor(postIds: readonly string[]): Promise<string[]> {
  if (postIds.length === 0) return [];
  const rows = await getDb()
    .select({ mediaId: postMedia.mediaId, remoteUrl: postMedia.remoteUrl })
    .from(postMedia)
    .where(inArray(postMedia.postId, [...postIds]));

  const urls = new Set<string>();
  for (const row of rows) {
    if (/^https?:\/\//i.test(row.mediaId)) urls.add(row.mediaId);
    if (row.remoteUrl && /^https?:\/\//i.test(row.remoteUrl)) urls.add(row.remoteUrl);
  }
  return [...urls];
}

/** The AP uris a post is addressable by, for the deletion preflight. */
function postUris(post: PostRow): string[] {
  return [post.federationActivityId, post.federationUrl].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/**
 * Delete the cached bytes and the cache rows for a set of remote media URLs.
 *
 * The S3 object goes FIRST and the row only follows once every object for it is
 * confirmed gone — the same ordering the TTL eviction job uses, and for the same
 * reason: a row deleted before its bytes is an object nothing can ever name
 * again. A row with no cached object (`pending`/`failed`/`evicted`) has nothing
 * to delete and is removed directly.
 */
async function purgeMediaForUrls(
  urls: readonly string[],
  options: PurgeOptions,
  report: PurgeReport,
  domain: string,
  issues: RunIssues,
): Promise<void> {
  if (urls.length === 0) return;

  for (const batch of chunk([...new Set(urls)], POST_BATCH_SIZE)) {
    const rows = await findMediaCacheRowsByUrls(batch);
    if (rows.length === 0) continue;

    const removable: string[] = [];
    for (const row of rows) {
      const fileIds = [row.oxyFileId, row.posterFileId].filter(
        (id): id is string => typeof id === 'string' && id.length > 0,
      );

      if (fileIds.length === 0) {
        removable.push(row.remoteUrl);
        continue;
      }

      if (options.dryRun) {
        record(report, domain, 'mediaObjects', fileIds.length);
        removable.push(row.remoteUrl);
        continue;
      }

      if (!isMediaCacheEnabled()) {
        // Deleting the row now would strand the bytes permanently. Keep both and
        // fail the run: cached copies of blocked-domain media surviving a purge
        // is exactly the outcome that must never be reported as success.
        //
        // Said out loud, because the counter alone reaches the operator as a
        // bare `mediaObjectDeleteFailed=N` with no cause — and this cause is a
        // deployment setting they can actually change.
        logger.warn(`[${SCRIPT_NAME}] media cache is disabled, so cached bytes cannot be deleted`, {
          domain,
          fileCount: fileIds.length,
        });
        issues.mediaObjectDeleteFailed += fileIds.length;
        continue;
      }

      const results = await Promise.allSettled(fileIds.map((id) => deleteCachedMedia(id)));
      const failed = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failed.length > 0) {
        logger.warn(`[${SCRIPT_NAME}] cached media delete failed; keeping its row for retry`, {
          domain,
          failedCount: failed.length,
          // The REASONS, not just the count. `assertAdminRunComplete` correctly
          // fails the run on a single survivor, so without these the operator is
          // handed a failure they cannot act on: the rejection is settled,
          // counted, and thrown away. Observed in production — nine objects
          // survived an otherwise complete purge and the log could say only that
          // they had.
          reasons: failed.map((result) =>
            result.reason instanceof Error ? result.reason.message : String(result.reason),
          ),
        });
        issues.mediaObjectDeleteFailed += failed.length;
        continue;
      }
      record(report, domain, 'mediaObjects', fileIds.length);
      removable.push(row.remoteUrl);
    }

    if (removable.length === 0) continue;
    record(
      report,
      domain,
      'mediaCacheRows',
      options.dryRun
        ? await countMediaCacheRowsByUrls(removable)
        : await deleteMediaCacheRowsByUrls(removable),
    );
  }
}

/**
 * Repair the denormalized boost counters on posts that SURVIVE this purge but
 * lose a boost to it.
 *
 * Mirrors the live `Undo(Announce)` teardown exactly: two independently guarded
 * `$gt: 0` decrements, so neither counter can underflow and a `federatedBoostsCount`
 * that legitimately lags (posts predating the field) never blocks the
 * `boostsCount` decrement beside it.
 */
async function repairBoostCounters(
  removed: readonly PostRow[],
  removedIds: ReadonlySet<string>,
  options: PurgeOptions,
  report: PurgeReport,
  domain: string,
): Promise<void> {
  // There is no id-shape guard here, and its removal is the POINT rather than a
  // simplification. It used to skip a `boostOf` that was not a Mongo ObjectId
  // and count it as `boostTargetUncastable`, because a uuid v7 could not be cast
  // into a Mongo query — a counter written for exactly this moment, whose
  // docblock said it would otherwise skip EVERY boost counter repair while the
  // run still reported success. `posts.id` is `text` and holds either id space,
  // so nothing is uncastable and there is no longer a state to count.
  const survivingTargets = removed
    .filter((post) => post.boostOf !== null && !removedIds.has(post.boostOf))
    .map((post) => ({
      boostOf: String(post.boostOf),
      federated: post.federationActorUri !== null || post.federationActivityId !== null,
    }));
  if (survivingTargets.length === 0) return;

  const db = getDb();
  for (const target of survivingTargets) {
    if (options.dryRun) {
      // The post must still exist for a decrement to be meaningful; counting the
      // same predicate the live write uses keeps the dry-run figure honest.
      const [row] = await db
        .select({ id: posts.id })
        .from(posts)
        .where(and(eq(posts.id, target.boostOf), gt(posts.statsBoostsCount, 0)))
        .limit(1);
      record(report, domain, 'boostCountersRepaired', row ? 1 : 0);
      continue;
    }

    const updated = await db
      .update(posts)
      .set({ statsBoostsCount: sql`${posts.statsBoostsCount} - 1` })
      .where(and(eq(posts.id, target.boostOf), gt(posts.statsBoostsCount, 0)))
      .returning({ id: posts.id });
    record(report, domain, 'boostCountersRepaired', updated.length);
    if (target.federated) {
      await db
        .update(posts)
        .set({ statsFederatedBoostsCount: sql`${posts.statsFederatedBoostsCount} - 1` })
        .where(and(eq(posts.id, target.boostOf), gt(posts.statsFederatedBoostsCount, 0)));
    }
  }
}

/**
 * Measure the local content that SURVIVES this batch — replies and quotes by
 * anyone whose post is not itself being removed.
 *
 * Counted, never touched. The number matters precisely because it is the cost of
 * the policy: it is how many posts by real users will render with a parent or a
 * quote card that no longer resolves.
 */
async function measureSurvivingDependents(
  removedIdStrings: readonly string[],
  removedIds: ReadonlySet<string>,
  report: PurgeReport,
  domain: string,
): Promise<void> {
  const ids = [...removedIdStrings];
  const dependents = await getDb()
    .select({
      parentPostId: posts.parentPostId,
      quoteOf: posts.quoteOf,
      threadId: posts.threadId,
    })
    .from(posts)
    .where(
      and(
        notInArray(posts.id, ids),
        or(
          inArray(posts.parentPostId, ids),
          inArray(posts.quoteOf, ids),
          inArray(posts.threadId, ids),
        ),
      ),
    );

  let replies = 0;
  let quotes = 0;
  let threadRoots = 0;
  for (const dependent of dependents) {
    if (dependent.parentPostId && removedIds.has(dependent.parentPostId)) replies += 1;
    if (dependent.quoteOf && removedIds.has(dependent.quoteOf)) quotes += 1;
    if (dependent.threadId && removedIds.has(dependent.threadId)) threadRoots += 1;
  }
  record(report, domain, 'repliesByOthersKept', replies);
  record(report, domain, 'quotesByOthersKept', quotes);
  record(report, domain, 'threadRootsKept', threadRoots);
}

/**
 * Every boost that would be left with nothing behind it, to any depth.
 *
 * A single hop is not enough: `handleAnnounce` records an inbound Announce as a
 * boost `Post` keyed on whatever local post the announced uri resolved to, and
 * that post can itself be a boost — so an Announce of one of our boosts produces
 * a boost OF a boost. Stopping at one hop would leave the outer one rendering a
 * placeholder card, and the preflight's graph probe would then refuse the batch
 * on every run, stalling that actor permanently rather than visibly.
 *
 * Bounded by construction: each round only queries ids discovered in the previous
 * one and already-seen ids are never re-queried, so it terminates even on a cycle.
 */
async function collectBoostClosure(seeds: readonly PostRow[]): Promise<PostRow[]> {
  const seen = new Set(seeds.map((post) => post.id));
  const found: PostRow[] = [];
  let frontier = seeds.map((post) => post.id);

  while (frontier.length > 0) {
    const next = await getDb()
      .select(POST_CASCADE_COLUMNS)
      .from(posts)
      .where(and(eq(posts.type, PostType.BOOST), inArray(posts.boostOf, frontier)));

    frontier = [];
    for (const boost of next) {
      if (seen.has(boost.id)) continue;
      seen.add(boost.id);
      found.push(boost);
      frontier.push(boost.id);
    }
  }

  return found;
}

/**
 * Remove one bounded batch of blocked-domain posts and everything that would
 * dangle behind them.
 *
 * `seeds` are the posts matched by the domain rule; the batch is EXPANDED with
 * every boost of them (by any author) before anything is deleted, because a boost
 * has no body of its own and would be left rendering an "unavailable" card. The
 * expansion is what makes the surviving-dependent measurement correct too: a
 * boost is not a survivor.
 *
 * Returns the number of posts actually removed (0 when the preflight refused).
 */
async function purgePostBatch(
  seeds: readonly PostRow[],
  options: PurgeOptions,
  report: PurgeReport,
  domain: string,
  issues: RunIssues,
  seedCountKey: 'posts' | 'orphanPosts',
): Promise<number> {
  if (seeds.length === 0) return 0;

  const boosts = await collectBoostClosure(seeds);
  const removed = [...seeds, ...boosts];
  const removedIdStrings = removed.map((post) => post.id);
  const removedIdSet = new Set(removedIdStrings);

  const targets: PostDeletionTarget[] = removed.map((post) => ({
    id: post.id,
    uris: postUris(post),
  }));
  // Both keys a post can be named by — its id and its AP uris — because the
  // side tables below are split between the two, exactly as the preflight's
  // probes are.
  const removedPostKeys = [...new Set([...removedIdStrings, ...removed.flatMap(postUris)])];

  try {
    await assertPostsSafeToDelete(`${SCRIPT_NAME}:${domain}`, targets, {
      removedByCascade: CASCADED_POST_REFERENCES,
      allowDanglingReplyReferences: true,
    });
  } catch (error) {
    if (!(error instanceof DeletionPreflightError)) throw error;
    // Fail closed on the batch, never on the run: the operator gets the complete
    // blocker list for these posts and every other batch still proceeds.
    logger.warn(`[${SCRIPT_NAME}] deletion preflight refused a batch; nothing removed for it`, {
      domain,
      batchSize: removed.length,
      blockers: error.blockers,
    });
    issues.preflightBlocked += 1;
    return 0;
  }

  await measureSurvivingDependents(removedIdStrings, removedIdSet, report, domain);
  await repairBoostCounters(removed, removedIdSet, options, report, domain);

  /**
   * Engagement and side tables FIRST, so nothing can be left pointing at a post
   * id that no longer resolves if the run dies mid-batch.
   *
   * Most of these columns now carry a real `ON DELETE CASCADE` to `posts.id`, so
   * the post delete at the bottom would remove them anyway. Removing them here
   * ANYWAY is not belt-and-braces: a cascade the database performs is invisible
   * to this script, so the report would say zero likes were removed while the
   * likes went. The count is the product, and it is only true if the delete is
   * the one that ran.
   */
  record(
    report, domain, 'likesOnRemovedPosts',
    await countOrDelete(likes, likes.id, inArray(likes.postId, removedIdStrings), options.dryRun),
  );
  record(
    report, domain, 'bookmarksOnRemovedPosts',
    await countOrDelete(
      bookmarks, bookmarks.id, inArray(bookmarks.postId, removedIdStrings), options.dryRun,
    ),
  );
  /**
   * The notification probe's OWN predicate, `entity_type` included.
   *
   * `entity_id` is polymorphic by `entity_type`, so an id-only match can name a
   * follow or a mention notification whose entity id happens to collide. The
   * preflight waives this probe on the strength of this delete, so the two must
   * ask the same question or the gate clears rows this never removes.
   */
  record(
    report, domain, 'notificationsByEntity',
    await countOrDelete(
      notifications,
      notifications.id,
      and(
        inArray(notifications.entityType, ['post', 'reply']),
        inArray(notifications.entityId, removedIdStrings),
      ) as SQL,
      options.dryRun,
    ),
  );
  /**
   * `post_recent_repliers` is FLAT here — one row per (post, replier) — where
   * Mongo held one document per post with a `repliers[]` array. The counter still
   * means "projections removed", so it counts DISTINCT POSTS rather than rows;
   * otherwise a post with three repliers would report as three projections and
   * the number would silently change meaning with the shape of the data.
   */
  record(
    report, domain, 'recentReplierProjections',
    await countOrDeleteDistinctPosts(
      postRecentRepliers,
      postRecentRepliers.postId,
      inArray(postRecentRepliers.postId, removedIdStrings),
      options.dryRun,
    ),
  );

  /**
   * `polls` and `articles` are reached through their own `post_id` only.
   *
   * The Mongo version needed a second `$or` branch on the id the POST carried
   * (`content.pollId` / `content.article.articleId`), because those were two
   * mirrors of one relationship that could disagree. The schema collapsed that:
   * `polls.post_id` is the owning side and carries the constraint, so a poll a
   * post names but which does not name the post back is not a state the database
   * admits. The columns are still read into {@link PostRow} because the ORPHAN
   * direction is a different question, answered below.
   */
  record(
    report, domain, 'polls',
    await countOrDelete(polls, polls.id, inArray(polls.postId, removedIdStrings), options.dryRun),
  );
  record(
    report, domain, 'articles',
    await countOrDelete(
      articles, articles.id, inArray(articles.postId, removedIdStrings), options.dryRun,
    ),
  );

  // Reply/quote gates, ranking telemetry and pending outbound work describe a
  // post and cannot outlive it. Post-scoped MODERATION rows go with it too: a
  // report or a label asking for this content to be removed is satisfied by its
  // removal, and left behind it points at an id no moderation surface can load.
  // Rows about the ACTOR are a different matter and are retained — see the
  // header docblock on why the Oxy identity survives this purge.
  record(
    report, domain, 'postgates',
    await countOrDelete(
      postgates,
      postgates.id,
      or(
        inArray(postgates.postId, removedIdStrings),
        inArray(postgates.postUri, removedPostKeys),
      ) as SQL,
      options.dryRun,
    ),
  );
  record(
    report, domain, 'threadgates',
    await countOrDelete(
      threadgates,
      threadgates.id,
      or(
        inArray(threadgates.postId, removedIdStrings),
        inArray(threadgates.postUri, removedPostKeys),
      ) as SQL,
      options.dryRun,
    ),
  );
  record(
    report, domain, 'feedInteractions',
    await purgeFeedInteractions(removedPostKeys, options.dryRun),
  );
  record(
    report, domain, 'engagementOutbox',
    await countOrDelete(
      engagementOutbox,
      engagementOutbox.id,
      inArray(engagementOutbox.payloadPostId, removedIdStrings),
      options.dryRun,
    ),
  );
  record(
    report, domain, 'reports',
    await countOrDelete(
      reports,
      reports.id,
      and(
        eq(reports.reportedType, 'post'),
        inArray(reports.reportedId, removedIdStrings),
      ) as SQL,
      options.dryRun,
    ),
  );
  record(
    report, domain, 'contentLabels',
    await countOrDelete(
      contentLabels,
      contentLabels.id,
      and(
        eq(contentLabels.targetType, 'post'),
        inArray(contentLabels.targetId, removedIdStrings),
      ) as SQL,
      options.dryRun,
    ),
  );
  record(
    report, domain, 'federationDeliveries',
    options.dryRun
      ? await countDeliveriesReferencingObjects(removedPostKeys)
      : await deleteDeliveriesReferencingObjects(removedPostKeys),
  );

  // Read the media URLs BEFORE the posts go: `post_media` cascades from
  // `posts.id`, so after the delete there is nothing left to read them from and
  // the bytes in our S3 would be unnameable.
  await purgeMediaForUrls(
    await remoteMediaUrlsFor(removedIdStrings), options, report, domain, issues,
  );

  // Boosts before their originals: a boost outliving its target for even part of
  // a run is the one shape that renders as a dead placeholder. (`posts.boost_of`
  // is `ON DELETE CASCADE`, so the database would take them either way — but
  // then the run could not report how many, which is the same reason the side
  // tables above are deleted explicitly.)
  const boostIds = boosts.map((post) => post.id);
  if (boostIds.length > 0) {
    record(
      report, domain, 'boostsByOthers',
      await countOrDelete(posts, posts.id, inArray(posts.id, boostIds), options.dryRun),
    );
  }
  const removedSeeds = await countOrDelete(
    posts,
    posts.id,
    inArray(posts.id, seeds.map((post) => post.id)),
    options.dryRun,
  );
  record(report, domain, seedCountKey, removedSeeds);

  // The gate above could only check the probes this cascade did NOT claim. Now
  // that the posts are gone, re-run the CLAIMED ones with nothing acknowledged:
  // a promise about what a cascade removes is worth what verifying it costs, and
  // here that is one query per claim on a batch we already paged in.
  if (!options.dryRun) {
    const residue = await collectPostCascadeResidue(targets, CASCADED_POST_REFERENCES);
    if (residue.length > 0) {
      logger.warn(`[${SCRIPT_NAME}] cascade left references behind; reconcile before re-running`, {
        domain,
        residue,
      });
      issues.cascadeResidue += residue.length;
    }
  }
  return removedSeeds;
}

// --- per-actor cascade -------------------------------------------------------

interface ActorRow {
  /** `federated_actors.id` — a text primary key, not an ObjectId. */
  id: string;
  uri: string;
  acct: string;
  domain: string;
  oxyUserId?: string;
}

/**
 * Tear down the engagement a blocked actor left on posts that SURVIVE, through
 * the counter-preserving teardown rather than a bulk delete.
 *
 * A bulk `deleteMany` here would leave a local author's like count permanently
 * inflated by engagement from an instance we no longer accept — visible on their
 * own post, with no record left to explain it. `materializeEngagementTombstone`
 * removes the row and moves the counter in one transaction, exactly as an
 * `Undo(Like)` from that instance would have.
 *
 * ## The read and the write must name the SAME store
 *
 * This lane used to page the MONGO `Like`/`Bookmark` collections and hand each
 * row to a tombstone that operates on the POSTGRES `likes`/`bookmarks` tables.
 * The delete matched nothing, `changed` came back false for every row, and the
 * loop recorded the whole page as `engagementResidue` — so a blocked instance's
 * like survived on a local author's post and their like count stayed inflated,
 * which is the exact outcome the counter-preserving teardown exists to prevent.
 *
 * It reads Postgres now, because that is where the rows ARE: no code path
 * creates a Mongo `Like` or `Bookmark` any more (checked — the only writer of
 * either relationship is `PostEngagementCommandService`, and it writes
 * Postgres), so the Mongo collections hold pre-cutover rows that the backfill
 * carries across and nothing adds to.
 *
 * The paragraph that used to close this docblock explained how the lane worked
 * across the dual-run — the script read a post from Mongo and reached its likes
 * in Postgres under the same string, because `posts.id` is `text` holding the
 * ObjectId hex for every pre-cutover row. That bridge is no longer load-bearing
 * anywhere in this file: the post scan reads Postgres too, so the id never
 * crosses stores. It is worth knowing that it HOLDS, because it is what lets a
 * resume cursor written before this port still name a row afterwards.
 */
async function purgeActorEngagement(
  oxyUserId: string,
  options: PurgeOptions,
  report: PurgeReport,
  domain: string,
  issues: RunIssues,
): Promise<void> {
  const db = getDb();
  // Each lane closes over its own concrete table: `likes` and `bookmarks` are
  // separate drizzle tables rather than one union, and narrowing per call site
  // keeps both lanes honest about which one they read.
  const lanes = [
    {
      kind: 'like' as const,
      countKey: 'likesByBlockedActors' as const,
      count: async () => {
        const [row] = await db
          .select({ total: count() })
          .from(likes)
          .where(eq(likes.userId, oxyUserId));
        return row?.total ?? 0;
      },
      page: () => db
        .select({ postId: likes.postId })
        .from(likes)
        .where(eq(likes.userId, oxyUserId))
        .limit(ENGAGEMENT_PAGE_SIZE),
    },
    {
      kind: 'bookmark' as const,
      countKey: 'bookmarksByBlockedActors' as const,
      count: async () => {
        const [row] = await db
          .select({ total: count() })
          .from(bookmarks)
          .where(eq(bookmarks.userId, oxyUserId));
        return row?.total ?? 0;
      },
      page: () => db
        .select({ postId: bookmarks.postId })
        .from(bookmarks)
        .where(eq(bookmarks.userId, oxyUserId))
        .limit(ENGAGEMENT_PAGE_SIZE),
    },
  ];

  for (const { kind, countKey, count, page: readPage } of lanes) {
    if (options.dryRun) {
      record(report, domain, countKey, await count());
      continue;
    }

    for (;;) {
      const page = await readPage();
      if (page.length === 0) break;

      let removedInPage = 0;
      for (const row of page) {
        const { changed } = await materializeEngagementTombstone({
          kind,
          postId: row.postId,
          userId: oxyUserId,
        });
        if (changed) removedInPage += 1;
      }
      record(report, domain, countKey, removedInPage);

      // Nothing removed from a non-empty page means the teardown cannot consume
      // these rows (a downvote, which its `value: 1` filter excludes by design).
      // Looping again would spin forever, so stop and let the run fail loudly
      // with the residue counted rather than silently leave rows behind.
      if (removedInPage === 0) {
        issues.engagementResidue += page.length;
        break;
      }
    }
  }
}

/**
 * Remove every post authored by one blocked actor, in bounded batches, with the
 * full dependent cascade per batch.
 */
async function purgeActorPosts(
  oxyUserId: string,
  options: PurgeOptions,
  report: PurgeReport,
  domain: string,
  issues: RunIssues,
): Promise<void> {
  /**
   * BOTH the denormalized owner and the authorship join, exactly as the Mongo
   * `$or` did — and as the ported `purgeGoneFederatedActors` still does.
   *
   * Narrowing this to `authoredBy` alone is the mistake to avoid, and it is an
   * easy one: that helper is the ONE spelling of the authorship predicate and the
   * feed matchers use it alone on purpose. But `post_authorships` is a child
   * table the raw federated `insertMany` path can omit, and `posts.oxy_user_id`
   * is the projection that survives when it does. A destructive sweep that found
   * only one of the two would leave a blocked actor's posts in place while
   * reporting a clean run — and then refuse the actor's anchor forever, because
   * the anchor preflight can still see them.
   */
  const authored = or(eq(posts.oxyUserId, oxyUserId), authoredBy(oxyUserId)) as SQL;

  let lastId: string | null = null;
  for (;;) {
    const page = await getDb()
      .select(POST_CASCADE_COLUMNS)
      .from(posts)
      .where(lastId === null ? authored : and(authored, gt(posts.id, lastId)))
      .orderBy(asc(posts.id))
      .limit(POST_BATCH_SIZE);
    if (page.length === 0) break;

    await purgePostBatch(page, options, report, domain, issues, 'posts');

    // A live run DELETES the page, so `id > lastId` is what stops it re-reading
    // the same rows forever when a batch was refused; a dry run never deletes
    // anything and relies on it for all paging. `posts.id` is `text` holding an
    // ObjectId hex OR a uuid v7, so this order is NOT chronological — a keyset
    // scan of the whole set only needs a total order that `>` and `ORDER BY`
    // agree on, which it is.
    lastId = page[page.length - 1].id;
  }
}

/** The domain a blocked actor is attributed to, from its row or its uri. */
function domainOf(actor: ActorRow): string {
  return canonicalFederationHost(actor.domain) || hostOf(actor.uri) || actor.domain;
}

/**
 * Purge one blocked-domain actor's CONTENT and the references keyed to them.
 *
 * The `FederatedActor` anchor is deliberately NOT dropped here — see
 * {@link dropBlockedActorAnchors}. The anchor is the only record a re-run can
 * find this actor by, so it must outlive every step that can fail.
 */
async function purgeActorContent(
  actor: ActorRow,
  options: PurgeOptions,
  report: PurgeReport,
  issues: RunIssues,
): Promise<void> {
  const domain = domainOf(actor);
  const oxyUserId = actor.oxyUserId?.trim();

  if (oxyUserId) {
    await purgeActorPosts(oxyUserId, options, report, domain, issues);
    await purgeActorEngagement(oxyUserId, options, report, domain, issues);

    /**
     * `mentions[]` and `repliers[]` were embedded ARRAYS and are child TABLES
     * now, so de-linking is a DELETE of the rows naming this user rather than a
     * `$pull`. Both counters still mean POSTS — the number of posts a mention was
     * pulled out of, the number of projections an entry was pulled out of — so
     * both count distinct posts rather than rows.
     *
     * Deleting the rows, never replacing the set: writing back the whole child
     * set for a post is what destroys rows other tables reference by id, and the
     * `$set` those arrays used to take is exactly the shape that reads as
     * equivalent and is not.
     */
    record(
      report, domain, 'mentionsDelinked',
      await countOrDeleteDistinctPosts(
        postMentions,
        postMentions.postId,
        eq(postMentions.oxyUserId, oxyUserId),
        options.dryRun,
      ),
    );
    // A plain delete rather than the transactional projection repair: this read
    // model is fail-soft and bounded to three entries, so a shorter list until
    // the next reply repopulates it is a cosmetic cost, and a transaction per
    // post across the whole corpus is not.
    record(
      report, domain, 'recentReplierEntriesPulled',
      await countOrDeleteDistinctPosts(
        postRecentRepliers,
        postRecentRepliers.postId,
        eq(postRecentRepliers.oxyUserId, oxyUserId),
        options.dryRun,
      ),
    );

    record(
      report, domain, 'entityFollows',
      await countOrDelete(
        entityFollows, entityFollows.id, eq(entityFollows.userId, oxyUserId), options.dryRun,
      ),
    );
    /**
     * Post subscriptions are AUTHOR-scoped, in BOTH directions.
     *
     * This is the one delete in the script whose Mongo filter could never have
     * matched: it read `{ postId: { $in: … } }` inside the post cascade, and
     * `PostSubscription` has no `postId` — it is `(subscriberId, authorId)`, a
     * standing request to be told about an author's new posts. Mongoose passes an
     * unknown path straight through, so the query was well-formed, matched
     * nothing, and reported a truthful-looking `postSubscriptions: 0` on every
     * run since the script was written.
     *
     * The subscription belongs to the ACTOR, so it is removed here instead, and
     * in both directions for the same reason `notificationsByActor` is: a local
     * user's standing request for a blocked account's posts can never be
     * satisfied again, and the blocked account's request for a local author's
     * posts is engagement from an instance we no longer accept.
     */
    record(
      report, domain, 'postSubscriptions',
      await countOrDelete(
        postSubscriptions,
        postSubscriptions.id,
        or(
          eq(postSubscriptions.subscriberId, oxyUserId),
          eq(postSubscriptions.authorId, oxyUserId),
        ) as SQL,
        options.dryRun,
      ),
    );
    record(
      report, domain, 'notificationsByActor',
      await countOrDelete(
        notifications,
        notifications.id,
        or(
          eq(notifications.recipientId, oxyUserId),
          eq(notifications.actorId, oxyUserId),
        ) as SQL,
        options.dryRun,
      ),
    );
  }

  // Counted BEFORE the delete, because after it there is nothing left to count —
  // and this is the number the automatic path's circuit breaker refuses on.
  record(
    report, domain, 'localFollowsRemoved',
    await countFollows({
      remoteActorUri: actor.uri,
      direction: 'outbound',
      statuses: ['accepted'],
    }),
  );
  record(
    report, domain, 'federatedFollows',
    options.dryRun
      ? await countFollows({ remoteActorUri: actor.uri })
      : await deleteFollowsFor({ remoteActorUri: actor.uri }),
  );
}

// --- phases ------------------------------------------------------------------

/**
 * A phase's cursor scope, namespaced by the DOMAIN SET this run is sweeping.
 *
 * A resume cursor records how far a sweep got through a collection, which only
 * means anything relative to the territory it was sweeping. Without this, a
 * second run over a DIFFERENT set of domains would resume from the first run's
 * completed cursor — sitting at the end of the collection — scan nothing, and
 * report a clean zero. That is the worst shape a bug in this script can take:
 * a blocklist that looks enforced while the content is still served, arriving
 * silently and only on the SECOND domain ever blocked.
 *
 * The namespace is derived here rather than passed in, so no caller can forget
 * it. Identical sets resume each other (the point of a cursor); any change of
 * set starts fresh, and re-running an identical set deliberately is what
 * `RESET_CURSOR` is for.
 */
function cursorScope(phase: string, domains: ReadonlySet<string>): string {
  const namespace = createHash('sha256')
    .update([...domains].sort().join(','))
    .digest('hex')
    .slice(0, 12);
  return `${phase}:${namespace}`;
}

/** Where a phase resumes from, honouring `RESET_CURSOR`. */
async function resumePoint(
  scope: string,
  options: PurgeOptions,
): Promise<{ lastId: string | null; scanned: number }> {
  if (options.resetCursor) {
    await clearAdminScriptCursor(SCRIPT_NAME, scope);
    return { lastId: null, scanned: 0 };
  }
  const stored = await readAdminScriptCursor(SCRIPT_NAME, scope);
  // NO SHAPE GUARD. This used to be `mongoose.isValidObjectId(stored.cursor)`,
  // which returns FALSE for a uuid v7 — the id every row created after the
  // cutover carries. Its false answer means "start from the beginning", so the
  // cursor would silently stop resuming, permanently, with no error: a
  // destructive sweep re-walking the corpus from the top on every attempt. The
  // primary key is now an opaque text id and the only thing worth asking of a
  // stored cursor is whether there IS one.
  if (!stored || stored.cursor.length === 0) return { lastId: null, scanned: 0 };
  return { lastId: stored.cursor, scanned: stored.scanned };
}

/*
 * `toMongoCursor` used to live here, and its removal IS this port's receipt.
 *
 * It existed because `orphan-posts` and `media` paged Mongo collections whose
 * ids really were ObjectIds, and it THREW rather than answering `null` for
 * anything else — because `null` means "start from the beginning", and a
 * destructive sweep silently re-walking the corpus on every attempt is the worst
 * shape a bug in this script can take. Its docblock said the guard could not fire
 * yet, and that the moment those two phases ported, every cursor would become a
 * uuid v7 and this helper had to go WITH them rather than be relaxed. Both phases
 * page Postgres now, both cursors are opaque `text` ids, and there is nothing
 * left to cast — so it is gone, exactly as instructed, rather than loosened into
 * something that would answer `null`.
 */

/**
 * A dry run must not write, and a cursor row IS a write — so progress is only
 * ever recorded for a mutating run. A dry run is cheap to repeat from the top and
 * has nothing to lose by dying; a destructive one has everything to.
 */
async function saveProgress(
  scope: string,
  options: PurgeOptions,
  cursor: string,
  scanned: number,
  issues: RunIssues,
  completed?: boolean,
): Promise<void> {
  if (options.dryRun) return;
  const persisted = await recordAdminScriptCursor(SCRIPT_NAME, scope, {
    cursor,
    scanned,
    completed,
  });
  if (!persisted) issues.cursorWriteFailed += 1;
}

/**
 * Walk every `FederatedActor` on a blocked domain, in `_id` order, applying
 * `PURGE_LIMIT` to the MATCHED actors.
 *
 * Shared by the content phase and the anchor phase so both cover exactly the same
 * actors under the same canary budget — an anchor dropped for an actor whose
 * content was never reached would be an actor no re-run could find again.
 */
async function forEachBlockedActor(
  scope: string,
  domains: ReadonlySet<string>,
  options: PurgeOptions,
  issues: RunIssues,
  visit: (actor: ActorRow) => Promise<void>,
): Promise<void> {
  const { lastId: resumeId, scanned: alreadyScanned } = await resumePoint(scope, options);
  let lastId = resumeId;
  let scanned = alreadyScanned;
  let processed = 0;

  for (;;) {
    if (options.limit !== undefined && processed >= options.limit) break;

    const page = await scanActors(
      {},
      { afterId: lastId ?? undefined, limit: PAGE_SIZE },
    );
    if (page.length === 0) {
      if (lastId) await saveProgress(scope, options, lastId, scanned, issues, true);
      break;
    }

    for (const actor of page) {
      scanned += 1;
      const uriHost = hostOf(actor.uri);
      if (!domains.has(canonicalFederationHost(actor.domain)) && (uriHost === null || !domains.has(uriHost))) {
        continue;
      }
      if (options.limit !== undefined && processed >= options.limit) break;
      await visit(actor);
      processed += 1;
    }

    lastId = page[page.length - 1].id;
    await saveProgress(scope, options, lastId, scanned, issues);
    logger.info(`[${SCRIPT_NAME}] phase progress`, { scope, scanned, processed });
  }
}

/**
 * The Oxy user ids the blocked actors resolved to — phase 1's territory, read in
 * one paged pass before anything is removed.
 */
async function loadBlockedOwnerIds(domains: ReadonlySet<string>): Promise<ReadonlySet<string>> {
  const owners = new Set<string>();
  let lastId: string | null = null;

  for (;;) {
    const page = await scanActors({}, { afterId: lastId ?? undefined, limit: PAGE_SIZE });
    if (page.length === 0) break;

    for (const actor of page) {
      const owner = actor.oxyUserId?.trim();
      if (!owner) continue;
      const uriHost = hostOf(actor.uri);
      if (!domains.has(canonicalFederationHost(actor.domain)) && (uriHost === null || !domains.has(uriHost))) {
        continue;
      }
      owners.add(owner);
    }

    lastId = page[page.length - 1].id;
  }

  return owners;
}

/** Phase 1 — every blocked actor's posts, engagement and keyed references. */
async function purgeBlockedActorContent(
  domains: ReadonlySet<string>,
  options: PurgeOptions,
  report: PurgeReport,
  issues: RunIssues,
): Promise<void> {
  await forEachBlockedActor(cursorScope(SCOPE_ACTORS, domains), domains, options, issues, (actor) =>
    purgeActorContent(actor, options, report, issues));
}

/**
 * Phase 4 — drop the `FederatedActor` anchor rows, once every content phase has
 * run.
 *
 * LAST, globally, and for the same reason the gone-actor purge drops an anchor
 * last per actor: it is the only record by which a re-run can find this actor, so
 * it must outlive every step that can fail. Running it after the orphan-post
 * phase also means the anchor preflight is asked its question in a world where
 * the uri-keyed posts are already gone — otherwise an orphan post would refuse
 * the anchor of the very actor whose content the run had just removed.
 */
async function dropBlockedActorAnchors(
  domains: ReadonlySet<string>,
  options: PurgeOptions,
  report: PurgeReport,
  issues: RunIssues,
): Promise<void> {
  await forEachBlockedActor(cursorScope(SCOPE_ANCHORS, domains), domains, options, issues, async (actor) => {
    const domain = domainOf(actor);

    // A dry run never entered the world this preflight asks about: the posts that
    // name this actor are all still there precisely BECAUSE nothing was deleted,
    // so the probe would report a refusal a live run does not produce — and the
    // report would then show zero actors and a run-failing issue count for a
    // preview that is working correctly. Report the anchor as would-remove and
    // leave the question to the run that can actually answer it.
    if (options.dryRun) {
      record(report, domain, 'actors', 1);
      return;
    }

    try {
      await assertActorAnchorSafeToDelete(`${SCRIPT_NAME}:${domain}`, { actorUri: actor.uri });
    } catch (error) {
      if (!(error instanceof DeletionPreflightError)) throw error;
      logger.warn(`[${SCRIPT_NAME}] anchor preflight refused an actor; its row was kept`, {
        domain,
        blockers: error.blockers,
      });
      issues.preflightBlocked += 1;
      return;
    }
    // Reached only on a live run — the dry-run branch above returned already —
    // so this is unconditionally a delete rather than a count-or-delete.
    record(report, domain, 'actors', await deleteActorsByUris([actor.uri]));
  });
}

/**
 * Phase 2 — posts a blocked instance authored that phase 1 cannot reach.
 *
 * Scoped to posts that HAVE a `federation.actorUri`, which is the property that
 * makes this safe: a post without one is not federated, so no local user's own
 * content can be matched here however the blocklist is configured.
 */
async function purgeOrphanBlockedPosts(
  domains: ReadonlySet<string>,
  blockedOwnerIds: ReadonlySet<string>,
  options: PurgeOptions,
  report: PurgeReport,
  issues: RunIssues,
): Promise<void> {
  const { lastId: resumeId, scanned: alreadyScanned } = await resumePoint(cursorScope(SCOPE_ORPHAN_POSTS, domains), options);
  let lastId: string | null = resumeId;
  let scanned = alreadyScanned;

  for (;;) {
    const federated = isNotNull(posts.federationActorUri);
    const page = await getDb()
      .select(POST_CASCADE_COLUMNS)
      .from(posts)
      .where(lastId === null ? federated : and(federated, gt(posts.id, lastId)))
      .orderBy(asc(posts.id))
      .limit(PAGE_SIZE);
    if (page.length === 0) {
      if (lastId) await saveProgress(cursorScope(SCOPE_ORPHAN_POSTS, domains), options, lastId, scanned, issues, true);
      break;
    }

    scanned += page.length;
    /**
     * The page's OWNERS, resolved the same way phase 1 resolves them.
     *
     * `posts.oxy_user_id` is a projection the raw federated insert path can omit,
     * so the skip below cannot read ownership off it alone: a post owned by a
     * blocked actor through `post_authorships` and nothing else would fail the
     * skip, and a DRY RUN — which deletes nothing, so phase 1 leaves it in place
     * — would count it under BOTH phases and report a blast radius larger than
     * the real one to the person authorising the deletion.
     */
    const ownerByPost = new Map<string, string>();
    for (const post of page) {
      if (post.oxyUserId !== null) ownerByPost.set(post.id, post.oxyUserId);
    }
    const missingOwner = page.filter((post) => post.oxyUserId === null).map((post) => post.id);
    if (missingOwner.length > 0) {
      const owners = await getDb()
        .select({ postId: postAuthorships.postId, oxyUserId: postAuthorships.oxyUserId })
        .from(postAuthorships)
        .where(
          and(
            inArray(postAuthorships.postId, missingOwner),
            eq(postAuthorships.role, 'owner'),
          ),
        );
      for (const owner of owners) ownerByPost.set(owner.postId, owner.oxyUserId);
    }

    const byDomain = new Map<string, PostRow[]>();
    for (const post of page) {
      const actorUri = post.federationActorUri;
      if (actorUri === null) continue;
      const host = hostOf(actorUri);
      if (host === null || !domains.has(host)) continue;
      // Phase 1 owns every post whose author is a blocked actor we hold a row
      // for. Skipping them here is what keeps `orphanPosts` meaning exactly "what
      // the actor-anchored count misses".
      const owner = ownerByPost.get(post.id);
      if (owner !== undefined && blockedOwnerIds.has(owner)) continue;
      const bucket = byDomain.get(host);
      if (bucket) bucket.push(post);
      else byDomain.set(host, [post]);
    }

    for (const [domain, posts] of byDomain) {
      for (const batch of chunk(posts, POST_BATCH_SIZE)) {
        await purgePostBatch(batch, options, report, domain, issues, 'orphanPosts');
      }
    }

    lastId = page[page.length - 1].id;
    await saveProgress(cursorScope(SCOPE_ORPHAN_POSTS, domains), options, lastId, scanned, issues);
    logger.info(`[${SCRIPT_NAME}] phase orphan-posts progress`, { scanned });
  }
}

/** Phase 3 — cached media bytes served from a blocked host. */
async function purgeBlockedMediaCache(
  domains: ReadonlySet<string>,
  options: PurgeOptions,
  report: PurgeReport,
  issues: RunIssues,
): Promise<void> {
  const { lastId: resumeId, scanned: alreadyScanned } = await resumePoint(cursorScope(SCOPE_MEDIA, domains), options);
  let lastId: string | null = resumeId;
  let scanned = alreadyScanned;

  for (;;) {
    const page = await pageMediaCacheRows(lastId, PAGE_SIZE);
    if (page.length === 0) {
      if (lastId) await saveProgress(cursorScope(SCOPE_MEDIA, domains), options, lastId, scanned, issues, true);
      break;
    }

    scanned += page.length;
    const byDomain = new Map<string, string[]>();
    for (const row of page) {
      const host = hostOf(row.remoteUrl);
      if (host === null || !domains.has(host)) continue;
      const bucket = byDomain.get(host);
      if (bucket) bucket.push(row.remoteUrl);
      else byDomain.set(host, [row.remoteUrl]);
    }
    for (const [domain, urls] of byDomain) {
      await purgeMediaForUrls(urls, options, report, domain, issues);
    }

    lastId = page[page.length - 1].id;
    await saveProgress(cursorScope(SCOPE_MEDIA, domains), options, lastId, scanned, issues);
  }
}

// --- run ---------------------------------------------------------------------

/**
 * Run every phase against an already-connected database.
 *
 * Exported without the connection lifecycle so it is testable in process, the
 * same split `reportFederationBlocklistCandidates` uses.
 */
export async function purgeBlockedDomainContent(
  domains: ReadonlySet<string>,
  options: PurgeOptions,
): Promise<PurgeReport> {
  const issues: RunIssues = {
    preflightBlocked: 0,
    mediaObjectDeleteFailed: 0,
    cursorWriteFailed: 0,
    engagementResidue: 0,
    cascadeResidue: 0,
  };
  const report: PurgeReport = {
    dryRun: options.dryRun,
    domains: domains.size,
    corpus: { federatedPosts: 0, federatedActors: 0 },
    totals: emptyCounts(),
    byDomain: new Map(),
    issues,
  };

  // Read BEFORE phase 1 removes anything, so the orphan phase can tell a post
  // phase 1 already owns from one whose actor row we never had. Bounded by the
  // number of actors on the blocklist, which is the same set phase 1 walks.
  const blockedOwnerIds = await loadBlockedOwnerIds(domains);

  // The denominators the automatic path's ceilings are shares of, measured
  // before anything is removed. Counted directly rather than accumulated during
  // the paged scans: a RESUMED run only pages the remainder of its range, which
  // would report a corpus smaller than reality and quietly move every ceiling.
  const [federatedPostCount] = await getDb()
    .select({ total: count() })
    .from(posts)
    .where(isNotNull(posts.federationActorUri));
  report.corpus = {
    federatedPosts: federatedPostCount?.total ?? 0,
    federatedActors: await countActors({}),
  };

  await purgeBlockedActorContent(domains, options, report, issues);
  await purgeOrphanBlockedPosts(domains, blockedOwnerIds, options, report, issues);
  await purgeBlockedMediaCache(domains, options, report, issues);
  await dropBlockedActorAnchors(domains, options, report, issues);

  return report;
}

/**
 * Record a REVIEWED MANUAL run in the same ledger the automatic path writes.
 *
 * Without this the two paths tell different stories: the reviewed run that
 * clears the pre-existing backlog would leave every one of those domains
 * recorded as `baseline` — never purged — for as long as the ledger lives, and
 * any surface reading it (a transparency page, the next reconciliation, a human)
 * would be looking at a record that is simply false. One action, one record,
 * whoever started it.
 *
 * Never blocks the run: the deletion has already happened by the time this is
 * called, and failing to write its receipt must not make a completed purge look
 * like a failed one. It is logged loudly instead.
 */
async function recordManualRunInLedger(
  report: PurgeReport,
  options: PurgeOptions,
): Promise<void> {
  if (options.dryRun) return;

  const now = new Date();
  const runId = `manual-${now.toISOString()}`;
  // The policy's own words for these domains, so a reviewed run's record reads
  // the same as an automatic one's rather than being an unexplained deletion.
  const entryByDomain = new Map(getBlockedDomainPolicy().map((entry) => [entry.domain, entry]));
  try {
    // Batched, matching the automatic path: both write the SAME ledger, and one
    // action must leave one record whoever started it.
    await recordPurgeOutcomes(
      [...report.byDomain.keys()].map((domain) => ({ domain })),
      { state: 'purged', runId, now },
    );
    await recordPurgeRun(
      [...report.byDomain].map(([domain, counts]) => {
        const entry = entryByDomain.get(domain);
        return {
          domain,
          removed: toLedgerCounts(counts),
          reason: entry?.reason,
          category: entry?.category,
          corroboratingSources: entry ? [...entry.corroboratingSources] : undefined,
        };
      }),
      { runId, runAt: now, trigger: 'manual' },
    );
  } catch (error) {
    logger.error(
      `[${SCRIPT_NAME}] the purge completed but its ledger record could not be written`,
      error,
    );
  }
}

/** The per-domain table, ranked by what each domain costs, one line per row. */
export function renderDomainTable(report: PurgeReport): string[] {
  const rows = [...report.byDomain.entries()]
    .map(([domain, counts]) => ({ domain, counts }))
    .filter(({ counts }) => COUNT_KEYS.some((key) => counts[key] > 0))
    .sort((a, b) =>
      (b.counts.posts + b.counts.orphanPosts) - (a.counts.posts + a.counts.orphanPosts)
      || b.counts.actors - a.counts.actors
      || a.domain.localeCompare(b.domain));

  if (rows.length === 0) return ['no blocked domain held any content'];

  const cells = rows.map(({ domain, counts }) => ({
    domain,
    actors: String(counts.actors),
    posts: String(counts.posts + counts.orphanPosts),
    orphans: String(counts.orphanPosts),
    boosts: String(counts.boostsByOthers),
    likes: String(counts.likesOnRemovedPosts + counts.likesByBlockedActors),
    notifs: String(counts.notificationsByEntity + counts.notificationsByActor),
    media: String(counts.mediaCacheRows),
    kept: `${counts.repliesByOthersKept}r/${counts.quotesByOthersKept}q`,
  }));
  const header = {
    domain: 'DOMAIN',
    actors: 'ACTORS',
    posts: 'POSTS',
    orphans: 'ORPHANS',
    boosts: 'BOOSTS',
    likes: 'LIKES',
    notifs: 'NOTIFS',
    media: 'MEDIA',
    kept: 'LOCAL-KEPT',
  };

  const columns = Object.keys(header) as (keyof typeof header)[];
  const widths = new Map<string, number>(
    columns.map((column) => [
      column,
      Math.max(header[column].length, ...cells.map((row) => row[column].length)),
    ]),
  );
  const renderRow = (row: Record<string, string>): string =>
    columns.map((column) => row[column].padEnd(widths.get(column) ?? 0)).join('  ').trimEnd();

  return [renderRow(header), ...cells.map(renderRow)];
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const options = readOptions();

  try {
    assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun: options.dryRun });

    // The reviewed run sweeps what the committed policy blocks, so the operator
    // does not have to paste the reviewed list back in as an environment string
    // and cannot mistype it while doing so. The env lever is unioned in for an
    // emergency block that has not been written up yet — permissible here, where
    // a person is confirming the run, and never on the automatic path.
    const domains = buildBlockedContentDomains(
      [
        ...getBlockedDomainPolicy().map((entry) => entry.domain),
        ...config.federation.blockedDomains,
      ],
      OWN_DOMAINS,
      options.domain,
    );

    /**
     * POSTGRES ONLY. The comment that used to sit here justified a Mongo
     * connection by saying `feed_interactions` still had a live Mongo writer —
     * it does not: `purgeFeedInteractions` deletes through `getDb()` against the
     * `feed_interactions` TABLE, and the Mongoose model was deleted once nothing
     * imported it. The connection outlived its reason, and the reason outlived
     * its truth, which is the more dangerous half: a stale justification reads as
     * a decision somebody made.
     */
    await connectPostgres();
    logger.info(`[${SCRIPT_NAME}] connected`, {
      dryRun: options.dryRun,
      domains: domains.size,
      limit: options.limit,
      narrowedScope: Boolean(options.domain),
    });

    const report = await purgeBlockedDomainContent(domains, options);
    await recordManualRunInLedger(report, options);

    // One record per line: the backend logger caps a single string field, and a
    // table in one field is truncated exactly where the tail of the ranking is.
    for (const line of renderDomainTable(report)) {
      logger.info(`[${SCRIPT_NAME}] domain`, { row: line });
    }
    logger.info(
      `[${SCRIPT_NAME}] ${options.dryRun ? 'WOULD-remove' : 'removed'} totals`,
      Object.fromEntries(COUNT_KEYS.map((key) => [key, report.totals[key]])),
    );
    logger.info(`[${SCRIPT_NAME}] done`, {
      dryRun: options.dryRun,
      domainsWithContent: report.byDomain.size,
      durationMs: Date.now() - startedAt,
    });

    assertAdminRunComplete(SCRIPT_NAME, {
      preflightBlocked: report.issues.preflightBlocked,
      mediaObjectDeleteFailed: report.issues.mediaObjectDeleteFailed,
      cursorWriteFailed: report.issues.cursorWriteFailed,
      engagementResidue: report.issues.engagementResidue,
      cascadeResidue: report.issues.cascadeResidue,
    });
  } catch (error) {
    logger.error(`[${SCRIPT_NAME}] failed`, error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis handles, the media
  // cache worker) keep the event loop alive, so a Fargate one-shot would sit
  // RUNNING after the work completed. Mirrors the other federation one-shots.
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(`[${SCRIPT_NAME}] unhandled failure`, error);
      process.exit(1);
    });
}

export default purgeBlockedDomainContent;
