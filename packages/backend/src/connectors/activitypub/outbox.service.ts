import { observeFederationImportReason } from '../../db/federation/importProvenanceRepository';
import type { FederationImportReason } from '../../db/schema/federationImports';
import { and, eq, inArray } from 'drizzle-orm';
import {
  findPostsByFederatedObjects,
  postMatchesFederatedObjectSql,
} from '../shared/upstreamPostKey';
import { findRecordedTransportCopies } from '../../db/posts/postTransportCopyRepository';
import { logger } from '../../utils/logger';
import type { FederatedActorRecord } from '../../db/federation/actorRecord';
import {
  findActorsByUris,
  markOutboxBackfillUnavailable as markActorOutboxBackfillUnavailable,
} from '../../db/federation/actorRepository';
import { getDb } from '../../db/postgres';
import { isUniqueViolation, uuidv7 } from '@oxy.so/db';
import { posts } from '../../db/schema/posts';
import {
  CHRONO_DESC,
  linkReplyToParent,
  findPostRecords,
  insertPostRecords,
  replacePostContent,
  setFederatedAuthorPinnedPost,
} from '../../db/posts/postRepository';
import type { PostRecord, PostRecordInput } from '../../db/posts/postRecord';
import { extractActorUriFromActivityId } from '@oxy.so/federation';
import { AP_CONTENT_TYPE, isBlockedDomain } from './constants';
import { buildFederatedNoteVariants, apNoteUrl } from './apPostContent';
import {
  absorbNoteCopy,
  buildPostFromNote,
  logSkippedNote,
  type NoteAuthor,
  type NotePost,
  notePostRecord,
  storeNoteExtras,
  storeNotePost,
} from './apNotePost';
import { isBridgeFlattenedRetweet } from './flattenedRetweet';
import { resolveAnnouncedActivity } from './apRelay';
import { normalizeMentionIds } from '../../utils/textProcessing';
import { createFederatedBoost } from '../shared/federatedBoost';
import { enrichIngestedPosts } from '../../services/postEnrichment';
import { applyDetectedPrimaryTag } from '../../services/postVariants';
import { assertSafePublicUrl } from '@oxy.so/core/server';
import { actorService } from './actor.service';
import {
  asRecord,
  activityPubItems,
  activityPubLinkUrl,
  signedFetch,
  fetchActivityPubObject,
  fetchVerifiedAnnouncedNote,
  runWithTimeout,
  extractActorUri,
  extractInReplyToUri,
  parseApPublished,
  resolvePostIdFromObjectUri,
  sameOrigin,
} from './helpers';
import { getRemoteHost, isAbsoluteHttpUrl } from '../shared/url';
import {
  isApPostObjectType,
  parseOrderedCollection,
  parseOrderedCollectionPage,
  parseInboundActivity,
  parseNote,
  primaryApType,
} from './apSchemas';
import {
  applyMentionPlaceholders,
  type AuthorRefreshOptions,
  extractMentionTags,
  hasSourceMentionLink,
  resolveInboundMentionsForNotes,
  type ResolvedInboundMentions,
} from './apMentions';
import { recordRecentReplierForPost } from '../../services/PostRecentReplierService';
import { mastodonPublicStatusUris } from './mastodonPublicStatuses';
import { isOutboxMarkedUnavailable } from './outboxSyncCooldown';
import { transportHandoff } from './transportHandoff';
import {
  bridgeStatusUri,
  fetchXTimelinePage,
  isXTimelinePageUrl,
  repostActivityId,
  xTimelineHandle,
  xTimelinePageUrl,
} from './xTimeline';
import { mirrorPostTime, mirrorTransportOf } from '../../utils/federation/mirrorTransports';

/**
 * Bounded concurrency for resolving unknown actor URIs during outbox backfill.
 * Keeps remote fan-out small so we don't hammer a single instance.
 */
const OUTBOX_ACTOR_RESOLVE_CONCURRENCY = 3;

/**
 * Pages of an X account's timeline (20 items each) one sync from the top reads
 * at most (`collectXTimelineCandidates`): about a day of a prolific account.
 */
const X_TIMELINE_MAX_PAGES = 5;

/**
 * Per-actor wall-clock budget for `fetchRemoteActor` during outbox backfill.
 * `fetchRemoteActor` can chain a direct fetch + WebFinger fallback + retry
 * (each with its own request timeout), so one unresponsive remote could still
 * stall a whole resolution batch. This caps the total time spent on any single
 * actor so the batch always makes progress.
 */
const OUTBOX_ACTOR_RESOLVE_TIMEOUT_MS = 20 * 1000; // 20 seconds

/**
 * Bounded concurrency for importing boosts (Announce) during outbox backfill.
 * Each import may fetch the boosted Note from a remote instance, so this is
 * parallelized in small batches rather than run strictly sequentially.
 */
const OUTBOX_BOOST_IMPORT_CONCURRENCY = 4;

/**
 * Bounded concurrency for the existing-post @mention SELF-HEAL writes. Each heal is
 * a single `updateOne` (no network fetch — the note is already in hand and its
 * mentions were resolved in the same shared bounded pass as the new notes), so a
 * small parallel batch keeps the write burst bounded without serializing.
 */
const OUTBOX_MENTION_HEAL_CONCURRENCY = 5;

/**
 * Hard cap on how many untrusted outbox items a single page pass may inspect.
 * The candidate limit only bounds successfully imported candidates; malicious
 * pages can otherwise fill `orderedItems` with non-candidates that each trigger
 * URL resolution work. Keep this independent from the page-size advertised by
 * a remote server so backfill advances via the item-offset cursor instead of
 * spending an entire run on attacker-controlled fan-out.
 */
const OUTBOX_MAX_ITEMS_INSPECTED_PER_PAGE = 100;

/**
 * What the backfill takes from a community's outbox, which lists each post as
 * the `Announce` of its member's `Create` (`apRelay.ts`): posts only. Edits,
 * deletions and votes are the inbox's to apply as they happen, not history to
 * replay.
 */
const OUTBOX_RELAYED_TYPES: ReadonlySet<string> = new Set(['Create']);

/**
 * Hard upper bound on how far UP a federated reply chain the ancestor backfill
 * walks (and how deep the thread-root resolution recurses). Federated threads
 * are normally shallow; this cap guarantees a malformed or cyclic `inReplyTo`
 * chain can never trigger a runaway fetch/recursion loop. When the cap is hit,
 * the reply is left linked as far as we got (best-effort), never spinning.
 */
const MAX_ANCESTOR_DEPTH = 30;

/**
 * Outbox answers that showed nothing importable, after which a profile sync
 * asks the server's public statuses instead ({@link OutboxSyncService.syncProfileOutbox}):
 * an empty or itemless collection, and an outbox refused to our signed fetch.
 */
const PUBLIC_STATUSES_FALLBACK_REASONS: ReadonlySet<OutboxSyncFailureReason> = new Set([
  'no-candidates',
  'non-empty-outbox-without-items',
  'outbox-http-401',
  'outbox-http-403',
]);

/**
 * Consecutive public statuses that fail to import before a run stops: the
 * server is most likely refusing our signed object fetches, and every further
 * status would only be another refused request.
 */
const PUBLIC_STATUSES_MAX_CONSECUTIVE_FAILURES = 5;

/**
 * A candidate extracted from a remote actor's outbox during backfill.
 * Either a post — authored by the actor, or by a member of the community whose
 * outbox this is — or an Announce (boost) of another actor's object.
 */
type OutboxCandidate =
  | {
      kind: 'note';
      note: Record<string, unknown>;
      activity: Record<string, unknown>;
      activityId: string;
      /** The post's author: the outbox owner, or the member a community relayed. */
      authorUri: string;
      /** The community whose outbox relayed the post (`apRelay.ts`), if any. */
      relayedBy?: string;
    }
  | {
      kind: 'announce';
      activity: Record<string, unknown>;
      activityId: string;
      announcedUri: string;
    };

/** How far one sync pages: the candidate limit, the page budget, and where to start. */
interface OutboxPagingOptions {
  limit: number;
  maxPages: number;
  startPageUrl?: string;
  startItemOffset: number;
}

/** Where one sync's paging stopped. */
interface OutboxPagingState {
  pagesFetched: number;
  nextCursor: OutboxSyncResult['nextCursor'];
  reachedEnd: boolean;
  paginationFailed: boolean;
  pausedMidPage: boolean;
}

/** An existing post whose @mentions the in-hand note may repair. */
interface MentionHealCandidate {
  note: Record<string, unknown>;
  stored: PostRecord;
  storedMentions: string[];
}

/** A new outbox note, built and ready for the batch insert. */
interface BuiltOutboxNote {
  post: NotePost;
  activityId: string;
  record: PostRecordInput;
}

/** A note no mention was resolved for (`applyMentionPlaceholders` is then a no-op). */
const NO_MENTIONS: ResolvedInboundMentions = { ids: [], localIds: [], anchorMap: new Map() };

/** The fields of `value` that are set — so spreading them never erases another value. */
function definedFields<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined && field !== null),
  ) as Partial<T>;
}

/**
 * Typed reason describing why an outbox sync produced no posts (or only a
 * partial result). Replaces the previous ad-hoc reason strings so callers
 * (`isPermanentlyUnavailableOutboxReason`, the job scheduler, the feed
 * controller) compare against a closed, self-documenting set instead of bare
 * string literals.
 *
 * `outbox-http-${number}` is the templated HTTP-failure reason (e.g.
 * `outbox-http-404`, `outbox-http-410`, `outbox-http-503`); the HTTP status is
 * preserved so the permanently-unavailable check can key off 404/410.
 */
export type OutboxHttpFailureReason = `outbox-http-${number}`;

export type OutboxSyncFailureReason =
  | 'missing-outbox'
  | 'blocked-domain'
  | 'non-empty-outbox-without-items'
  | 'no-candidates'
  | 'pagination-failed'
  | 'invalid-collection'
  | 'exception'
  /**
   * A note's author is known but Oxy has not linked it yet. The run is not
   * stamped done, so the next one retries the note rather than paging past it.
   */
  | 'author-pending'
  /** The outbox was already marked unavailable, so a profile sync did not fetch it. */
  | 'outbox-unavailable'
  /** FxTwitter did not list an X account's timeline this run (`./xTimeline`); the next run retries. */
  | 'x-timeline-unavailable'
  | OutboxHttpFailureReason;

/**
 * Reasons that mark an outbox as permanently unavailable (do not retry / stamp
 * the actor as `unavailable`): a 404/410 on the outbox itself, or a non-empty
 * outbox that exposes no inspectable items/pages.
 */
export const PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS: ReadonlySet<OutboxSyncFailureReason> =
  new Set<OutboxSyncFailureReason>([
    'non-empty-outbox-without-items',
    'outbox-http-404',
    'outbox-http-410',
  ]);

export function isPermanentlyUnavailableOutboxReason(
  reason?: string,
): reason is OutboxSyncFailureReason {
  return (
    typeof reason === 'string' &&
    PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS.has(reason as OutboxSyncFailureReason)
  );
}

export interface OutboxSyncResult {
  syncedCount: number;
  shouldStampCooldown: boolean;
  reason?: OutboxSyncFailureReason;
  candidateCount?: number;
  newPostCount?: number;
  existingCount?: number;
  importedBoostCount?: number;
  /**
   * Existing posts whose bare-text @mentions were re-resolved and rewritten from
   * the in-hand outbox notes this run (organic self-heal of pre-mention-fix
   * imports). Zero on every page that carries no such posts.
   */
  healedMentionCount?: number;
  /** New notes held back because Oxy has not linked their author yet (`author-pending`). */
  pendingAuthorCount?: number;
  /** Posts found through the server's public statuses after the outbox showed none. */
  publicStatusesSyncedCount?: number;
  pagesFetched?: number;
  reachedEnd?: boolean;
  nextCursor?: {
    url: string;
    itemOffset: number;
  };
}

export interface OutboxSyncOptions {
  importReason?: FederationImportReason;
  limit?: number;
  maxPages?: number;
  startPageUrl?: string;
  startItemOffset?: number;
}

/** The actor fields an outbox sync reads. */
export type OutboxSyncActor = Pick<
  FederatedActorRecord,
  'outboxUrl' | 'acct' | 'uri' | 'followersUrl' | 'lastFetchedAt'
> & {
  oxyUserId?: string;
  type?: string;
  networkAcct?: string | null;
  domain?: string | null;
  username?: string;
};

function normalizeActorUriForCompare(uri: string | null | undefined): string | null {
  if (!uri || !isAbsoluteHttpUrl(uri)) return null;
  try {
    const parsed = new URL(uri);
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString();
  } catch {
    return null;
  }
}

function actorUrisMatch(actual: string | null | undefined, expected: string): boolean {
  const normalizedActual = normalizeActorUriForCompare(actual);
  const normalizedExpected = normalizeActorUriForCompare(expected);
  return Boolean(normalizedActual && normalizedExpected && normalizedActual === normalizedExpected);
}

function activityIdBelongsToActor(activityId: string, actorUri: string): boolean {
  if (!sameOrigin(activityId, actorUri)) return false;
  const derivedActorUri = extractActorUriFromActivityId(activityId);
  return !derivedActorUri || actorUrisMatch(derivedActorUri, actorUri);
}

/**
 * Outbox backfill: fetch a remote actor's outbox, extract Note/Announce
 * candidates, dedup, import new notes (raw batch insert) and boosts, and advance
 * an opaque pagination cursor. Also the dependency importer (boosted originals,
 * reply ancestors, quoted notes) every ingest path shares.
 */
export class OutboxSyncService {
  /**
   * Fetch a remote actor's outbox and store posts in the DB.
   * Uses the same storage format as handleCreate so posts go through normal hydration.
   */
  async syncOutboxPosts(
    actor: OutboxSyncActor,
    limit = 20,
    importReason: FederationImportReason = 'unknown_outbox',
  ): Promise<number> {
    const result = await this.syncOutboxPostsDetailed(actor, { limit, importReason });
    return result.syncedCount;
  }

  /**
   * Mirror the actor's pinned post: the first item of its `featured` collection
   * (Mastodon lists the most recently pinned first; Mention shows one pin). The
   * note is stored through the same verified path a boosted note takes, then
   * made the author's only pinned post. An actor with an empty collection has
   * its pin cleared; one whose collection cannot be read keeps what it had.
   */
  async syncFeaturedPost(
    actor: Pick<FederatedActorRecord, 'uri' | 'featuredUrl' | 'oxyUserId'>,
  ): Promise<void> {
    const { featuredUrl, oxyUserId } = actor;
    if (!featuredUrl || !oxyUserId || !sameOrigin(featuredUrl, actor.uri)) return;
    try {
      if (isBlockedDomain(new URL(actor.uri).hostname.toLowerCase())) return;
      const items = await this.featuredItems(featuredUrl);
      if (!items) return;
      const noteUri = items.length > 0 ? activityPubLinkUrl(items[0]) : null;
      if (items.length > 0 && !noteUri) return;
      const postId = noteUri ? await this.ensureFederatedNote(noteUri, 'requested_profile') : null;
      if (noteUri && !postId) return;
      await setFederatedAuthorPinnedPost(oxyUserId, postId);
    } catch (err) {
      logger.info('[FedSync] featured collection sync failed', { error: String(err) });
    }
  }

  /** The items of a `featured` collection (inline, or on its `first` page); null when unreadable. */
  private async featuredItems(url: string): Promise<unknown[] | null> {
    const res = await signedFetch(url, AP_CONTENT_TYPE);
    if (!res.ok) return null;
    const collection = asRecord(await res.json());
    if (!collection) return null;
    const items = activityPubItems(collection);
    if (items.length > 0 || collection.totalItems === 0) return items;
    const first = collection.first;
    if (typeof first === 'string') {
      if (!sameOrigin(first, url)) return null;
      const page = await signedFetch(first, AP_CONTENT_TYPE);
      const pageRecord = page.ok ? asRecord(await page.json()) : null;
      return pageRecord ? activityPubItems(pageRecord) : null;
    }
    const inlinePage = asRecord(first);
    return inlinePage ? activityPubItems(inlinePage) : collection.orderedItems ? [] : null;
  }

  async markOutboxBackfillUnavailable(
    actor: Pick<FederatedActorRecord, 'id' | 'outboxUrl'>,
    reason?: string,
  ): Promise<void> {
    if (!actor.outboxUrl) return;

    await markActorOutboxBackfillUnavailable(actor.id, actor.outboxUrl);
    logger.info('[FedSync] marked outbox unavailable', {
      result: reason ?? 'unknown',
    });
  }

  /**
   * The outbox sync of a profile view — the one decision both entry points
   * (`federatedProfileSync` and `GET /federation/actor/posts`) take, since a
   * profile sync exists to fill an empty profile:
   *
   *  - an outbox already marked unavailable is not fetched again, but the
   *    account's public statuses are tried ({@link syncPublicStatuses}, which
   *    keeps its own per-actor and per-host throttle — such an actor carries no
   *    cooldown stamp);
   *  - otherwise the outbox is synced, the public statuses are tried when it
   *    showed nothing importable, and an outbox found permanently unavailable is
   *    marked so. The outbox's own `reason` stands either way; a sync that found
   *    posts cools down.
   */
  async syncProfileOutbox(
    actor: OutboxSyncActor & Pick<FederatedActorRecord, 'id' | 'outboxBackfill'>,
    options: { limit: number; importReason: FederationImportReason },
  ): Promise<OutboxSyncResult> {
    if (isOutboxMarkedUnavailable(actor)) {
      const synced = await this.syncPublicStatuses(actor, options);
      return {
        syncedCount: synced,
        publicStatusesSyncedCount: synced,
        shouldStampCooldown: false,
        reason: 'outbox-unavailable',
      };
    }
    let result = await this.syncOutboxPostsDetailed(actor, options);
    if (
      result.syncedCount === 0 &&
      result.reason &&
      PUBLIC_STATUSES_FALLBACK_REASONS.has(result.reason)
    ) {
      const synced = await this.syncPublicStatuses(actor, options);
      if (synced > 0) {
        result = {
          ...result,
          syncedCount: synced,
          publicStatusesSyncedCount: synced,
          shouldStampCooldown: true,
        };
      }
    }
    if (isPermanentlyUnavailableOutboxReason(result.reason)) {
      await this.markOutboxBackfillUnavailable(actor, result.reason);
    }
    return result;
  }

  /**
   * Import the account's public statuses as its Mastodon-compatible server
   * lists them (`mastodonPublicStatuses.ts`), each through
   * {@link ensureFederatedNote} — the signed, origin-verified note path that
   * boosts and pinned posts take — so audience, authorship, media and dedup
   * stay in one place. Statuses go one at a time; the run stops at `limit`, or
   * after {@link PUBLIC_STATUSES_MAX_CONSECUTIVE_FAILURES} statuses in a row
   * that would not import. Never throws.
   *
   * @returns how many of the account's posts are stored (new or already here).
   */
  async syncPublicStatuses(
    actor: Pick<FederatedActorRecord, 'uri' | 'acct'> & { username?: string },
    options: { limit: number; importReason: FederationImportReason },
  ): Promise<number> {
    let synced = 0;
    let consecutiveFailures = 0;
    try {
      for await (const statusUri of mastodonPublicStatusUris(actor)) {
        if (await this.ensureFederatedNote(statusUri, options.importReason)) {
          synced++;
          consecutiveFailures = 0;
          if (synced >= options.limit) break;
        } else if (++consecutiveFailures >= PUBLIC_STATUSES_MAX_CONSECUTIVE_FAILURES) {
          break;
        }
      }
    } catch (err) {
      logger.warn('[FedSync] public statuses import failed', { error: String(err) });
    }
    if (synced > 0) logger.info('[FedSync] imported public statuses', { count: synced });
    return synced;
  }

  /**
   * One outbox sync, in stages: the domain policy, {@link collectOutboxCandidates}
   * (the collection and its pages, into candidates), then
   * {@link importOutboxCandidates} (dedup, authors, build, batch insert, thread
   * links, the mention self-heal, and boosts). Never throws.
   */
  async syncOutboxPostsDetailed(
    actor: OutboxSyncActor,
    limitOrOptions: number | OutboxSyncOptions = 20,
  ): Promise<OutboxSyncResult> {
    // Instance domain policy on the PULL path.
    //
    // The inbound dispatcher stops a suspended instance PUSHING to us; this stops
    // us PULLING from it. Every outbox sync — the scheduled followed-actor sweep,
    // the recent-post backfill, the profile-view refresh, and the post-Accept
    // backfill — converges here, and each of them loads its actor straight from
    // the database, so none of them passes through the resolver's policy check.
    //
    // Cooldown is deliberately NOT stamped and the reason is NOT permanently
    // unavailable: the outbox is fine, our policy refused it. Unblocking the
    // domain must resume syncing without first clearing state written while it
    // was blocked.
    let actorHost: string;
    try {
      actorHost = new URL(actor.uri).hostname.toLowerCase();
    } catch {
      // An actor URI we cannot parse has no host to check against the policy, so
      // it fails closed rather than being pulled from unchecked.
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'blocked-domain' };
    }
    if (isBlockedDomain(actorHost)) {
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'blocked-domain' };
    }
    if (!actor.outboxUrl) {
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'missing-outbox' };
    }

    const options: OutboxPagingOptions =
      typeof limitOrOptions === 'number'
        ? { limit: Math.max(1, limitOrOptions), maxPages: 10, startItemOffset: 0 }
        : {
            limit: Math.max(1, limitOrOptions.limit ?? 20),
            maxPages: Math.max(1, limitOrOptions.maxPages ?? 10),
            startPageUrl: limitOrOptions.startPageUrl,
            startItemOffset: limitOrOptions.startItemOffset ?? 0,
          };
    const importReason =
      typeof limitOrOptions === 'number'
        ? 'unknown_outbox'
        : (limitOrOptions.importReason ?? 'unknown_outbox');

    try {
      // An X account's bird.makeup outbox is always empty: its timeline is read
      // through FxTwitter instead (`./xTimeline`), and every later stage is shared.
      const xHandle = xTimelineHandle(actor.uri);
      const collected = xHandle
        ? await this.collectXTimelineCandidates(actor, actor.outboxUrl, xHandle, options)
        : await this.collectOutboxCandidates(actor.outboxUrl, actor.uri, options);
      if (collected.kind === 'failed') return collected.result;

      const { candidates, paging } = collected;
      if (candidates.length === 0) {
        logger.debug('[FedSync] no candidate notes found');
        const nonEmptyButNotInspectable =
          !options.startPageUrl &&
          !collected.inspectable &&
          typeof collected.remoteTotalItems === 'number' &&
          collected.remoteTotalItems > 0;
        const reason: OutboxSyncFailureReason = nonEmptyButNotInspectable
          ? 'non-empty-outbox-without-items'
          : 'no-candidates';
        return {
          syncedCount: 0,
          shouldStampCooldown:
            !paging.paginationFailed && !isPermanentlyUnavailableOutboxReason(reason),
          reason,
          candidateCount: 0,
          newPostCount: 0,
          existingCount: 0,
          importedBoostCount: 0,
          pagesFetched: paging.pagesFetched,
          reachedEnd: paging.reachedEnd,
          nextCursor: paging.nextCursor,
        };
      }

      const imported = await this.importOutboxCandidates(actor, candidates, importReason);
      // A run that met an author Oxy has not linked yet is not done: it is not
      // stamped, so the next sync — which starts again from the cursor the last
      // COMPLETE run left — retries the note instead of paging past it.
      const reason: OutboxSyncFailureReason | undefined = paging.paginationFailed
        ? 'pagination-failed'
        : imported.pendingAuthorCount > 0
          ? 'author-pending'
          : undefined;
      return {
        syncedCount: imported.existingCount + imported.newPostCount + imported.importedBoostCount,
        shouldStampCooldown: reason === undefined,
        reason,
        candidateCount: candidates.length,
        newPostCount: imported.newPostCount,
        existingCount: imported.existingCount,
        importedBoostCount: imported.importedBoostCount,
        healedMentionCount: imported.healedMentionCount,
        pendingAuthorCount: imported.pendingAuthorCount,
        pagesFetched: paging.pagesFetched,
        reachedEnd: paging.reachedEnd,
        nextCursor: paging.nextCursor,
      };
    } catch (err) {
      logger.warn('[FedSync] failed to sync outbox posts', err);
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'exception' };
    }
  }

  /**
   * Fetch the outbox collection and page through it into candidates, until the
   * candidate limit, a mid-page pause, the end, a failure, or the page budget.
   *
   * Every collection and page is untrusted remote JSON: its shape is validated
   * before any field is read, pages must stay on the outbox's origin, and a page
   * seen twice ends pagination. The cursor is opaque remote state: persisted as
   * given, never synthesized.
   */
  private async collectOutboxCandidates(
    outboxUrl: string,
    actorUri: string,
    options: OutboxPagingOptions,
  ): Promise<
    | { kind: 'failed'; result: OutboxSyncResult }
    | {
        kind: 'collected';
        candidates: OutboxCandidate[];
        paging: OutboxPagingState;
        /** The collection exposed inline items or a page to inspect. */
        inspectable: boolean;
        remoteTotalItems?: number;
      }
  > {
    const res = await signedFetch(outboxUrl, AP_CONTENT_TYPE);
    if (!res.ok) {
      logger.info('[FedSync] outbox fetch failed', {
        status: res.status,
        statusText: res.statusText,
      });
      return {
        kind: 'failed',
        result: { syncedCount: 0, shouldStampCooldown: false, reason: `outbox-http-${res.status}` },
      };
    }

    const rawCollection = await res.json();
    // A malformed collection aborts THIS sync gracefully; it is not a permanent
    // failure and cooldown is not stamped, so a transient bad response is
    // retried on the next view. `.loose()` keeps unknown extension fields.
    const collectionParse = parseOrderedCollection(rawCollection);
    if (!collectionParse.ok) {
      logger.warn('[FedSync] outbox collection failed validation; aborting sync', {
        error: collectionParse.error.message,
      });
      return {
        kind: 'failed',
        result: { syncedCount: 0, shouldStampCooldown: false, reason: 'invalid-collection' },
      };
    }
    const collection = rawCollection as Record<string, unknown>;
    logger.debug('[FedSync] parsed outbox collection', {
      type: collection.type,
      totalItems: collection.totalItems,
      hasOrderedItems: Boolean(collection.orderedItems),
      hasFirst: Boolean(collection.first),
    });

    const candidates: OutboxCandidate[] = [];
    const paging: OutboxPagingState = {
      pagesFetched: 0,
      nextCursor: undefined,
      reachedEnd: false,
      paginationFailed: false,
      // Set when a page is processed only partially this run — the candidate
      // limit or the per-page inspection cap stopped the scan. The cursor points
      // back at the SAME page+offset, so the run stops and hands it to the next
      // run instead of draining the (possibly attacker-controlled) page now.
      pausedMidPage: false,
    };
    const visitedPageUrls = new Set<string>();
    const failPagination = () => {
      paging.paginationFailed = true;
      paging.nextCursor = undefined;
    };

    const processPage = async (
      pageData: Record<string, unknown>,
      pageUrl: string,
      startItemOffset: number,
    ): Promise<void> => {
      const items = activityPubItems(pageData);
      const normalizedOffset = Math.max(0, Math.min(startItemOffset, items.length));
      if (items.length > 0) {
        const nextItemOffset = await this.extractCandidates(
          items,
          candidates,
          options.limit,
          pageUrl,
          actorUri,
          normalizedOffset,
        );
        if (nextItemOffset < items.length) {
          paging.nextCursor = { url: pageUrl, itemOffset: nextItemOffset };
          paging.pausedMidPage = true;
          return;
        }
      }

      const nextPageUrl = activityPubLinkUrl(pageData.next);
      if (nextPageUrl && sameOrigin(nextPageUrl, pageUrl)) {
        paging.nextCursor = { url: nextPageUrl, itemOffset: 0 };
      } else {
        paging.nextCursor = undefined;
        paging.reachedEnd = true;
      }
    };

    const fetchAndProcessPage = async (pageUrl: string, startItemOffset: number) => {
      if (!sameOrigin(pageUrl, outboxUrl)) {
        logger.info('[FedSync] rejected cross-origin outbox page');
        return failPagination();
      }
      if (visitedPageUrls.has(pageUrl)) {
        logger.info('[FedSync] outbox pagination loop detected');
        return failPagination();
      }
      visitedPageUrls.add(pageUrl);

      if (paging.pagesFetched >= options.maxPages) {
        paging.nextCursor = { url: pageUrl, itemOffset: startItemOffset };
        return;
      }

      try {
        const pageRes = await signedFetch(pageUrl, AP_CONTENT_TYPE);
        if (!pageRes.ok) {
          logger.info('[FedSync] outbox page fetch failed', { status: pageRes.status });
          return failPagination();
        }
        paging.pagesFetched++;
        const rawPage = await pageRes.json();
        const pageParse = parseOrderedCollectionPage(rawPage);
        if (!pageParse.ok) {
          logger.warn('[FedSync] outbox page failed validation; stopping pagination', {
            error: pageParse.error.message,
          });
          return failPagination();
        }
        await processPage(rawPage as Record<string, unknown>, pageUrl, startItemOffset);
      } catch (pageErr) {
        logger.debug('[FedSync] outbox pagination error', { error: pageErr });
        failPagination();
      }
    };

    const firstPageObject = asRecord(collection.first);
    const inlineItems = activityPubItems(collection);
    if (options.startPageUrl && sameOrigin(options.startPageUrl, outboxUrl)) {
      paging.nextCursor = {
        url: options.startPageUrl,
        itemOffset: Math.max(0, options.startItemOffset),
      };
    } else if (inlineItems.length > 0) {
      await processPage(collection, outboxUrl, 0);
    } else if (firstPageObject && activityPubItems(firstPageObject).length > 0) {
      await processPage(firstPageObject, activityPubLinkUrl(firstPageObject.id) ?? outboxUrl, 0);
    } else {
      const firstPageUrl =
        activityPubLinkUrl(collection.first) ?? activityPubLinkUrl(collection.next);
      if (firstPageUrl && sameOrigin(firstPageUrl, outboxUrl)) {
        paging.nextCursor = { url: firstPageUrl, itemOffset: 0 };
      }
    }

    while (
      paging.nextCursor &&
      candidates.length < options.limit &&
      !paging.reachedEnd &&
      !paging.paginationFailed &&
      !paging.pausedMidPage
    ) {
      const cursor: { url: string; itemOffset: number } = paging.nextCursor;
      await fetchAndProcessPage(cursor.url, cursor.itemOffset);
      const next = paging.nextCursor as { url: string; itemOffset: number } | undefined;
      // The page budget was reached before this cursor could be processed.
      if (next?.url === cursor.url && next.itemOffset === cursor.itemOffset) break;
    }

    logger.debug('[FedSync] collected outbox candidates', {
      candidateCount: candidates.length,
      pagesFetched: paging.pagesFetched,
    });
    return {
      kind: 'collected',
      candidates,
      paging,
      inspectable: inlineItems.length > 0 || Boolean(collection.first || collection.next),
      remoteTotalItems:
        typeof collection.totalItems === 'number' ? collection.totalItems : undefined,
    };
  }

  /**
   * The candidates of an X account's timeline as FxTwitter lists it
   * (`./xTimeline`), newest first.
   *
   * From the top (every sync but a stored backfill cursor) it pages down until a
   * page on which everything is already here, the account's handoff instant (an
   * own tweet written before it is mastox's, `./transportHandoff`), or
   * {@link X_TIMELINE_MAX_PAGES}, and takes EVERYTHING it found that is not here
   * yet, whatever the candidate limit: a run after FxTwitter or this job was down
   * for a while fills the whole gap, never only its newest end. From a stored
   * cursor (the recent backfill) it walks the history like any outbox.
   *
   * Only what is not held is fetched. An own tweet is the bridge's status URI,
   * fetched and validated by {@link extractCandidates} exactly like an outbox
   * item. A retweet is an `Announce` of the original under its minted id
   * ({@link repostActivityId}). X gives a retweet no time of its own, so its
   * boost is dated by the timeline's order: no later than the account's own
   * tweet listed just above it (now, above the first one of a run from the top)
   * and never earlier than the original. A run from a stored cursor has no such
   * bound before its first own tweet and dates those as the original.
   */
  private async collectXTimelineCandidates(
    actor: Pick<OutboxSyncActor, 'uri' | 'networkAcct'>,
    outboxUrl: string,
    handle: string,
    options: OutboxPagingOptions,
  ): Promise<
    | { kind: 'failed'; result: OutboxSyncResult }
    | {
        kind: 'collected';
        candidates: OutboxCandidate[];
        paging: OutboxPagingState;
        inspectable: boolean;
        remoteTotalItems?: number;
      }
  > {
    const fromTop = !(options.startPageUrl && isXTimelinePageUrl(options.startPageUrl, handle));
    const maxPages = fromTop ? X_TIMELINE_MAX_PAGES : options.maxPages;
    const handoff = actor.networkAcct
      ? (await transportHandoff(actor.networkAcct, 'x'))?.at
      : undefined;
    const paging: OutboxPagingState = {
      pagesFetched: 0,
      nextCursor: undefined,
      reachedEnd: false,
      paginationFailed: false,
      pausedMidPage: false,
    };
    const candidates: OutboxCandidate[] = [];
    let ceiling: Date | undefined = fromTop ? new Date() : undefined;
    let pageUrl: string | undefined = fromTop ? xTimelinePageUrl(handle) : options.startPageUrl;

    while (pageUrl) {
      if (paging.pagesFetched >= maxPages) {
        paging.nextCursor = { url: pageUrl, itemOffset: 0 };
        break;
      }
      const page = await fetchXTimelinePage(handle, pageUrl);
      if (!page) {
        if (paging.pagesFetched === 0) {
          return {
            kind: 'failed',
            result: {
              syncedCount: 0,
              shouldStampCooldown: false,
              reason: 'x-timeline-unavailable',
            },
          };
        }
        paging.paginationFailed = true;
        paging.nextCursor = undefined;
        break;
      }
      paging.pagesFetched++;
      paging.nextCursor = page.next ? { url: page.next, itemOffset: 0 } : undefined;
      paging.reachedEnd = !page.next;

      const objectUri = (entry: (typeof page.entries)[number]) =>
        entry.kind === 'post'
          ? bridgeStatusUri(handle, entry.id)
          : repostActivityId(handle, entry.id);
      const held = await findPostsByFederatedObjects(page.entries.map(objectUri));
      let lastOwnAt: Date | undefined;
      for (const entry of page.entries) {
        const uri = objectUri(entry);
        if (entry.kind === 'post') {
          const writtenAt = mirrorPostTime(uri);
          lastOwnAt = writtenAt ?? lastOwnAt;
          if (writtenAt && (!ceiling || writtenAt < ceiling)) ceiling = writtenAt;
          // Before the handoff an own tweet is mastox's; a reply never is.
          const mastoxs = !entry.reply && handoff && writtenAt && writtenAt < handoff;
          if (!held.has(uri) && !mastoxs)
            await this.extractCandidates([uri], candidates, Infinity, outboxUrl, actor.uri);
          continue;
        }
        if (held.has(uri)) continue;
        const announcedUri = bridgeStatusUri(entry.author, entry.id);
        const original = mirrorPostTime(announcedUri);
        const boostedAt = ceiling && original && ceiling > original ? ceiling : original;
        candidates.push({
          kind: 'announce',
          activityId: uri,
          announcedUri,
          activity: {
            id: uri,
            type: 'Announce',
            actor: actor.uri,
            ...(boostedAt ? { published: boostedAt.toISOString() } : {}),
            url: `https://x.com/${entry.author}/status/${entry.id}`,
          },
        });
      }
      // The page reached the handoff: everything older is mastox's or already here.
      if (fromTop && handoff && lastOwnAt && lastOwnAt < handoff) break;
      if (fromTop && held.size === page.entries.length) break;
      if (!fromTop && candidates.length >= options.limit) break;
      pageUrl = page.next;
    }

    return { kind: 'collected', candidates, paging, inspectable: true };
  }

  /**
   * Store a page's candidates: dedup against what is held, resolve the new
   * notes' authors and mentions in bounded batches, build each note through
   * {@link buildPostFromNote}, batch-insert them, link replies into their
   * threads, heal old posts' mentions, and import the boosts.
   */
  private async importOutboxCandidates(
    actor: OutboxSyncActor,
    candidates: OutboxCandidate[],
    importReason: FederationImportReason,
  ): Promise<{
    newPostCount: number;
    existingCount: number;
    importedBoostCount: number;
    healedMentionCount: number;
    pendingAuthorCount: number;
  }> {
    // A retweet a reviewed bridge flattened into a Note under the retweeter's
    // byline is no candidate at all: it is decided on the bridge's own text
    // before the page's mentions are resolved. It still counts as inspected
    // (`candidates`), so the backfill cursor moves on.
    const noteCandidates = candidates.filter(
      (c): c is Extract<OutboxCandidate, { kind: 'note' }> =>
        c.kind === 'note' && !isBridgeFlattenedRetweet(c.note, c.authorUri),
    );
    const announceCandidates = candidates.filter(
      (c): c is Extract<OutboxCandidate, { kind: 'announce' }> => c.kind === 'announce',
    );

    // One query for the whole page. The stored records also carry what the
    // mention self-heal compares against, so it needs no read of its own.
    const existing = await this.findExistingCandidates(candidates, importReason);
    const newNotes = noteCandidates.filter((c) => !existing.has(c.activityId));
    const newAnnounces = announceCandidates.filter((a) => !existing.has(a.activityId));
    const healCandidates = this.mentionHealCandidates(noteCandidates, existing);
    // Notes another transport already delivered (found by upstream key) whose
    // copy this one has not been merged from yet.
    const keyed = noteCandidates.filter(
      (c) =>
        existing.has(c.activityId) &&
        existing.get(c.activityId)?.federation?.activityId !== c.activityId,
    );
    const merged = await findRecordedTransportCopies(keyed.map((c) => c.activityId));
    const copyNotes = keyed.filter((c) => !merged.has(c.activityId));

    // Authors: the outbox owner, or the members a community relayed. The owner
    // is also the booster of every announce.
    const authorUris = new Set([...newNotes, ...copyNotes].map((c) => c.authorUri));
    if (newAnnounces.length > 0 && !actor.oxyUserId) authorUris.add(actor.uri);
    const authors = await this.resolveOutboxAuthors(actor, authorUris);

    // The mentions of the new notes AND the heal notes in ONE bounded pass: each
    // distinct mentioned actor across the page is fetched at most once, with the
    // same concurrency and per-actor timeout as the authors.
    const mentionsByNote = await resolveInboundMentionsForNotes(
      [...newNotes, ...copyNotes].map((c) => c.note).concat(healCandidates.map((h) => h.note)),
      {
        concurrency: OUTBOX_ACTOR_RESOLVE_CONCURRENCY,
        perActorTimeoutMs: OUTBOX_ACTOR_RESOLVE_TIMEOUT_MS,
      },
    );

    logger.debug('[FedSync] classified outbox candidates', {
      candidateCount: candidates.length,
      noteCount: noteCandidates.length,
      announceCount: announceCandidates.length,
      existingCount: existing.size,
      actorResolutionCount: authors.size,
    });

    const { built, pendingAuthorCount } = await this.buildOutboxNotes(
      newNotes,
      authors,
      mentionsByNote,
      importReason,
    );
    await this.insertOutboxNotes(built, importReason);
    await this.linkOutboxReplies(built);
    const healedMentionCount = await this.healExistingMentions(healCandidates, mentionsByNote);
    const copies = await this.buildOutboxNotes(copyNotes, authors, mentionsByNote, importReason);
    for (const copy of copies.built) {
      const stored = existing.get(copy.activityId);
      if (stored) await absorbNoteCopy(stored.id, copy.post);
    }

    // Boosts (Announce) by the outbox owner: each ensures the boosted note exists
    // locally, then stores a boost post like a native repost. Bounded concurrency,
    // since each may fetch the boosted note from a remote instance.
    const booster = authors.get(actor.uri);
    const boosterOxyUserId =
      actor.oxyUserId ?? (booster && booster !== 'pending' ? booster.oxyUserId : null);
    let importedBoostCount = 0;
    for (let i = 0; i < newAnnounces.length; i += OUTBOX_BOOST_IMPORT_CONCURRENCY) {
      const batch = newAnnounces.slice(i, i + OUTBOX_BOOST_IMPORT_CONCURRENCY);
      const results = await Promise.all(
        batch.map((announce) =>
          this.importAnnounce(
            announce.activity,
            announce.announcedUri,
            boosterOxyUserId,
            importReason,
          ),
        ),
      );
      importedBoostCount += results.filter(Boolean).length;
    }

    logger.debug('[FedSync] completed outbox sync', {
      insertedCount: built.length,
      importedBoostCount,
      existingCount: existing.size,
      healedMentionCount,
      pendingAuthorCount,
    });
    return {
      newPostCount: built.length,
      existingCount: existing.size,
      importedBoostCount,
      healedMentionCount,
      pendingAuthorCount,
    };
  }

  /** The stored posts this page's candidates already are, by activity id. */
  private async findExistingCandidates(
    candidates: OutboxCandidate[],
    importReason: FederationImportReason,
  ): Promise<Map<string, PostRecord>> {
    // By activity id, or by upstream key: the same post stored from another
    // transport is this candidate too.
    const matched = await findPostsByFederatedObjects(candidates.map((c) => c.activityId));
    const ids = [...new Set([...matched.values()].map((post) => post.id))];
    const stored =
      ids.length > 0 ? await findPostRecords(inArray(posts.id, ids), { orderBy: CHRONO_DESC }) : [];
    await observeFederationImportReason(
      stored.map((post) => post.id),
      importReason,
    );
    const byId = new Map(stored.map((post) => [post.id, post]));
    const byActivityId = new Map<string, PostRecord>();
    for (const [activityId, { id }] of matched) {
      const post = byId.get(id);
      if (post) byActivityId.set(activityId, post);
    }
    return byActivityId;
  }

  /**
   * Existing posts whose stored body may still show its @mentions as bare
   * `@name` text: imported before the outbox resolved mentions, and never
   * re-inserted. A post qualifies only when its in-hand note carries more
   * distinct `Mention` tags than its stored allowlist has ids.
   */
  private mentionHealCandidates(
    noteCandidates: Extract<OutboxCandidate, { kind: 'note' }>[],
    existing: Map<string, PostRecord>,
  ): MentionHealCandidate[] {
    const heal: MentionHealCandidate[] = [];
    for (const c of noteCandidates) {
      const stored = existing.get(c.activityId);
      if (!stored) continue;
      const distinctMentionHrefs = new Set(extractMentionTags(c.note).map((t) => t.href));
      if (distinctMentionHrefs.size === 0) continue;
      const storedMentions = normalizeMentionIds(stored.mentions);
      if (storedMentions.length >= distinctMentionHrefs.size) continue;
      heal.push({ note: c.note, stored, storedMentions });
    }
    return heal;
  }

  /**
   * The notes' authors as {@link NoteAuthor}s, by actor URI.
   *
   * Stored rows first (one query); an author with no row, or a row Oxy has not
   * linked, is fetched through the resolver with bounded concurrency and a
   * per-actor timeout, so one unresponsive instance cannot stall the page.
   * The outcome per author:
   *  - a {@link NoteAuthor}: linked, its notes are imported;
   *  - `'pending'`: the actor is known but Oxy has not linked it yet (Oxy was
   *    unreachable). Its notes wait: the run reports `author-pending`;
   *  - absent: the actor itself could not be fetched (gone, refused, blocked,
   *    timed out). Its notes are skipped, which is where the inbox ends up too
   *    once its retries are spent.
   */
  private async resolveOutboxAuthors(
    owner: OutboxSyncActor,
    uris: Set<string>,
  ): Promise<Map<string, NoteAuthor | 'pending'>> {
    const authors = new Map<string, NoteAuthor | 'pending'>();
    if (uris.size === 0) return authors;
    const asAuthor = (row: Omit<NoteAuthor, 'oxyUserId'>, oxyUserId: string): NoteAuthor => ({
      uri: row.uri,
      oxyUserId,
      followersUrl: row.followersUrl,
      lastFetchedAt: row.lastFetchedAt,
      type: row.type,
      domain: row.domain,
      networkAcct: row.networkAcct,
    });

    const rows = new Map((await findActorsByUris([...uris])).map((row) => [row.uri, row]));
    // The owner as the caller passed it, over its stored row: a caller may hold
    // the Oxy link before the row does.
    if (uris.has(owner.uri)) {
      const merged = { ...rows.get(owner.uri), ...definedFields(owner), uri: owner.uri };
      if (merged.oxyUserId) authors.set(owner.uri, asAuthor(merged, merged.oxyUserId));
    }
    for (const uri of uris) {
      const row = rows.get(uri);
      if (!authors.has(uri) && row?.oxyUserId) authors.set(uri, asAuthor(row, row.oxyUserId));
    }

    const missing = [...uris].filter((uri) => !authors.has(uri));
    for (let i = 0; i < missing.length; i += OUTBOX_ACTOR_RESOLVE_CONCURRENCY) {
      const batch = missing.slice(i, i + OUTBOX_ACTOR_RESOLVE_CONCURRENCY);
      const resolved = await Promise.all(
        batch.map((uri) =>
          runWithTimeout(actorService.fetchRemoteActor(uri), OUTBOX_ACTOR_RESOLVE_TIMEOUT_MS),
        ),
      );
      batch.forEach((uri, j) => {
        const actor = resolved[j];
        if (!actor) return;
        authors.set(
          uri,
          actor.oxyUserId ? asAuthor({ ...actor, uri }, actor.oxyUserId) : 'pending',
        );
      });
    }
    return authors;
  }

  /** Build each new note's row; a note whose author is pending is counted, not built. */
  private async buildOutboxNotes(
    notes: Extract<OutboxCandidate, { kind: 'note' }>[],
    authors: Map<string, NoteAuthor | 'pending'>,
    mentionsByNote: Map<Record<string, unknown>, ResolvedInboundMentions>,
    importReason: FederationImportReason,
  ): Promise<{ built: BuiltOutboxNote[]; pendingAuthorCount: number }> {
    const built: BuiltOutboxNote[] = [];
    let pendingAuthorCount = 0;
    // An author is re-read at most once per page when its row lacks a followers
    // collection (`resolveApAudienceFor`).
    const audienceRefreshes: AuthorRefreshOptions['refreshes'] = new Map();
    for (const { note, activity, activityId, authorUri, relayedBy } of notes) {
      const author = authors.get(authorUri);
      if (author === 'pending') {
        pendingAuthorCount++;
        continue;
      }
      if (!author) {
        logger.info('[FedSync] skipped outbox note whose author could not be fetched');
        continue;
      }
      const post = await buildPostFromNote({
        note,
        activity,
        activityId,
        author,
        importReason,
        ingestPath: 'outbox',
        relayedBy,
        mentions: mentionsByNote.get(note) ?? NO_MENTIONS,
        audienceRefreshes,
        importQuoted: (uri) => this.ensureQuotedNote(uri),
      });
      if (post.skip) {
        logSkippedNote('outbox', post);
        continue;
      }
      // A pre-assigned id, so the post-insert passes address each row directly.
      built.push({ post, activityId, record: await notePostRecord(post, uuidv7()) });
    }
    return { built, pendingAuthorCount };
  }

  /**
   * Batch-insert the built rows, then enrich them and store their cards and
   * polls — for the INSERTED rows only: a row that lost the unique race on
   * `federation.activity_id` belongs to whichever task stored it.
   *
   * Per-row transactions (`insertPostRecords`), so a duplicate rolls back only
   * its own post; a unique violation is the expected outcome of a concurrent
   * import and is counted, not logged as a failure. The batch form rather than
   * `insertPostRecord` per row, which took the whole connection pool (#1158).
   */
  private async insertOutboxNotes(
    built: BuiltOutboxNote[],
    importReason: FederationImportReason,
  ): Promise<void> {
    if (built.length === 0) return;
    const records = built.map((b) => b.record);
    const results = await insertPostRecords(records);

    // A different ingest path can win after the dedupe read. Its original cause
    // stays intact; this path still observed a later need.
    const racedActivityIds = results.flatMap((result, index) => {
      const activityId = records[index]?.federation?.activityId;
      return result.status === 'rejected' && isUniqueViolation(result.reason) && activityId
        ? [activityId]
        : [];
    });
    if (racedActivityIds.length > 0) {
      const racedPosts = await findPostsByFederatedObjects(racedActivityIds);
      await observeFederationImportReason(
        [...racedPosts.values()].map((post) => post.id),
        importReason,
      );
    }

    const inserted = results.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const unexpected = results.flatMap((result) =>
      result.status === 'rejected' && !isUniqueViolation(result.reason) ? [result.reason] : [],
    );
    if (unexpected.length > 0) {
      logger.warn('[FedSync] batch insert encountered unexpected errors', {
        count: unexpected.length,
        errors: unexpected.map((error) => (error instanceof Error ? error.message : String(error))),
      });
    }
    const rejected = results.filter((result) => result.status === 'rejected').length;
    if (rejected > 0 && rejected < records.length) {
      logger.debug('[FedSync] batch insert partially succeeded', {
        errorCount: rejected,
        insertedCount: records.length - rejected,
      });
    } else if (rejected === records.length && unexpected.length > 0) {
      throw unexpected[0];
    }

    // The one post-ingest enrichment entry point the native route also uses
    // (`services/postEnrichment/`), passed the page so a link shared by several
    // notes is resolved once.
    enrichIngestedPosts(inserted);
    const byId = new Map(built.map((b) => [b.record.id, b.post]));
    for (const post of inserted) {
      const note = byId.get(post.id);
      if (note) await storeNoteExtras(post.id, note);
    }
  }

  /**
   * Link the page's replies into their threads, AFTER the insert: a self-thread
   * whose root and replies arrive together resolves against the inserted
   * parents, and a parent outside the page is backfilled (bounded) first.
   * {@link resolveThreadLink} walks up to the ROOT, so every reply in a chain
   * shares one `threadId` whatever the insert order.
   */
  private async linkOutboxReplies(built: BuiltOutboxNote[]): Promise<void> {
    for (const { post, activityId } of built) {
      if (!post.inReplyToUri) continue;
      try {
        const link = await this.resolveThreadLink(post.inReplyToUri, 0, true);
        if (!link) continue;
        // `is_reply` was stamped at insert from `federation.inReplyTo`; this
        // pass only attaches the links.
        const linked = await linkReplyToParent(eq(posts.federationActivityId, activityId), link);
        if (linked) {
          await recordRecentReplierForPost({
            parentPostId: link.parentPostId,
            oxyUserId: post.params.oxyUserId,
            visibility: post.audience.visibility,
            status: 'published',
            createdAt: post.params.createdAt,
          });
        }
      } catch (linkErr) {
        const message = linkErr instanceof Error ? linkErr.message : String(linkErr);
        logger.warn('[FedSync] failed to link federated reply into its thread', {
          error: message,
        });
      }
    }
  }

  /**
   * Organic self-heal of the @mentions of EXISTING federated posts whose stored
   * body still shows its mentions as bare `@name` text — posts imported before the
   * outbox path resolved mentions, which the dedup pass never re-inserts (so they
   * would keep dead-text mentions forever). The in-hand outbox notes already carry
   * the `Mention` tags, so each post is repaired with NO extra fetch beyond the
   * bounded, shared mention resolution already performed for the page, and the
   * stored record comes from the page's dedup read.
   *
   * Bounded batch of `updateOne`s. Idempotent + fail-soft: a note whose mentions
   * add neither an identity nor a restored source link are a no-op. A restored
   * source link is compared with the stored body to avoid repeated rewrites. Historical posts
   * are NEITHER re-notified NOR re-federated: this is a pure content-heal.
   *
   * @returns the number of posts actually rewritten this run.
   */
  private async healExistingMentions(
    healCandidates: MentionHealCandidate[],
    mentionsByNote: Map<Record<string, unknown>, ResolvedInboundMentions>,
  ): Promise<number> {
    if (healCandidates.length === 0) return 0;

    let healed = 0;
    for (let i = 0; i < healCandidates.length; i += OUTBOX_MENTION_HEAL_CONCURRENCY) {
      const batch = healCandidates.slice(i, i + OUTBOX_MENTION_HEAL_CONCURRENCY);
      const results = await Promise.all(
        batch.map((candidate) => this.healOnePostMentions(candidate, mentionsByNote)),
      );
      healed += results.filter(Boolean).length;
    }
    return healed;
  }

  /**
   * Repair ONE existing post's @mentions from its in-hand note. Returns true only
   * when the post was actually rewritten. Guards on "unresolved" so a post whose
   * mentions are already resolved is never touched (see {@link healExistingMentions}).
   */
  private async healOnePostMentions(
    candidate: MentionHealCandidate,
    mentionsByNote: Map<Record<string, unknown>, ResolvedInboundMentions>,
  ): Promise<boolean> {
    const resolved = mentionsByNote.get(candidate.note);
    // No resolution result means this note was not processed.
    if (!resolved) return false;

    // Resolved identities and preserved source links can each repair dead text.
    // The latter is compared with the stored body below.
    const storedSet = new Set(candidate.storedMentions);
    const addsIdentity = resolved.ids.some((id) => !storedSet.has(id));

    // Rewrite the in-hand note's mention anchors to `[mention:<id>]` placeholders,
    // then re-derive ONLY the body variants (NO media I/O) and `$set` them alongside the mention allowlist,
    // keeping the stored body and `mentions` in lockstep exactly like the inbox
    // Update path — without re-materializing media or re-fetching anything.
    const noteObject = applyMentionPlaceholders(candidate.note, resolved.anchorMap);
    const variants = await buildFederatedNoteVariants(noteObject);
    // A note that re-derives to an empty body (media-only / CW-only) must never
    // blank an existing post's body — leave it untouched.
    if (variants.length === 0) return false;

    // The record the page's dedup read already loaded; no second read per post.
    const { stored } = candidate;
    // An unresolved source mention can now retain its href without adding an
    // identity. Repair it once, then compare bodies to keep later syncs inert.
    const repairsSourceLink = variants.some(
      (variant, index) =>
        variant.text !== stored.content.variants?.[index]?.text &&
        hasSourceMentionLink(variant.text),
    );
    if (!addsIdentity && !repairsSourceLink) return false;
    // Re-derived from the note, the primary carries the origin's declared tag
    // again; keep the language the post was classified under.
    const reconciled = applyDetectedPrimaryTag(
      variants,
      stored.postClassification?.languages?.[0] ?? stored.language,
    );
    await replacePostContent(stored.id, { ...stored.content, variants: reconciled }, [
      ...new Set([...candidate.storedMentions, ...resolved.ids]),
    ]);
    return true;
  }

  /**
   * Extract candidate items from outbox items into the candidates array.
   *
   * Two kinds of candidates are produced:
   *  - `note`: a top-level Note/Article authored by this actor (Create/Note/Article).
   *  - `announce`: an Announce (boost/reblog) of another actor's object. The
   *    announced object is fetched and imported later in `syncOutboxPosts`, then
   *    a boost Post (mirroring native reposts) is created attributed to this actor.
   */
  private async extractCandidates(
    items: unknown[],
    candidates: OutboxCandidate[],
    limit: number,
    sourcePageUrl: string,
    expectedActorUri: string,
    startIndex = 0,
  ): Promise<number> {
    const maxIndexExclusive = Math.min(
      items.length,
      startIndex + OUTBOX_MAX_ITEMS_INSPECTED_PER_PAGE,
    );
    for (let index = startIndex; index < maxIndexExclusive; index++) {
      if (candidates.length >= limit) return index;

      const activity = await this.resolveOutboxActivity(items[index], sourcePageUrl);
      if (!activity) continue;

      // Each outbox item is untrusted remote JSON: it is either a wrapping
      // activity (Create/Announce/...) OR a bare Note/Article. Validate the
      // resolved record with zod before extracting anything — accept it if it
      // parses as a known inbound activity OR as a content object. One malformed
      // item is SKIPPED (debug log) and the rest of the backfill continues, so a
      // single bad post never aborts the whole sync. The validated activity is
      // still read via its raw shape below to keep all existing field access
      // (and `.loose()` extension passthrough) identical.
      const activityValid = parseInboundActivity(activity).ok || parseNote(activity).ok;
      if (!activityValid) {
        logger.debug('[FedSync] skipped malformed outbox item', {
          itemIndex: index,
          result: 'activity-or-note-validation-failed',
        });
        continue;
      }

      // Announce — a boost, whose object is imported later, or a community
      // relaying a member's post (`apRelay.ts`). Raw `===` on `type` preserves
      // the prior behavior exactly (array-typed `type` values were already not
      // matched here).
      if (activity.type === 'Announce') {
        const activityId = typeof activity.id === 'string' ? activity.id : '';
        if (!activityId) continue;
        if (!actorUrisMatch(extractActorUri(activity.actor), expectedActorUri)) continue;
        if (!activityIdBelongsToActor(activityId, expectedActorUri)) continue;
        const announced = await resolveAnnouncedActivity(
          activity,
          expectedActorUri,
          OUTBOX_RELAYED_TYPES,
        );
        if (announced.kind === 'object') {
          candidates.push({
            kind: 'announce',
            activity,
            activityId,
            announcedUri: announced.objectUri,
          });
          continue;
        }
        if (announced.kind !== 'activity') continue;
        // A relayed `Create`, verified: its post is the member's.
        const relayedNote = asRecord(announced.activity.object);
        if (!relayedNote || !parseNote(relayedNote).ok || !isApPostObjectType(relayedNote.type)) {
          continue;
        }
        const noteId = typeof relayedNote.id === 'string' ? relayedNote.id : '';
        if (!noteId) continue;
        candidates.push({
          kind: 'note',
          note: relayedNote,
          activity: announced.activity,
          activityId: noteId,
          authorUri: announced.actorUri,
          relayedBy: expectedActorUri,
        });
        continue;
      }

      const note = await this.extractOutboxNote(activity, sourcePageUrl);
      if (!note) continue;
      // The note may have been FETCHED from a remote URL (Create with a string
      // `object`), so it is independently untrusted — validate it too. A
      // malformed note is skipped, never trusted.
      if (!parseNote(note).ok) {
        logger.debug('[FedSync] skipped malformed outbox note', {
          result: 'note-validation-failed',
        });
        continue;
      }
      if (!isApPostObjectType(note.type)) continue;
      // Replies are NOT skipped: an actor's outbox is their OWN content, so their
      // self-thread continuations (and replies to others) are imported and linked
      // into threads by the post-insert linking pass. The `attributedTo` /
      // `activityIdBelongsToActor` guards below still ensure only the actor's own
      // notes become candidates.

      const noteId = typeof note.id === 'string' ? note.id : '';
      const activityId = noteId || (typeof activity.id === 'string' ? activity.id : '');
      if (!activityId) continue;

      const attributedTo = extractActorUri(note.attributedTo);
      if (!actorUrisMatch(attributedTo, expectedActorUri)) continue;
      if (
        activity.type === 'Create' &&
        !actorUrisMatch(extractActorUri(activity.actor), expectedActorUri)
      )
        continue;
      if (!activityIdBelongsToActor(activityId, expectedActorUri)) continue;

      candidates.push({ kind: 'note', note, activity, activityId, authorUri: expectedActorUri });
    }

    return maxIndexExclusive;
  }

  private async resolveOutboxActivity(
    item: unknown,
    sourcePageUrl: string,
  ): Promise<Record<string, unknown> | null> {
    const inlineActivity = asRecord(item);
    if (inlineActivity) return inlineActivity;

    if (typeof item !== 'string' || !sameOrigin(item, sourcePageUrl)) return null;
    return fetchActivityPubObject(item);
  }

  private async extractOutboxNote(
    activity: Record<string, unknown>,
    sourcePageUrl: string,
  ): Promise<Record<string, unknown> | null> {
    if (isApPostObjectType(activity.type)) return activity;
    if (activity.type !== 'Create') return null;

    const inlineObject = asRecord(activity.object);
    if (inlineObject) return inlineObject;

    if (typeof activity.object === 'string' && sameOrigin(activity.object, sourcePageUrl)) {
      return fetchActivityPubObject(activity.object);
    }

    return null;
  }

  /**
   * Import a boost (Announce). Ensures the announced Note exists locally as a
   * Post, then creates a boost Post attributed to the booster — mirroring the
   * native repost shape (`type: 'boost'`, `boostOf: <local note _id>`,
   * `oxyUserId: <booster>`). Idempotent: deduped by the Announce activity id via
   * the `federation.activityId` unique sparse index. Storing the boost and
   * moving the counters is the network-neutral {@link createFederatedBoost}.
   *
   * @param announceActivity the full Announce activity (for `published`).
   * @param announcedUri the URI of the announced (boosted) object.
   * @param boosterOxyUserId the booster's resolved Oxy user id. Must be non-null:
   *   federated boosts are only ever recorded against a real, listable user.
   * @returns true when a new boost Post was created.
   */
  async importAnnounce(
    announceActivity: Record<string, unknown>,
    announcedUri: string,
    boosterOxyUserId: string | null,
    importReason: FederationImportReason = 'inbox_announce',
  ): Promise<boolean> {
    const announceId = typeof announceActivity.id === 'string' ? announceActivity.id : undefined;
    if (!announceId) return false;

    // A boost must be backed by a real, listable user. Without a resolved
    // booster we neither create a record nor move the counter.
    if (!boosterOxyUserId) {
      logger.info('[FedSync] skipped boost from unresolved actor');
      return false;
    }

    // Dedup the boost itself by the Announce activity id, or by the repost it
    // names upstream (a Bridgy Fed Announce of a repost already read natively).
    const [existingBoost] = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(postMatchesFederatedObjectSql(announceId))
      .limit(1);
    if (existingBoost) {
      await observeFederationImportReason([existingBoost.id], importReason);
      return false;
    }

    // Resolve the boosted post's local _id. A local or already-imported post is
    // resolved directly; otherwise fetch and store the remote Note. This also
    // lets remote actors boost OUR posts (announcedUri = our AP note URI).
    const originalPostId =
      (await resolvePostIdFromObjectUri(announcedUri)) ??
      (await this.ensureFederatedNote(announcedUri, 'boost_dependency'));
    if (!originalPostId) {
      logger.info('[FedSync] skipped boost whose object could not be resolved');
      return false;
    }

    // A keyed mirror's account (an X account on bird.makeup) boosts a post once:
    // X has one retweet per account and tweet. Its retweet reaches us as the
    // bridge's Announce, under an id the bridge mints at crawl time, and from the
    // account's timeline under ours (`./xTimeline`), so the ids never meet; the
    // boost the account already holds of this original is the same retweet.
    const boosterUri = extractActorUri(announceActivity.actor);
    if (boosterUri && mirrorTransportOf(getRemoteHost(boosterUri) ?? '')?.keyed) {
      const [held] = await getDb()
        .select({ id: posts.id })
        .from(posts)
        .where(
          and(
            eq(posts.boostOf, originalPostId),
            eq(posts.oxyUserId, boosterOxyUserId),
            eq(posts.type, 'boost'),
          ),
        )
        .limit(1);
      if (held) {
        await observeFederationImportReason([held.id], importReason);
        return false;
      }
    }

    // The boost Post's date reflects when the BOOST happened (the Announce's
    // `published`), while the embedded original keeps its own date via its own
    // post — matching the native repost shape. Validated/falls back to now.
    return createFederatedBoost({
      activityId: announceId,
      originalPostId,
      boosterOxyUserId,
      importReason,
      actorUri: boosterUri,
      url: apNoteUrl(announceActivity.url) ?? announceId,
      createdAt: parseApPublished(announceActivity.published),
    });
  }

  /**
   * Public entry point for resolving a federated reply's `inReplyTo` URI to its
   * local thread-linking fields (`parentPostId` + thread-root `threadId`), used
   * by the inbox `handleCreate` path and the reconciliation script.
   *
   * Delegates to {@link resolveThreadLink} at depth 0. Pass
   * `{ allowBackfill: false }` to resolve ONLY against posts already present
   * locally (no network fetch / no ancestor import) — used by the reconciliation
   * script's dry-run and its default local-only mode.
   */
  async ensureFederatedReplyLink(
    inReplyToUri: string,
    options: { allowBackfill?: boolean } = {},
  ): Promise<{ parentPostId: string; threadId: string } | null> {
    return this.resolveThreadLink(inReplyToUri, 0, options.allowBackfill ?? true);
  }

  /**
   * Resolve an AP `inReplyTo` URI to a federated reply's local thread-linking
   * fields: the parent Post `_id` (`parentPostId`) and the thread-ROOT id
   * (`threadId`).
   *
   * `threadId` mirrors the NATIVE reply rule (`threadId = parent.threadId ??
   * parent._id`): a parent that is already linked carries the root in its
   * `threadId`; an as-yet-unlinked federated parent (e.g. a sibling inserted in
   * the same outbox batch, or a pre-fix orphan) is walked UP via its stored
   * `federation.inReplyTo` so every reply in the chain ends up with the SAME
   * root `threadId` regardless of import order.
   *
   * Bounded ancestor backfill: when the parent is NOT present locally and
   * `allowBackfill` is true, the parent Note is fetched + imported via
   * {@link ensureFederatedNote} (signed, SSRF-safe, deduped by
   * `federation.activityId` so an ancestor is never re-fetched), then
   * re-resolved. The whole walk/backfill is hard-capped at
   * {@link MAX_ANCESTOR_DEPTH} so a cyclic/malformed chain can never loop; on the
   * cap, any fetch failure, or an unresolvable parent it returns null (best
   * effort — the reply is simply left unlinked rather than spinning).
   */
  private async resolveThreadLink(
    inReplyToUri: string,
    depth: number,
    allowBackfill: boolean,
  ): Promise<{ parentPostId: string; threadId: string } | null> {
    // 1. Parent already present locally (a local post OR an imported federated post)?
    let parentPostId = await resolvePostIdFromObjectUri(inReplyToUri);

    // 2. Missing parent → bounded backfill of the ancestor, then re-resolve.
    if (!parentPostId) {
      if (!allowBackfill) return null;
      if (depth >= MAX_ANCESTOR_DEPTH) {
        logger.warn('[FedSync] ancestor backfill depth cap reached; leaving reply unlinked', {
          maxDepth: MAX_ANCESTOR_DEPTH,
        });
        return null;
      }
      parentPostId = await this.ensureFederatedNote(inReplyToUri, 'reply_dependency', depth + 1);
      if (!parentPostId) return null;
    }

    // 3. Derive the thread-root id. A linked parent already points at the root;
    //    an unlinked federated parent is walked up via its stored inReplyTo.
    // Only the two columns the walk reads — not the whole record, which is a
    // read of every child table per ancestor.
    const [parent] = await getDb()
      .select({ id: posts.id, threadId: posts.threadId, inReplyTo: posts.federationInReplyTo })
      .from(posts)
      .where(eq(posts.id, parentPostId))
      .limit(1);
    if (!parent) return null;

    if (parent.threadId) {
      return { parentPostId: parent.id, threadId: parent.threadId };
    }

    const parentInReplyToUri = extractInReplyToUri(parent.inReplyTo);
    if (parentInReplyToUri && depth < MAX_ANCESTOR_DEPTH) {
      const ancestorLink = await this.resolveThreadLink(
        parentInReplyToUri,
        depth + 1,
        allowBackfill,
      );
      if (ancestorLink) {
        return { parentPostId: parent.id, threadId: ancestorLink.threadId };
      }
    }

    // Parent has no resolvable ancestor → it IS the thread root.
    return { parentPostId: parent.id, threadId: parent.id };
  }

  /**
   * Import the post a Note QUOTES, when we do not already hold it.
   *
   * The quote URI is read from the standard AP surfaces and has been for a while
   * — what was missing is that nothing ever FETCHED the quoted post. A quote of
   * anything we had not already ingested silently lost its link, and the code
   * said it would "link on a later pass once the original is ingested" while
   * nothing existed to ingest it. Measured on a real post: three fields
   * (`quote`, `quoteUri`, `_misskey_quote`) all naming
   * `https://mastodon.social/users/lemonde/statuses/117030664429761672`, and the
   * post rendered with no quote at all.
   *
   * Deliberately the SAME machinery a boost and a reply ancestor use — signed
   * fetch, SSRF-safe, deduped by `federation.activityId`, depth-capped — rather
   * than a second import path that could drift from it. Fail-soft: any failure
   * returns null and the quoting post is stored unlinked, exactly as today.
   */
  async ensureQuotedNote(objectUri: string): Promise<string | null> {
    return this.ensureFederatedNote(objectUri, 'quote_dependency');
  }

  /**
   * Ensure a federated post (`AP_POST_OBJECT_TYPES`) exists locally as a Post
   * and return its local Post `_id` (as a string). Fetches the object via
   * `signedFetch` when it is not already stored. Returns null when the object
   * cannot be fetched or is not a post.
   *
   * Used by boost import so a boost's `boostOf` always references a real local
   * Post `_id`, exactly like native reposts (which the hydration layer resolves
   * by looking the original post up by `_id`). Also used as the ancestor-backfill
   * step of {@link resolveThreadLink}: when the fetched note is itself a reply,
   * its own `parentPostId`/`threadId` are resolved (recursing up the chain, with
   * the depth budget threaded through) so the imported ancestor is fully linked.
   */
  private async ensureFederatedNote(
    objectUri: string,
    importReason: FederationImportReason,
    depth = 0,
  ): Promise<string | null> {
    // Already stored? (Its own activity id, or the same Instagram post from the Graph API.)
    const [existing] = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(postMatchesFederatedObjectSql(objectUri))
      .limit(1);
    if (existing) {
      await observeFederationImportReason([existing.id], importReason);
      return existing.id;
    }

    const objectGuard = await assertSafePublicUrl(objectUri);
    if (!objectGuard.ok) {
      logger.info('[FedSync] rejected unsafe boosted object URL', {
        result: objectGuard.reason,
      });
      return null;
    }

    // Fetch the announced object (the boosted Note) from its origin.
    const fetched = await fetchVerifiedAnnouncedNote(objectUri);
    if (!fetched) return null;
    const { note } = fetched;

    if (!note || !isApPostObjectType(note.type)) {
      logger.info('[FedSync] skipped unsupported boosted object', {
        type: primaryApType(note?.type),
      });
      return null;
    }

    // The author's actor, linked to Oxy. Unlike the inbox, a dependency is not
    // retried: it is imported best-effort from an inbox job, an outbox page or a
    // repair, whose own post is stored either way (unlinked, or withheld as
    // `incomplete` for a quote), so an author not resolvable yet returns null.
    const authorUri = extractActorUri(note.attributedTo);
    if (!authorUri) {
      logger.info('[FedSync] skipped boosted object without an attributable author');
      return null;
    }
    const authorActor = await actorService.getOrFetchActor(authorUri);
    if (!authorActor?.oxyUserId) {
      logger.info('[FedSync] skipped boosted object whose author is unresolved');
      return null;
    }

    const noteActivityId = typeof note.id === 'string' ? note.id : objectUri;
    const post = await buildPostFromNote({
      note,
      activityId: noteActivityId,
      author: { ...authorActor, uri: authorUri, oxyUserId: authorActor.oxyUserId },
      importReason,
      ingestPath: 'dependency',
      // Imported through THIS function, so a quote chain shares the ancestor
      // walk's depth budget and a quote cycle (A quotes B quotes A) terminates.
      importQuoted: (uri) =>
        depth < MAX_ANCESTOR_DEPTH
          ? this.ensureFederatedNote(uri, 'quote_dependency', depth + 1)
          : Promise.resolve(null),
    });
    if (post.skip) {
      logSkippedNote('dependency', post);
      return null;
    }

    // A note that is itself a reply is linked into its thread, resolving its own
    // parent chain up to the root within the same depth budget.
    const threadLink = post.inReplyToUri
      ? await this.resolveThreadLink(post.inReplyToUri, depth, true)
      : null;

    try {
      const created = await storeNotePost(post, {
        parentPostId: threadLink?.parentPostId,
        threadId: threadLink?.threadId,
      });
      return created.id;
    } catch (err) {
      // Concurrent import may have created it — re-read to return the id.
      if (isUniqueViolation(err)) {
        const [raced] = await getDb()
          .select({ id: posts.id })
          .from(posts)
          .where(postMatchesFederatedObjectSql(noteActivityId))
          .limit(1);
        if (raced) await observeFederationImportReason([raced.id], importReason);
        return raced ? raced.id : null;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[FedSync] failed to store boosted note', {
        error: message,
      });
      return null;
    }
  }
}

export const outboxSyncService = new OutboxSyncService();
export default outboxSyncService;
