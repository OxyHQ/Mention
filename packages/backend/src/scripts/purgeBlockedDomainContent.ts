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
 *   - Resumable + idempotent: progress is recorded in Mongo after every page
 *     (a Fargate one-shot's filesystem dies with the task), and a completed run
 *     re-run matches nothing.
 *   - `assertPostsSafeToDelete` runs before every post deletion; a blocked batch
 *     is skipped and counted, never forced.
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
import mongoose from 'mongoose';
import type { FilterQuery, Model } from 'mongoose';
import { count, eq } from 'drizzle-orm';
import { PostType } from '@mention/shared-types';
import { config } from '../config';
import { connectToDatabase } from '../utils/database';
import { connectPostgres, getDb } from '../db/postgres';
import { bookmarks, likes } from '../db/schema/engagement';
import { Post } from '../models/Post';
import Like from '../models/Like';
import Bookmark from '../models/Bookmark';
import Notification from '../models/Notification';
import Poll from '../models/Poll';
import Article from '../models/Article';
import PostSubscription from '../models/PostSubscription';
import PostRecentReplier from '../models/PostRecentReplier';
import {
  countActors,
  deleteActorsByUris,
  scanActors,
} from '../db/federation/actorRepository';
import { countFollows, deleteFollowsFor } from '../db/federation/followRepository';
import { EntityFollow } from '../models/EntityFollow';
import FederatedMediaCache from '../models/FederatedMediaCache';
import {
  recordPurgeOutcomes,
  recordPurgeRun,
  toLedgerCounts,
} from '../db/blocklist/blockedDomainPurgeRepository';
import { canonicalFederationHost } from '@oxyhq/federation';
import { getBlockedDomainPolicy } from '../connectors/activitypub/federationBlockPolicy';
import { Postgate } from '../models/Postgate';
import { Threadgate } from '../models/Threadgate';
import { FeedInteraction } from '../models/FeedInteraction';
import EngagementOutbox from '../models/EngagementOutbox';
import FederationDeliveryQueue from '../models/FederationDeliveryQueue';
import ContentLabel from '../models/ContentLabel';
import Report, { ReportedType } from '../models/Report.model';
import {
  ACTOR_DOMAIN,
  FEDERATION_DOMAIN,
  OXY_IDENTITY_APEX,
} from '../connectors/activitypub/constants';
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
 * Count (under `DRY_RUN`) or delete (live) the documents matching `filter`,
 * returning the affected count either way.
 *
 * This is the SINGLE place a document is removed, which is what makes the
 * dry-run guarantee checkable rather than a claim: no other code path in this
 * module calls `deleteMany`/`deleteOne`.
 */
async function countOrDelete<T>(
  model: Model<T>,
  filter: FilterQuery<T>,
  dryRun: boolean,
): Promise<number> {
  if (dryRun) return model.countDocuments(filter).exec();
  const result = await model.deleteMany(filter).exec();
  return result.deletedCount ?? 0;
}

// --- post cascade ------------------------------------------------------------

/** The lean `Post` shape every cascade decision reads. */
interface PostRow {
  _id: mongoose.Types.ObjectId;
  type?: string;
  oxyUserId?: string;
  boostOf?: string;
  parentPostId?: string;
  quoteOf?: string;
  federation?: { activityId?: string; url?: string; actorUri?: string };
  media?: unknown[];
  content?: { pollId?: string; article?: { articleId?: string } };
}

const POST_CASCADE_PROJECTION = {
  _id: 1,
  type: 1,
  oxyUserId: 1,
  boostOf: 1,
  parentPostId: 1,
  quoteOf: 1,
  federation: 1,
  media: 1,
  'content.pollId': 1,
  'content.article.articleId': 1,
} as const;

/** Remote media URLs a post references, from the `media[]` items' `id` field. */
function mediaUrlsOf(post: PostRow): string[] {
  if (!Array.isArray(post.media)) return [];
  const urls: string[] = [];
  for (const item of post.media) {
    if (typeof item !== 'object' || item === null) continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id === 'string' && /^https?:\/\//i.test(id)) urls.push(id);
  }
  return urls;
}

/** The AP uris a post is addressable by, for the deletion preflight. */
function postUris(post: PostRow): string[] {
  return [post.federation?.activityId, post.federation?.url].filter(
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
    const rows = await FederatedMediaCache.find(
      { remoteUrl: { $in: batch } },
      { remoteUrl: 1, oxyFileId: 1, posterFileId: 1 },
    ).lean<Array<{ remoteUrl: string; oxyFileId?: string; posterFileId?: string }>>();
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
        issues.mediaObjectDeleteFailed += fileIds.length;
        continue;
      }

      const results = await Promise.allSettled(fileIds.map((id) => deleteCachedMedia(id)));
      const failed = results.filter((result) => result.status === 'rejected');
      if (failed.length > 0) {
        logger.warn(`[${SCRIPT_NAME}] cached media delete failed; keeping its row for retry`, {
          domain,
          failedCount: failed.length,
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
      await countOrDelete(FederatedMediaCache, { remoteUrl: { $in: removable } }, options.dryRun),
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
  const survivingTargets = removed
    .filter((post) => typeof post.boostOf === 'string' && !removedIds.has(post.boostOf))
    .map((post) => ({ boostOf: String(post.boostOf), federated: Boolean(post.federation) }));
  if (survivingTargets.length === 0) return;

  for (const target of survivingTargets) {
    if (!mongoose.isValidObjectId(target.boostOf)) continue;
    if (options.dryRun) {
      // The post must still exist for a decrement to be meaningful; counting the
      // same predicate the live write uses keeps the dry-run figure honest.
      const exists = await Post.countDocuments({
        _id: target.boostOf,
        'stats.boostsCount': { $gt: 0 },
      }).exec();
      record(report, domain, 'boostCountersRepaired', exists > 0 ? 1 : 0);
      continue;
    }

    const updated = await Post.updateOne(
      { _id: target.boostOf, 'stats.boostsCount': { $gt: 0 } },
      { $inc: { 'stats.boostsCount': -1 } },
    );
    record(report, domain, 'boostCountersRepaired', updated.modifiedCount);
    if (target.federated) {
      await Post.updateOne(
        { _id: target.boostOf, 'stats.federatedBoostsCount': { $gt: 0 } },
        { $inc: { 'stats.federatedBoostsCount': -1 } },
      );
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
  const dependents = await Post.find(
    {
      _id: { $nin: [...removedIds].map((id) => new mongoose.Types.ObjectId(id)) },
      $or: [
        { parentPostId: { $in: removedIdStrings } },
        { quoteOf: { $in: removedIdStrings } },
        { threadId: { $in: removedIdStrings } },
      ],
    },
    { _id: 1, parentPostId: 1, quoteOf: 1, threadId: 1 },
  ).lean<Array<{ parentPostId?: string; quoteOf?: string; threadId?: string }>>();

  let replies = 0;
  let quotes = 0;
  let threadRoots = 0;
  for (const dependent of dependents) {
    if (dependent.parentPostId && removedIds.has(String(dependent.parentPostId))) replies += 1;
    if (dependent.quoteOf && removedIds.has(String(dependent.quoteOf))) quotes += 1;
    if (dependent.threadId && removedIds.has(String(dependent.threadId))) threadRoots += 1;
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
  const seen = new Set(seeds.map((post) => post._id.toString()));
  const found: PostRow[] = [];
  let frontier = seeds.map((post) => post._id.toString());

  while (frontier.length > 0) {
    const next = await Post.find(
      { type: PostType.BOOST, boostOf: { $in: frontier } },
      POST_CASCADE_PROJECTION,
    ).lean<PostRow[]>();

    frontier = [];
    for (const boost of next) {
      const id = boost._id.toString();
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(boost);
      frontier.push(id);
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
  const removedIds = removed.map((post) => post._id);
  const removedIdStrings = removed.map((post) => post._id.toString());
  const removedIdSet = new Set(removedIdStrings);

  // `id` is a STRING here, not the raw ObjectId: `posts.id` is a `text` column
  // and every probe binds the id as a parameter, so the preflight's contract is
  // the stringified form.
  const targets: PostDeletionTarget[] = removed.map((post) => ({
    id: post._id.toString(),
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

  // Engagement and side tables FIRST, so nothing can be left pointing at a post
  // id that no longer resolves if the run dies mid-batch.
  //
  // These two stay on MONGO, unlike `purgeActorEngagement` above, and the
  // difference is not an oversight. That lane is about a post that SURVIVES, so
  // both stores agree the post is there and the tombstone is correct in either.
  // This lane is about a post this script REMOVED — and it removes it from Mongo
  // only, because the post deletion itself is not ported. The Postgres row
  // survives, so deleting its Postgres likes here would strip engagement from a
  // post that is still live in the store the feeds actually read.
  //
  // What that leaves is bounded and belongs to the post deletion, not here:
  // pre-cutover Mongo rows are cleaned up, and the Postgres rows go when the
  // Postgres post does (`likes.post_id` and `bookmarks.post_id` are both
  // `ON DELETE CASCADE`, so porting the deletion closes this with no lane of its
  // own). Nothing new accumulates either way — no code path creates a Mongo
  // `Like` or `Bookmark` any more.
  record(
    report, domain, 'likesOnRemovedPosts',
    await countOrDelete(Like, { postId: { $in: removedIds } }, options.dryRun),
  );
  record(
    report, domain, 'bookmarksOnRemovedPosts',
    await countOrDelete(Bookmark, { postId: { $in: removedIds } }, options.dryRun),
  );
  record(
    report, domain, 'postSubscriptions',
    await countOrDelete(
      PostSubscription,
      { postId: { $in: [...removedIds, ...removedIdStrings] } },
      options.dryRun,
    ),
  );
  record(
    report, domain, 'notificationsByEntity',
    await countOrDelete(Notification, { entityId: { $in: removedIds } }, options.dryRun),
  );
  record(
    report, domain, 'recentReplierProjections',
    await countOrDelete(PostRecentReplier, { postId: { $in: removedIdStrings } }, options.dryRun),
  );

  const pollIds = removed
    .map((post) => post.content?.pollId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  record(
    report, domain, 'polls',
    await countOrDelete(
      Poll,
      {
        $or: [
          { postId: { $in: [...removedIds, ...removedIdStrings] } },
          ...(pollIds.length > 0 ? [{ _id: { $in: pollIds } }] : []),
        ],
      },
      options.dryRun,
    ),
  );

  const articleIds = removed
    .map((post) => post.content?.article?.articleId)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  record(
    report, domain, 'articles',
    await countOrDelete(
      Article,
      {
        $or: [
          { postId: { $in: removedIdStrings } },
          ...(articleIds.length > 0 ? [{ _id: { $in: articleIds } }] : []),
        ],
      },
      options.dryRun,
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
      Postgate,
      { $or: [{ postId: { $in: removedIdStrings } }, { postUri: { $in: removedPostKeys } }] },
      options.dryRun,
    ),
  );
  record(
    report, domain, 'threadgates',
    await countOrDelete(
      Threadgate,
      { $or: [{ postId: { $in: removedIdStrings } }, { postUri: { $in: removedPostKeys } }] },
      options.dryRun,
    ),
  );
  record(
    report, domain, 'feedInteractions',
    await countOrDelete(FeedInteraction, { postUri: { $in: removedPostKeys } }, options.dryRun),
  );
  record(
    report, domain, 'engagementOutbox',
    await countOrDelete(
      EngagementOutbox,
      { 'payload.postId': { $in: removedIdStrings } },
      options.dryRun,
    ),
  );
  record(
    report, domain, 'reports',
    await countOrDelete(
      Report,
      { reportedType: ReportedType.POST, reportedId: { $in: removedIdStrings } },
      options.dryRun,
    ),
  );
  record(
    report, domain, 'contentLabels',
    await countOrDelete(
      ContentLabel,
      { targetType: 'post', targetId: { $in: removedIdStrings } },
      options.dryRun,
    ),
  );
  record(
    report, domain, 'federationDeliveries',
    await countOrDelete(
      FederationDeliveryQueue,
      {
        $or: [
          { 'activityJson.id': { $in: removedPostKeys } },
          { 'activityJson.object.id': { $in: removedPostKeys } },
          { 'activityJson.object': { $in: removedPostKeys } },
        ],
      },
      options.dryRun,
    ),
  );

  await purgeMediaForUrls(removed.flatMap(mediaUrlsOf), options, report, domain, issues);

  // Boosts before their originals: a boost outliving its target for even part of
  // a run is the one shape that renders as a dead placeholder.
  const boostIds = boosts.map((post) => post._id);
  if (boostIds.length > 0) {
    record(
      report, domain, 'boostsByOthers',
      await countOrDelete(Post, { _id: { $in: boostIds } }, options.dryRun),
    );
  }
  const removedSeeds = await countOrDelete(
    Post,
    { _id: { $in: seeds.map((post) => post._id) } },
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
 * This works during the dual-run precisely because `posts.id` is `text` holding
 * the 24-character ObjectId hex for every pre-cutover post: a Mongo `_id` and
 * its Postgres `posts.id` are the same string, so a like the blocked actor left
 * on a post this script sees in Mongo is reachable in Postgres under the id the
 * script already has.
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
  const authored: FilterQuery<unknown> = {
    $or: [
      { oxyUserId },
      { authorship: { $elemMatch: { oxyUserId, role: 'owner' } } },
    ],
  };

  let lastId: mongoose.Types.ObjectId | null = null;
  for (;;) {
    const filter: Record<string, unknown> = { ...authored };
    if (lastId) filter._id = { $gt: lastId };

    const page = await Post.find(filter, POST_CASCADE_PROJECTION)
      .sort({ _id: 1 })
      .limit(POST_BATCH_SIZE)
      .lean<PostRow[]>();
    if (page.length === 0) break;

    await purgePostBatch(page, options, report, domain, issues, 'posts');

    // A live run DELETES the page, so `{ _id: { $gt: lastId } }` is what stops it
    // re-reading the same rows forever when a batch was refused; a dry run never
    // deletes anything and relies on it for all paging.
    lastId = page[page.length - 1]._id;
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

    if (options.dryRun) {
      record(report, domain, 'mentionsDelinked', await Post.countDocuments({ mentions: oxyUserId }).exec());
      record(
        report, domain, 'recentReplierEntriesPulled',
        await PostRecentReplier.countDocuments({ 'repliers.oxyUserId': oxyUserId }).exec(),
      );
    } else {
      const delinked = await Post.updateMany(
        { mentions: oxyUserId },
        { $pull: { mentions: oxyUserId } },
      );
      record(report, domain, 'mentionsDelinked', delinked.modifiedCount);
      // `$pull` rather than the transactional projection repair: this read model
      // is fail-soft and bounded to three entries, so a shorter list until the
      // next reply repopulates it is a cosmetic cost, and a transaction per post
      // across the whole corpus is not.
      const pulled = await PostRecentReplier.updateMany(
        { 'repliers.oxyUserId': oxyUserId },
        { $pull: { repliers: { oxyUserId } } },
      );
      record(report, domain, 'recentReplierEntriesPulled', pulled.modifiedCount);
    }

    record(
      report, domain, 'entityFollows',
      await countOrDelete(EntityFollow, { userId: oxyUserId }, options.dryRun),
    );
    record(
      report, domain, 'notificationsByActor',
      await countOrDelete(
        Notification,
        { $or: [{ recipientId: oxyUserId }, { actorId: oxyUserId }] },
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

/**
 * A stored cursor as a Mongo `_id`, for the two phases that still page Mongo.
 *
 * The shape guard is CORRECT here and only here: `orphan-posts` and `media`
 * still read collections whose ids really are ObjectIds, and each phase has its
 * own `scope`, so a cursor from another phase can never arrive. It answers
 * `null` — "start from the beginning" — for anything else, which for an
 * idempotent resumable sweep costs a re-scan rather than a miss.
 *
 * DELETE IT when those two phases port. On a Postgres table the same guard
 * returns false for every uuid v7 and the cursor silently stops resuming, which
 * is precisely what {@link resumePoint} no longer does.
 */
function toMongoCursor(cursor: string | null): mongoose.Types.ObjectId | null {
  if (!cursor || !mongoose.isValidObjectId(cursor)) return null;
  return new mongoose.Types.ObjectId(cursor);
}

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
    const filter: Record<string, unknown> = { 'federation.actorUri': { $exists: true } };
    const after = toMongoCursor(lastId);
    if (after) filter._id = { $gt: after };

    const page = await Post.find(filter, POST_CASCADE_PROJECTION)
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .lean<PostRow[]>();
    if (page.length === 0) {
      if (lastId) await saveProgress(cursorScope(SCOPE_ORPHAN_POSTS, domains), options, lastId, scanned, issues, true);
      break;
    }

    scanned += page.length;
    const byDomain = new Map<string, PostRow[]>();
    for (const post of page) {
      const actorUri = post.federation?.actorUri;
      if (typeof actorUri !== 'string') continue;
      const host = hostOf(actorUri);
      if (host === null || !domains.has(host)) continue;
      // Phase 1 owns every post whose author is a blocked actor we hold a row
      // for. Skipping them here is what keeps `orphanPosts` meaning exactly "what
      // the actor-anchored count misses" — without it a DRY RUN, which deletes
      // nothing, would count the same post under both phases and report a blast
      // radius several times the real one to the person authorising the deletion.
      if (post.oxyUserId && blockedOwnerIds.has(post.oxyUserId)) continue;
      const bucket = byDomain.get(host);
      if (bucket) bucket.push(post);
      else byDomain.set(host, [post]);
    }

    for (const [domain, posts] of byDomain) {
      for (const batch of chunk(posts, POST_BATCH_SIZE)) {
        await purgePostBatch(batch, options, report, domain, issues, 'orphanPosts');
      }
    }

    lastId = page[page.length - 1]._id.toHexString();
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
    const filter: Record<string, unknown> = {};
    const after = toMongoCursor(lastId);
    if (after) filter._id = { $gt: after };

    const page = await FederatedMediaCache.find(filter, { _id: 1, remoteUrl: 1 })
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .lean<Array<{ _id: mongoose.Types.ObjectId; remoteUrl: string }>>();
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

    lastId = page[page.length - 1]._id.toHexString();
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
  report.corpus = {
    federatedPosts: await Post.countDocuments({ 'federation.actorUri': { $exists: true } }),
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
      [FEDERATION_DOMAIN, ACTOR_DOMAIN, OXY_IDENTITY_APEX],
      options.domain,
    );

    // BOTH stores, because this script is a genuine hybrid: posts, engagement,
    // notifications and the media cache are still Mongo, while the federation
    // anchors, the engagement counters, the ledger and the resume cursors are
    // Postgres. `closeAdminScriptResources` already closed a Postgres pool this
    // never opened, so every Postgres read here died on "PostgreSQL is not
    // connected".
    await Promise.all([connectToDatabase(), connectPostgres()]);
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
    await mongoose.disconnect();
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
