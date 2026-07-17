import { logger } from '../../utils/logger';
import FederatedActor, { IFederatedActor } from '../../models/FederatedActor';
import { Post } from '../../models/Post';
import {
  FEDERATION_MAX_CONTENT_LENGTH,
  AP_CONTENT_TYPE,
  extractActorUriFromActivityId,
} from './constants';
import { PostVisibility } from '@mention/shared-types';
import { extractApLanguage, extractApLanguages } from './apLanguage';
import { buildFederatedNoteContent } from './apPostContent';
import { getPostCreator } from '../../services/serviceRegistry';
import { baselineContentClassifier } from '../../services/BaselineContentClassifier';
import {
  SPAM_QUALITY_CONFIG,
  toClassificationScores,
} from '../../services/contentClassification/spamQuality';
import type { PostClassificationScores } from '@mention/shared-types';
import { POST_CLASSIFICATION_PENDING } from '../../models/Post';
import { assertSafePublicUrl } from '../../utils/ssrfGuard';
import { actorService } from './actor.service';
import {
  asRecord,
  activityPubItems,
  activityPubLinkUrl,
  signedFetch,
  fetchActivityPubObject,
  fetchVerifiedAnnouncedNote,
  runWithTimeout,
  isDuplicateKeyError,
  extractAnnouncedObjectUri,
  extractActorUri,
  extractInReplyToUri,
  mapApVisibility,
  parseApPublished,
  resolvePostIdFromObjectUri,
} from './helpers';
import { isAbsoluteHttpUrl, getRemoteHost } from '../shared/url';
import { materializeFederatedMedia } from '../shared/federatedMedia';
import { buildAuthorship } from '../../utils/postAuthorship';
import {
  parseOrderedCollection,
  parseOrderedCollectionPage,
  parseInboundActivity,
  parseNote,
} from './apSchemas';
import {
  applyMentionPlaceholders,
  resolveInboundMentionsForNotes,
  type ResolvedInboundMentions,
} from './apMentions';

/**
 * Bounded concurrency for resolving unknown actor URIs during outbox backfill.
 * Keeps remote fan-out small so we don't hammer a single instance.
 */
const OUTBOX_ACTOR_RESOLVE_CONCURRENCY = 3;

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
 * Hard cap on how many untrusted outbox items a single page pass may inspect.
 * The candidate limit only bounds successfully imported candidates; malicious
 * pages can otherwise fill `orderedItems` with non-candidates that each trigger
 * URL resolution work. Keep this independent from the page-size advertised by
 * a remote server so backfill advances via the item-offset cursor instead of
 * spending an entire run on attacker-controlled fan-out.
 */
const OUTBOX_MAX_ITEMS_INSPECTED_PER_PAGE = 100;

/**
 * Hard upper bound on how far UP a federated reply chain the ancestor backfill
 * walks (and how deep the thread-root resolution recurses). Federated threads
 * are normally shallow; this cap guarantees a malformed or cyclic `inReplyTo`
 * chain can never trigger a runaway fetch/recursion loop. When the cap is hit,
 * the reply is left linked as far as we got (best-effort), never spinning.
 */
const MAX_ANCESTOR_DEPTH = 30;

/**
 * A candidate extracted from a remote actor's outbox during backfill.
 * Either a top-level Note/Article authored by the actor, or an Announce (boost)
 * of another actor's object.
 */
type OutboxCandidate =
  | { kind: 'note'; note: Record<string, any>; activity: Record<string, any>; activityId: string }
  | { kind: 'announce'; activity: Record<string, any>; activityId: string; announcedUri: string };

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
  | 'non-empty-outbox-without-items'
  | 'no-candidates'
  | 'pagination-failed'
  | 'invalid-collection'
  | 'exception'
  | OutboxHttpFailureReason;

/**
 * Reasons that mark an outbox as permanently unavailable (do not retry / stamp
 * the actor as `unavailable`): a 404/410 on the outbox itself, or a non-empty
 * outbox that exposes no inspectable items/pages.
 */
export const PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS: ReadonlySet<OutboxSyncFailureReason> = new Set<OutboxSyncFailureReason>([
  'non-empty-outbox-without-items',
  'outbox-http-404',
  'outbox-http-410',
]);

export function isPermanentlyUnavailableOutboxReason(reason?: string): reason is OutboxSyncFailureReason {
  return typeof reason === 'string'
    && PERMANENTLY_UNAVAILABLE_OUTBOX_REASONS.has(reason as OutboxSyncFailureReason);
}

export interface OutboxSyncResult {
  syncedCount: number;
  shouldStampCooldown: boolean;
  reason?: OutboxSyncFailureReason;
  candidateCount?: number;
  newPostCount?: number;
  existingCount?: number;
  importedBoostCount?: number;
  pagesFetched?: number;
  reachedEnd?: boolean;
  nextCursor?: {
    url: string;
    itemOffset: number;
  };
}

export interface OutboxSyncOptions {
  limit?: number;
  maxPages?: number;
  startPageUrl?: string;
  startItemOffset?: number;
}

/**
 * Outbox backfill: fetch a remote actor's outbox, extract Note/Announce
 * candidates, dedup, import new notes (raw insertMany) and boosts, and advance
 * an opaque pagination cursor.
 *
 * Extracted verbatim from the former monolithic FederationService — same behavior,
 * same signatures. Depends on ActorService (actor resolution), the shared
 * low-level helpers, and the registered PostCreator. Registers itself as the
 * BoostImporter so InboxProcessingService can reuse `importAnnounce` without a
 * load-order cycle.
 */
/**
 * The classification subdoc seeded onto a raw-inserted federated post. Mirrors
 * the schema's `pending` default plus the Stage-A deterministic fields. `status`
 * stays `pending` so the async AI batch still enriches the post.
 */
function isSameOriginHttpUrl(value: string, sourceUrl: string): boolean {
  if (!isAbsoluteHttpUrl(value) || !isAbsoluteHttpUrl(sourceUrl)) return false;
  try {
    return new URL(value).origin === new URL(sourceUrl).origin;
  } catch {
    return false;
  }
}


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
  if (!isAbsoluteHttpUrl(activityId)) return false;

  try {
    const activityUrl = new URL(activityId);
    const actorUrl = new URL(actorUri);
    if (activityUrl.origin !== actorUrl.origin) return false;
  } catch {
    return false;
  }

  const derivedActorUri = extractActorUriFromActivityId(activityId);
  return !derivedActorUri || actorUrisMatch(derivedActorUri, actorUri);
}

interface RawPostClassificationSeed {
  status: typeof POST_CLASSIFICATION_PENDING;
  attempts: number;
  topics: string[];
  languages: string[];
  region?: string;
  hashtagsNorm: string[];
  sensitive: boolean;
  /** Deterministic spam/quality/toxicity scores (0..1); AI batch overwrites later. */
  scores: PostClassificationScores;
  version: number;
  classifiedAt: Date;
}

export class OutboxSyncService {
  /**
   * Build the Stage-A classification subdoc for a raw-inserted federated note.
   * Best-effort: the classifier is pure/synchronous so it should not throw, but
   * any throw is caught + logged at warn and a bare `pending` subdoc is returned
   * so the AI batch still processes the post and the batch insert is never
   * aborted by classification.
   */
  private computeBaselineForNote(input: {
    text: string;
    hashtags: string[];
    language?: string;
    languages?: string[];
    sensitive: boolean;
    instanceDomain?: string;
    actorType?: string;
  }): RawPostClassificationSeed {
    try {
      const signals = baselineContentClassifier.classify({
        text: input.text,
        hashtags: input.hashtags,
        language: input.language,
        languages: input.languages,
        sensitive: input.sensitive,
        isFederated: true,
        instanceDomain: input.instanceDomain,
        actorType: input.actorType,
      });
      return {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: signals.topics,
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        sensitive: signals.sensitive ?? input.sensitive,
        scores: signals.scores,
        version: signals.version,
        classifiedAt: new Date(signals.classifiedAt),
      };
    } catch (error) {
      logger.warn('[FedSync] baseline classification failed for federated note; seeding bare pending subdoc', error);
      return {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: [],
        languages: [],
        hashtagsNorm: input.hashtags,
        sensitive: input.sensitive,
        // Neutral, valid scores so ranking treats a defensive-fallback post as
        // unremarkable (not spam, mid quality) rather than skewing it.
        scores: toClassificationScores({ spam: 0, quality: SPAM_QUALITY_CONFIG.quality.base, toxicity: 0 }),
        version: 0,
        classifiedAt: new Date(),
      };
    }
  }

  /**
   * Fetch a remote actor's outbox and store posts in the DB.
   * Uses the same storage format as handleCreate so posts go through normal hydration.
   */
  async syncOutboxPosts(actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string; type?: string }, limit = 20): Promise<number> {
    const result = await this.syncOutboxPostsDetailed(actor, limit);
    return result.syncedCount;
  }

  async markOutboxBackfillUnavailable(
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct'> & { _id: unknown },
    reason?: string,
  ): Promise<void> {
    if (!actor.outboxUrl) return;

    await FederatedActor.updateOne(
      { _id: String(actor._id) },
      {
        $set: {
          'outboxBackfill.status': 'unavailable',
          'outboxBackfill.outboxUrl': actor.outboxUrl,
          'outboxBackfill.processedCount': 0,
          'outboxBackfill.importedCount': 0,
          'outboxBackfill.existingCount': 0,
          'outboxBackfill.pageCount': 0,
          'outboxBackfill.lastRunAt': new Date(),
          'outboxBackfill.completedAt': new Date(),
        },
        $unset: {
          'outboxBackfill.cursorUrl': '',
          'outboxBackfill.lockedUntil': '',
          'outboxBackfill.lastError': '',
          lastOutboxSyncAt: '',
        },
      },
    );
    logger.info(`[FedSync] marked outbox unavailable for ${actor.acct}; reason=${reason ?? 'unknown'}`);
  }

  async syncOutboxPostsDetailed(
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string; type?: string },
    limitOrOptions: number | OutboxSyncOptions = 20,
  ): Promise<OutboxSyncResult> {
    if (!actor.outboxUrl) {
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'missing-outbox' };
    }
    // Capture the narrowed value: `actor.outboxUrl` is `string | undefined`, and
    // the guard above only narrows the property at the method-body level. The
    // pagination closures below (`fetchAndProcessPage`) re-widen a property access
    // back to `string | undefined` because TS cannot prove it is not reassigned.
    // A `const` preserves the narrowing into those closures.
    const outboxUrl = actor.outboxUrl;

    const options: Required<Pick<OutboxSyncOptions, 'limit' | 'maxPages' | 'startItemOffset'>>
      & Pick<OutboxSyncOptions, 'startPageUrl'> = typeof limitOrOptions === 'number'
        ? { limit: limitOrOptions, maxPages: 10, startItemOffset: 0 }
        : {
            limit: limitOrOptions.limit ?? 20,
            maxPages: limitOrOptions.maxPages ?? 10,
            startPageUrl: limitOrOptions.startPageUrl,
            startItemOffset: limitOrOptions.startItemOffset ?? 0,
          };
    const limit = Math.max(1, options.limit);
    const maxPages = Math.max(1, options.maxPages);

    try {
      // Fetch the outbox collection (signed for authorized-fetch servers)
      const res = await signedFetch(outboxUrl, AP_CONTENT_TYPE);
      if (!res.ok) {
        logger.info(`[FedSync] outbox fetch failed: ${res.status} ${res.statusText} for ${outboxUrl}`);
        return { syncedCount: 0, shouldStampCooldown: false, reason: `outbox-http-${res.status}` };
      }

      const rawCollection = await res.json();
      // The outbox collection comes from an arbitrary remote server. Validate its
      // shape with zod before reading any field; a malformed collection (e.g.
      // `orderedItems` not an array, `totalItems` not a number, `first` not a
      // string/object) aborts THIS sync gracefully — we never trust raw remote
      // JSON. `.loose()` keeps unknown extension fields, so only genuinely
      // malformed shapes fail. Not a permanent failure and cooldown is not
      // stamped, so a transient bad response is retried on the next view.
      const collectionParse = parseOrderedCollection(rawCollection);
      if (!collectionParse.ok) {
        logger.warn(
          `[FedSync] outbox collection failed validation for ${actor.acct} (${outboxUrl}); aborting sync: ${collectionParse.error.message}`,
        );
        return { syncedCount: 0, shouldStampCooldown: false, reason: 'invalid-collection' };
      }
      // Keep reading raw fields below so every existing field access (including
      // `.loose()` passthrough extensions) behaves identically to before.
      const collection = rawCollection as Record<string, any>;
      logger.debug(`[FedSync] outbox collection type=${collection.type} totalItems=${collection.totalItems} hasOrderedItems=${!!collection.orderedItems} hasFirst=${!!collection.first}`);
      const remoteTotalItems = typeof collection.totalItems === 'number' ? collection.totalItems : undefined;

      const candidates: OutboxCandidate[] = [];
      let pagesFetched = 0;
      let nextCursor: OutboxSyncResult['nextCursor'];
      let reachedEnd = false;
      let paginationFailed = false;
      // Set when a page is processed only partially this run — either the
      // candidate limit was reached or the per-page inspection cap
      // (`OUTBOX_MAX_ITEMS_INSPECTED_PER_PAGE`) bounded the scan before the page
      // was exhausted. The returned cursor points back at the SAME page+offset,
      // so the run must STOP and hand that cursor to the next run instead of
      // re-fetching the same page to drain its remaining (possibly
      // attacker-controlled) items in one pass.
      let pausedMidPage = false;
      const visitedPageUrls = new Set<string>();

      const processPage = async (
        pageData: Record<string, any>,
        pageUrl: string,
        startItemOffset: number,
      ): Promise<void> => {
        const items = activityPubItems(pageData);
        const normalizedOffset = Math.max(0, Math.min(startItemOffset, items.length));
        if (items.length > 0) {
          const nextItemOffset = await this.extractCandidates(items, candidates, limit, pageUrl, actor.uri, normalizedOffset);
          if (nextItemOffset < items.length) {
            nextCursor = { url: pageUrl, itemOffset: nextItemOffset };
            pausedMidPage = true;
            return;
          }
        }

        const nextPageUrl = activityPubLinkUrl(pageData.next);
        if (nextPageUrl && isSameOriginHttpUrl(nextPageUrl, pageUrl)) {
          nextCursor = { url: nextPageUrl, itemOffset: 0 };
        } else {
          nextCursor = undefined;
          reachedEnd = true;
        }
      };

      const fetchAndProcessPage = async (pageUrl: string, startItemOffset: number): Promise<void> => {
        if (!isSameOriginHttpUrl(pageUrl, outboxUrl)) {
          logger.info(`[FedSync] rejected cross-origin outbox page for ${actor.acct}: ${pageUrl}`);
          paginationFailed = true;
          nextCursor = undefined;
          return;
        }

        if (visitedPageUrls.has(pageUrl)) {
          logger.info(`[FedSync] outbox pagination loop detected for ${actor.acct} at ${pageUrl}`);
          paginationFailed = true;
          nextCursor = undefined;
          return;
        }
        visitedPageUrls.add(pageUrl);

        if (pagesFetched >= maxPages) {
          nextCursor = { url: pageUrl, itemOffset: startItemOffset };
          return;
        }

        try {
          const pageRes = await signedFetch(pageUrl, AP_CONTENT_TYPE);
          if (!pageRes.ok) {
            logger.info(`[FedSync] outbox page fetch failed: ${pageRes.status} for ${pageUrl}`);
            paginationFailed = true;
            nextCursor = undefined;
            return;
          }

          pagesFetched++;
          const rawPage = await pageRes.json();
          // Each outbox page is untrusted remote JSON. Validate its collection
          // shape before reading items/pagination links; a malformed page aborts
          // pagination gracefully (same control flow as a page fetch failure)
          // instead of trusting raw property access. `.loose()` keeps extension
          // fields, so only genuinely malformed pages fail.
          const pageParse = parseOrderedCollectionPage(rawPage);
          if (!pageParse.ok) {
            logger.warn(
              `[FedSync] outbox page failed validation for ${actor.acct} at ${pageUrl}; stopping pagination: ${pageParse.error.message}`,
            );
            paginationFailed = true;
            nextCursor = undefined;
            return;
          }
          // Keep reading raw fields so every existing access is unchanged.
          const pageData = rawPage as Record<string, any>;
          await processPage(pageData, pageUrl, startItemOffset);
        } catch (pageErr) {
          logger.debug(`[FedSync] outbox pagination error: ${pageErr}`);
          paginationFailed = true;
          nextCursor = undefined;
        }
      };

      const firstPageObject = asRecord(collection.first);
      const inlineItems = activityPubItems(collection);
      if (options.startPageUrl && isSameOriginHttpUrl(options.startPageUrl, outboxUrl)) {
        nextCursor = { url: options.startPageUrl, itemOffset: Math.max(0, options.startItemOffset) };
      } else if (inlineItems.length > 0) {
        await processPage(collection, outboxUrl, 0);
      } else if (firstPageObject && activityPubItems(firstPageObject).length > 0) {
        await processPage(firstPageObject, activityPubLinkUrl(firstPageObject.id) ?? outboxUrl, 0);
      } else {
        const firstPageUrl = activityPubLinkUrl(collection.first) ?? activityPubLinkUrl(collection.next);
        if (firstPageUrl && isSameOriginHttpUrl(firstPageUrl, outboxUrl)) {
          nextCursor = { url: firstPageUrl, itemOffset: 0 };
        }
      }

      // Paginate through pages until we have enough candidates, pause mid-page
      // (candidate limit or per-page inspection cap), run out of pages, or
      // exhaust the per-run page budget. The returned cursor is opaque remote
      // state: we persist it exactly and never synthesize pagination URLs.
      while (
        nextCursor
        && candidates.length < limit
        && !reachedEnd
        && !paginationFailed
        && !pausedMidPage
      ) {
        const cursor = nextCursor;
        await fetchAndProcessPage(cursor.url, cursor.itemOffset);
        if (nextCursor?.url === cursor.url && nextCursor.itemOffset === cursor.itemOffset) {
          // The page budget was reached before this cursor could be processed.
          break;
        }
      }

      logger.debug(`[FedSync] collected ${candidates.length} candidates across ${pagesFetched} fetched pages for ${actor.acct}`);

      if (candidates.length === 0) {
        logger.debug(`[FedSync] no candidate notes found for ${actor.acct}`);
        const hasInlineItems = inlineItems.length > 0;
        const hasFirstPage = Boolean(collection.first || collection.next);
        const nonEmptyButNotInspectable = !options.startPageUrl
          && !hasInlineItems
          && !hasFirstPage
          && typeof remoteTotalItems === 'number'
          && remoteTotalItems > 0;
        const reason: OutboxSyncFailureReason = nonEmptyButNotInspectable ? 'non-empty-outbox-without-items' : 'no-candidates';
        return {
          syncedCount: 0,
          shouldStampCooldown: !paginationFailed && !isPermanentlyUnavailableOutboxReason(reason),
          reason,
          candidateCount: 0,
          newPostCount: 0,
          existingCount: 0,
          importedBoostCount: 0,
          pagesFetched,
          reachedEnd,
          nextCursor,
        };
      }

      const noteCandidates = candidates.filter(
        (c): c is Extract<OutboxCandidate, { kind: 'note' }> => c.kind === 'note',
      );
      const announceCandidates = candidates.filter(
        (c): c is Extract<OutboxCandidate, { kind: 'announce' }> => c.kind === 'announce',
      );

      // Bulk dedup: single query instead of N queries
      const allActivityIds = candidates.map(c => c.activityId);
      const existingPosts = await Post.find(
        { 'federation.activityId': { $in: allActivityIds } },
        { 'federation.activityId': 1 },
      ).lean();
      const existingIds = new Set(
        existingPosts.map(p => (p.federation as { activityId?: string } | undefined)?.activityId),
      );

      // Resolve actor URIs → Oxy User IDs (note authors only; announce authors
      // are always the outbox owner, resolved via actor.oxyUserId below).
      const actorUris = new Set<string>();
      for (const { note } of noteCandidates) {
        const uri = extractActorUri(note.attributedTo);
        if (uri) actorUris.add(uri);
      }

      // Batch lookup: actor URI → oxyUserId from stored FederatedActors
      const actorOxyMap = new Map<string, string>();
      // Seed with caller-provided oxyUserId for the main actor
      if (actor.oxyUserId) {
        actorOxyMap.set(actor.uri, actor.oxyUserId);
      }
      if (actorUris.size > 0) {
        const actors = await FederatedActor.find(
          { uri: { $in: [...actorUris] }, oxyUserId: { $ne: null } },
          { uri: 1, oxyUserId: 1 },
        ).lean();
        for (const a of actors) {
          if (a.oxyUserId) actorOxyMap.set(a.uri, a.oxyUserId);
        }

        // Resolve missing actors with bounded concurrency to avoid fan-out.
        // Each resolution is bounded by a per-actor timeout so one unresponsive
        // remote instance can't stall the batch.
        const missingUris = [...actorUris].filter(uri => !actorOxyMap.has(uri));
        for (let i = 0; i < missingUris.length; i += OUTBOX_ACTOR_RESOLVE_CONCURRENCY) {
          const batch = missingUris.slice(i, i + OUTBOX_ACTOR_RESOLVE_CONCURRENCY);
          const resolved = await Promise.all(batch.map(uri =>
            runWithTimeout(actorService.fetchRemoteActor(uri), OUTBOX_ACTOR_RESOLVE_TIMEOUT_MS)
          ));
          for (let j = 0; j < batch.length; j++) {
            const resolvedActor = resolved[j];
            if (resolvedActor?.oxyUserId) {
              actorOxyMap.set(batch[j], resolvedActor.oxyUserId);
            }
          }
        }
      }

      logger.debug(`[FedSync] ${candidates.length} candidates (${noteCandidates.length} notes, ${announceCandidates.length} announces), ${existingIds.size} already exist, actorOxyMap has ${actorOxyMap.size} entries`);

      // Resolve the @mentions of every NEW note in this page ONCE, with bounded
      // remote fan-out. Each DISTINCT mentioned actor across the page is
      // fetched-and-created at most once, in capped-concurrency batches with a
      // per-actor timeout (the SAME bounds this file already applies to note-author
      // resolution), so a page carrying many first-seen mentions can never trigger
      // the unbounded/serial actor fetch that once hung a re-ingest. Already-imported
      // (deduped) notes are excluded so a re-sync never re-resolves. Consumed per
      // note in the build loop below to rewrite each mention anchor into a
      // `[mention:<id>]` placeholder BEFORE the body is derived and to set the
      // post's `mentions` allowlist — mirroring the inbox Create path, which this
      // raw `insertMany` cannot inherit because it bypasses that code path.
      const pendingNoteCandidates = noteCandidates.filter(
        (c) => !existingIds.has(c.activityId),
      );
      const mentionsByNote = await resolveInboundMentionsForNotes(
        pendingNoteCandidates.map((c) => c.note),
        {
          concurrency: OUTBOX_ACTOR_RESOLVE_CONCURRENCY,
          perActorTimeoutMs: OUTBOX_ACTOR_RESOLVE_TIMEOUT_MS,
        },
      );
      // Shared no-mention default for a note the map has no entry for (never
      // mutated; `applyMentionPlaceholders` treats an empty anchor map as a no-op).
      const emptyMentions: ResolvedInboundMentions = { ids: [], localIds: [], anchorMap: new Map() };

      // Build documents for batch insert. Raw insert docs (bypass Mongoose) — a
      // loose record shape since they are assembled field-by-field below and
      // inserted via `Post.collection.insertMany`.
      const newDocs: Record<string, unknown>[] = [];
      // Federated replies inserted in this batch, to be linked into their threads
      // AFTER the raw insert (so a self-thread whose root + replies arrive in the
      // same batch resolve against the now-inserted parents). Captured separately
      // from `newDocs` to avoid casting the loose insert-doc shape back to read
      // its federation fields.
      const repliesToLink: Array<{ activityId: string; inReplyToUri: string }> = [];
      for (const { note, activity, activityId } of noteCandidates) {
        if (existingIds.has(activityId)) continue;

        const rawContent = note.content || '';
        if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) continue;

        // Normalize the AP `inReplyTo` (string IRI or embedded Link object) to a
        // clean string URI. Stored on `federation.inReplyTo` and used by the
        // post-insert thread-linking pass below to resolve `parentPostId`/`threadId`.
        const inReplyToUri = extractInReplyToUri(note.inReplyTo);

        // Preserve the ORIGINAL remote publish date (validated) so the post is
        // ordered by when it was authored, not when we backfilled it. The raw
        // `insertMany` below bypasses Mongoose timestamps, so a valid date is
        // written directly; an invalid/missing date leaves createdAt/updatedAt
        // off the doc and the schema default (now) applies.
        const published = parseApPublished(note.published ?? activity.published);

        // Resolve author's Oxy User ID. The Oxy link is MANDATORY: a federated
        // post must carry a real Oxy author, never a null one. When the author
        // didn't resolve (Oxy unreachable / pending), SKIP this note instead of
        // inserting an orphan — best-effort backfill re-imports it on the next
        // run once the actor resolves. Throwing here would abort the whole batch
        // over a single unresolvable item, so the outbox path skips rather than
        // defers (unlike the inbox `Create` path, which retries the job).
        const actorUri = actor.uri;
        const resolvedOxyUserId = actorOxyMap.get(actorUri);
        if (!resolvedOxyUserId) {
          logger.info(
            `[FedSync] skipping outbox note ${activityId}: author ${actorUri} not yet resolved to an Oxy user (no orphan)`,
          );
          continue;
        }

        // Rewrite this note's @mention anchors to internal `[mention:<id>]`
        // placeholders using the shared page-level resolution, so hydration renders
        // each mention as a real profile link instead of dead `@user` text. Must
        // run BEFORE the builder derives the body (the raw `insertMany` bypasses
        // Mongoose, so there is no later hook to do it). `applyMentionPlaceholders`
        // returns the note unchanged when it has no resolved mentions (zero cost).
        const mentionResult = mentionsByNote.get(note) ?? emptyMentions;
        const noteObject = applyMentionPlaceholders(note, mentionResult.anchorMap);

        // Build the storable body via the shared builder: contentMap fallback,
        // the SAME hashtag normalization the inbox path runs (fixes the ingest
        // asymmetry), media materialization, and the empty-note guard. The raw
        // `insertMany` below bypasses Mongoose middleware, so the builder is the
        // single place that normalization/guarding happens for this path. A Note
        // that carries nothing storable is skipped rather than inserted blank.
        const built = await buildFederatedNoteContent(noteObject, resolvedOxyUserId, {
          activityId,
          actorUri: actorUri ?? undefined,
        });
        if (built.skip) {
          logger.debug(`[FedSync] skipping empty outbox note ${activityId}: ${built.reason}`);
          continue;
        }
        const { text, media, attachments, hashtags, summary, sensitive, variants } = built;

        // AP-derived language so federated posts carry their REAL language
        // instead of the schema default 'en'. `extractApLanguage` is the declared
        // primary; `extractApLanguages` is the full declared set (top-level
        // `language` + every `contentMap` key) that feeds the classifier's
        // `postClassification.languages`.
        const apLanguage = extractApLanguage(note);
        const apLanguages = extractApLanguages(note);
        // Stage-A deterministic baseline. The raw insertMany bypasses Mongoose
        // middleware AND schema defaults, so the baseline fields are set
        // explicitly here (mirroring the explicit `postClassification` seed; the
        // hashtag normalization now runs inside `buildFederatedNoteContent`).
        // Best-effort: a classifier throw must not abort the whole batch insert —
        // fall back to the bare pending subdoc on failure.
        const baseline = this.computeBaselineForNote({
          text,
          hashtags,
          language: apLanguage,
          languages: apLanguages,
          sensitive,
          instanceDomain: actorUri ? getRemoteHost(actorUri) : undefined,
          // The outbox owner authored every Note in its own outbox, so the
          // owner's AP type is the note author's type (RSS/bot-mirror signal).
          actorType: actor.type,
        });
        // Top-level AP `post.language` (single, protocol-facing) = the resolved
        // primary (`languages[0]`, normalized to ISO 639-1), falling back to the
        // raw declared primary when the classifier resolved none.
        const primaryLanguage = baseline.languages[0] ?? apLanguage;

        newDocs.push({
          oxyUserId: resolvedOxyUserId,
          authorship: buildAuthorship(resolvedOxyUserId, []),
          federation: {
            activityId,
            actorUri,
            inReplyTo: inReplyToUri,
            url: note.url || note.id,
            sensitive,
            spoilerText: summary,
          },
          type: media.length > 0 ? (media.some((m) => m.type === 'video') ? 'video' : 'image') : 'text',
          content: {
            // The body, and its ONLY home (`contentMap` → author variants,
            // `variants[0]` primary). This insert path is RAW
            // (`Post.collection.insertMany`): it bypasses Mongoose middleware AND
            // schema defaults, so anything not written here is simply not
            // persisted — which is precisely why a hook-maintained `content.text`
            // mirror could not survive on this path, and why there is none.
            variants: variants.length > 0 ? variants : undefined,
            media: media.length > 0 ? media : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
          visibility: mapApVisibility(note.to, note.cc),
          hashtags,
          // Resolved @mention Oxy user ids (federated + local) — the SAME allowlist
          // the inbox path stores, keyed by the `[mention:<id>]` placeholders now in
          // the body so hydration renders each as a real profile link. Set
          // explicitly because the raw `insertMany` bypasses the schema default.
          ...(mentionResult.ids.length > 0 ? { mentions: mentionResult.ids } : {}),
          ...(primaryLanguage ? { language: primaryLanguage } : {}),
          status: 'published',
          // Engagement counters start at 0 and only ever move in lockstep with
          // real native records (Like docs / boost Posts / reply Posts) created
          // from inbound Like/Announce/Create activities. We never copy remote
          // aggregate totals (`note.likes/shares/replies.totalItems`) — those are
          // unverifiable foreign counts with no backing listable records here.
          stats: {
            likesCount: 0,
            boostsCount: 0,
            commentsCount: 0,
            viewsCount: 0,
            sharesCount: 0,
          },
          metadata: {
            isSensitive: sensitive,
          },
          // The raw collection insertMany bypasses Mongoose schema defaults, so
          // seed the classification subdoc explicitly. Stage-A deterministic
          // fields are populated here while `status` stays `pending` so the async
          // AI batch still enriches the post exactly like locally created posts.
          postClassification: baseline,
          ...(published ? { createdAt: published, updatedAt: published } : {}),
        });

        if (inReplyToUri) {
          repliesToLink.push({ activityId, inReplyToUri });
        }
      }

      // Strip empty location/coordinates from content to avoid 2dsphere index errors
      const hasInvalidCoords = (loc: unknown): boolean => {
        if (!loc || typeof loc !== 'object') return false;
        const coords = (loc as { coordinates?: unknown }).coordinates;
        return !Array.isArray(coords) || coords.length !== 2;
      };
      for (const doc of newDocs) {
        const content = doc.content as { location?: unknown } | undefined;
        if (content?.location && hasInvalidCoords(content.location)) {
          delete content.location;
        }
        if (doc.location && hasInvalidCoords(doc.location)) {
          delete doc.location;
        }
      }

      // Batch insert using raw collection to bypass Mongoose schema defaults
      // (Mongoose adds empty location.coordinates which breaks 2dsphere index)
      if (newDocs.length > 0) {
        await Post.collection.insertMany(newDocs, { ordered: false }).catch((err: unknown) => {
          // Partial write errors (duplicate key) are expected — log but don't throw.
          // Bulk-write errors carry `writeErrors: [{ err: { code, errmsg } }]`.
          type BulkWriteEntry = { err?: { code?: number; errmsg?: string } };
          const writeErrors: BulkWriteEntry[] =
            err && typeof err === 'object' && Array.isArray((err as { writeErrors?: unknown }).writeErrors)
              ? ((err as { writeErrors: BulkWriteEntry[] }).writeErrors)
              : [];
          const unexpectedErrors = writeErrors.filter((e) => e.err?.code !== 11000);
          if (unexpectedErrors.length > 0) {
            logger.warn(`[FedSync] insertMany unexpected errors: ${unexpectedErrors.map((e) => e.err?.errmsg).join('; ')}`);
          }
          if (writeErrors.length > 0 && writeErrors.length < newDocs.length) {
            logger.debug(`[FedSync] insertMany partial: ${writeErrors.length} errors, ${newDocs.length - writeErrors.length} inserted`);
          } else if (writeErrors.length === 0) {
            throw err;
          }
        });
      }

      // Link federated replies into their threads. Done AFTER the insert so a
      // self-thread whose root + replies arrive in the SAME batch resolves
      // against the now-inserted parents, and so a parent outside this batch is
      // backfilled (bounded) before linking. `resolveThreadLink` walks UP to the
      // thread ROOT via each post's stored `federation.inReplyTo`, so every reply
      // in the chain shares the same `threadId` regardless of intra-batch insert
      // order — identical to the native reply rule.
      for (const { activityId, inReplyToUri } of repliesToLink) {
        try {
          const link = await this.resolveThreadLink(inReplyToUri, 0, true);
          if (!link) continue;
          await Post.updateOne(
            { 'federation.activityId': activityId },
            { $set: { parentPostId: link.parentPostId, threadId: link.threadId } },
          );
        } catch (linkErr) {
          const message = linkErr instanceof Error ? linkErr.message : String(linkErr);
          logger.warn(`[FedSync] failed to link federated reply ${activityId} into its thread: ${message}`);
        }
      }

      // Import boosts (Announce) attributed to the outbox owner. Each announce
      // ensures the boosted Note exists locally, then creates a boost Post that
      // mirrors native reposts (type=boost, boostOf=<local note _id>) with the
      // booster's resolved oxyUserId; deduped by the Announce activity id.
      // Each import may fetch the boosted Note from a remote instance, so they
      // run with bounded concurrency rather than strictly sequentially.
      const boosterOxyUserId = actor.oxyUserId ?? actorOxyMap.get(actor.uri) ?? null;
      const pendingAnnounces = announceCandidates.filter(a => !existingIds.has(a.activityId));
      let importedBoosts = 0;
      for (let i = 0; i < pendingAnnounces.length; i += OUTBOX_BOOST_IMPORT_CONCURRENCY) {
        const batch = pendingAnnounces.slice(i, i + OUTBOX_BOOST_IMPORT_CONCURRENCY);
        const results = await Promise.all(batch.map(announce =>
          this.importAnnounce(
            announce.activity,
            announce.announcedUri,
            boosterOxyUserId,
          )
        ));
        importedBoosts += results.filter(Boolean).length;
      }

      const synced = existingIds.size + newDocs.length + importedBoosts;
      logger.debug(`Synced ${newDocs.length} new outbox posts and ${importedBoosts} boosts for ${actor.acct} (${existingIds.size} already existed)`);
      return {
        syncedCount: synced,
        shouldStampCooldown: !paginationFailed,
        reason: paginationFailed ? 'pagination-failed' : undefined,
        candidateCount: candidates.length,
        newPostCount: newDocs.length,
        existingCount: existingIds.size,
        importedBoostCount: importedBoosts,
        pagesFetched,
        reachedEnd,
        nextCursor,
      };
    } catch (err) {
      logger.warn(`Failed to sync outbox posts from ${actor.outboxUrl}:`, err);
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'exception' };
    }
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
    const maxIndexExclusive = Math.min(items.length, startIndex + OUTBOX_MAX_ITEMS_INSPECTED_PER_PAGE);
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
        logger.debug(
          `[FedSync] skipping malformed outbox item ${index} for ${(activity as { id?: unknown }).id ?? '<no id>'} — failed activity/note validation`,
        );
        continue;
      }

      // Announce (boost) — capture the announced object URI for later import.
      // Raw `===` on `type` preserves the prior behavior exactly (array-typed
      // `type` values were already not matched here).
      if (activity.type === 'Announce') {
        const activityId = activity.id;
        const announcedUri = extractAnnouncedObjectUri(activity.object);
        if (!activityId || !announcedUri) continue;
        if (!actorUrisMatch(extractActorUri(activity.actor), expectedActorUri)) continue;
        if (!activityIdBelongsToActor(activityId, expectedActorUri)) continue;
        candidates.push({ kind: 'announce', activity, activityId, announcedUri });
        continue;
      }

      const note = await this.extractOutboxNote(activity, sourcePageUrl);
      if (!note) continue;
      // The note may have been FETCHED from a remote URL (Create with a string
      // `object`), so it is independently untrusted — validate it too. A
      // malformed note is skipped, never trusted.
      if (!parseNote(note).ok) {
        logger.debug(
          `[FedSync] skipping malformed outbox note ${(note as { id?: unknown }).id ?? '<no id>'} — failed note validation`,
        );
        continue;
      }
      if (note.type !== 'Note' && note.type !== 'Article') continue;
      // Replies are NOT skipped: an actor's outbox is their OWN content, so their
      // self-thread continuations (and replies to others) are imported and linked
      // into threads by the post-insert linking pass. The `attributedTo` /
      // `activityIdBelongsToActor` guards below still ensure only the actor's own
      // notes become candidates.

      const activityId = note.id || activity.id;
      if (!activityId) continue;

      const attributedTo = extractActorUri(note.attributedTo);
      if (!actorUrisMatch(attributedTo, expectedActorUri)) continue;
      if (activity.type === 'Create' && !actorUrisMatch(extractActorUri(activity.actor), expectedActorUri)) continue;
      if (!activityIdBelongsToActor(activityId, expectedActorUri)) continue;

      candidates.push({ kind: 'note', note, activity, activityId });
    }

    return maxIndexExclusive;
  }

  private async resolveOutboxActivity(item: unknown, sourcePageUrl: string): Promise<Record<string, any> | null> {
    const inlineActivity = asRecord(item);
    if (inlineActivity) return inlineActivity;

    if (typeof item !== 'string' || !isSameOriginHttpUrl(item, sourcePageUrl)) return null;
    return fetchActivityPubObject(item);
  }

  private async extractOutboxNote(activity: Record<string, any>, sourcePageUrl: string): Promise<Record<string, any> | null> {
    if (activity.type === 'Note' || activity.type === 'Article') return activity;
    if (activity.type !== 'Create') return null;

    const inlineObject = asRecord(activity.object);
    if (inlineObject) return inlineObject;

    if (typeof activity.object === 'string' && isSameOriginHttpUrl(activity.object, sourcePageUrl)) {
      return fetchActivityPubObject(activity.object);
    }

    return null;
  }

  /**
   * Import a boost (Announce). Ensures the announced Note exists locally as a
   * Post, then creates a boost Post attributed to the booster — mirroring the
   * native repost shape (`type: 'boost'`, `boostOf: <local note _id>`,
   * `oxyUserId: <booster>`). Idempotent: deduped by the Announce activity id via
   * the `federation.activityId` unique sparse index. The boosted post's
   * `stats.boostsCount` is moved +1 in lockstep only when a new boost Post is
   * created.
   *
   * @param announceActivity the full Announce activity (for `published`).
   * @param announcedUri the URI of the announced (boosted) object.
   * @param boosterOxyUserId the booster's resolved Oxy user id. Must be non-null:
   *   federated boosts are only ever recorded against a real, listable user.
   * @returns true when a new boost Post was created.
   */
  async importAnnounce(
    announceActivity: Record<string, any>,
    announcedUri: string,
    boosterOxyUserId: string | null,
  ): Promise<boolean> {
    const announceId = typeof announceActivity.id === 'string' ? announceActivity.id : undefined;
    if (!announceId) return false;

    // A boost must be backed by a real, listable user. Without a resolved
    // booster we neither create a record nor move the counter.
    if (!boosterOxyUserId) {
      logger.info(`[FedSync] skipping boost for announce ${announceId}: unresolved booster`);
      return false;
    }

    // Dedup the boost itself by the Announce activity id.
    const existingBoost = await Post.exists({ 'federation.activityId': announceId });
    if (existingBoost) return false;

    // Resolve the boosted post's local _id. A local or already-imported post is
    // resolved directly; otherwise fetch and store the remote Note. This also
    // lets remote actors boost OUR posts (announcedUri = our AP note URI).
    const originalPostId = (await resolvePostIdFromObjectUri(announcedUri))
      ?? (await this.ensureFederatedNote(announcedUri));
    if (!originalPostId) {
      logger.info(`[FedSync] could not resolve boosted object ${announcedUri} for announce ${announceId}; skipping boost`);
      return false;
    }

    const originalPost = await Post.findById(originalPostId, { visibility: 1, status: 1 }).lean();
    if (!originalPost || originalPost.status !== 'published' || originalPost.visibility !== PostVisibility.PUBLIC) {
      logger.info(`[FedSync] skipping announce ${announceId}: boosted object ${announcedUri} is not public/published`);
      return false;
    }

    // The boost Post's date reflects when the BOOST happened (the Announce's
    // `published`), while the embedded original keeps its own date via its own
    // post — matching the native repost shape. Validated/falls back to now.
    const published = parseApPublished(announceActivity.published);

    try {
      await getPostCreator().create({
        oxyUserId: boosterOxyUserId,
        boostOf: originalPostId,
        // A boost carries no content of its own — mirror native reposts which
        // store an empty content body and rely on `boostOf` for hydration.
        content: { text: '' },
        visibility: PostVisibility.PUBLIC,
        federation: {
          activityId: announceId,
          actorUri: typeof announceActivity.actor === 'string' ? announceActivity.actor : undefined,
          url: typeof announceActivity.url === 'string' ? announceActivity.url : announceId,
        },
        status: 'published',
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
        ...(published ? { createdAt: published, updatedAt: published } : {}),
      });
    } catch (err) {
      // A duplicate-key error means a concurrent import already created the
      // boost — treat as already-imported, not a failure.
      if (isDuplicateKeyError(err)) return false;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FedSync] failed to create boost for announce ${announceId}: ${message}`);
      return false;
    }

    // A new boost Post was created — move the boosted post's counters +1 in
    // lockstep so stats.boostsCount always equals the number of boost records.
    // This is the ONLY site where a federated Announce becomes a native boost
    // count, so federatedBoostsCount is incremented alongside boostsCount here;
    // `boostsCount - federatedBoostsCount` then isolates the native boost count.
    await Post.updateOne(
      { _id: originalPostId },
      { $inc: { 'stats.boostsCount': 1, 'stats.federatedBoostsCount': 1 } },
    );
    return true;
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
        logger.warn(
          `[FedSync] ancestor backfill depth cap (${MAX_ANCESTOR_DEPTH}) reached at ${inReplyToUri}; leaving reply unlinked`,
        );
        return null;
      }
      parentPostId = await this.ensureFederatedNote(inReplyToUri, depth + 1);
      if (!parentPostId) return null;
    }

    // 3. Derive the thread-root id. A linked parent already points at the root;
    //    an unlinked federated parent is walked up via its stored inReplyTo.
    const parent = await Post.findById(parentPostId, {
      threadId: 1,
      'federation.inReplyTo': 1,
    }).lean<{ _id: unknown; threadId?: string; federation?: { inReplyTo?: string } } | null>();
    if (!parent) return null;

    if (parent.threadId) {
      return { parentPostId: String(parent._id), threadId: parent.threadId };
    }

    const parentInReplyToUri = extractInReplyToUri(parent.federation?.inReplyTo);
    if (parentInReplyToUri && depth < MAX_ANCESTOR_DEPTH) {
      const ancestorLink = await this.resolveThreadLink(parentInReplyToUri, depth + 1, allowBackfill);
      if (ancestorLink) {
        return { parentPostId: String(parent._id), threadId: ancestorLink.threadId };
      }
    }

    // Parent has no resolvable ancestor → it IS the thread root.
    return { parentPostId: String(parent._id), threadId: String(parent._id) };
  }

  /**
   * Ensure a federated Note/Article exists locally as a Post and return its
   * local Post `_id` (as a string). Fetches the object via `signedFetch` when it
   * is not already stored. Returns null when the object cannot be fetched or is
   * not a Note/Article.
   *
   * Used by boost import so a boost's `boostOf` always references a real local
   * Post `_id`, exactly like native reposts (which the hydration layer resolves
   * by looking the original post up by `_id`). Also used as the ancestor-backfill
   * step of {@link resolveThreadLink}: when the fetched note is itself a reply,
   * its own `parentPostId`/`threadId` are resolved (recursing up the chain, with
   * the depth budget threaded through) so the imported ancestor is fully linked.
   */
  private async ensureFederatedNote(objectUri: string, depth = 0): Promise<string | null> {
    // Already stored?
    const existing = await Post.findOne(
      { 'federation.activityId': objectUri },
      { _id: 1 },
    ).lean();
    if (existing) return String(existing._id);

    const objectGuard = await assertSafePublicUrl(objectUri);
    if (!objectGuard.ok) {
      logger.info(`[FedSync] rejected unsafe boosted object URL ${objectUri}: ${objectGuard.reason}`);
      return null;
    }

    // Fetch the announced object (the boosted Note) from its origin.
    const fetched = await fetchVerifiedAnnouncedNote(objectUri);
    if (!fetched) return null;
    const { note } = fetched;

    if (!note || (note.type !== 'Note' && note.type !== 'Article')) {
      logger.info(`[FedSync] boosted object ${objectUri} is not a Note/Article (type=${note?.type}); skipping`);
      return null;
    }

    const rawContent = typeof note.content === 'string' ? note.content : '';
    if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) {
      logger.info(`[FedSync] boosted object ${objectUri} exceeds max content length; skipping`);
      return null;
    }

    // Resolve the original author's actor → Oxy user id so the boosted post is
    // attributed correctly (same resolution path as handleCreate/syncOutbox).
    // The Oxy link is MANDATORY: rather than persist an orphan with a null
    // author, SKIP (return null) when the author can't be resolved yet. The boost
    // / ancestor link is simply not created this pass; it is re-attempted later
    // once the actor resolves. This best-effort helper runs in batch contexts
    // (outbox import, ancestor backfill), so it skips rather than throwing.
    const authorUri = extractActorUri(note.attributedTo);
    if (!authorUri) {
      logger.info(`[FedSync] boosted/ancestor object ${objectUri} has no attributable author; skipping (no orphan)`);
      return null;
    }
    const authorActor = await actorService.getOrFetchActor(authorUri);
    const authorOxyUserId = authorActor?.oxyUserId;
    if (!authorOxyUserId) {
      logger.info(
        `[FedSync] author ${authorUri} for ${objectUri} not yet resolved to an Oxy user; skipping (no orphan)`,
      );
      return null;
    }

    const noteActivityId = typeof note.id === 'string' ? note.id : objectUri;
    // The boosted original keeps its OWN publish date (validated/falls back to now).
    const published = parseApPublished(note.published);

    // Build the storable body via the shared builder (contentMap fallback,
    // hashtag normalization, media materialization, empty-note guard) — the SAME
    // path handleCreate and the outbox loop use. A boosted/ancestor Note that
    // carries nothing storable is skipped (return null) rather than creating a
    // blank post; the boost/ancestor link is simply not made this pass.
    const built = await buildFederatedNoteContent(note, authorOxyUserId, {
      activityId: noteActivityId,
      actorUri: authorUri ?? undefined,
    });
    if (built.skip) {
      logger.debug(`[FedSync] skipping empty boosted/ancestor note ${objectUri}: ${built.reason}`);
      return null;
    }
    const { media, attachments, hashtags, summary, sensitive, variants } = built;

    // When this note is itself a reply, link it into its thread (resolving /
    // backfilling its OWN parent chain up to the root). The depth budget is
    // threaded through so the recursion stays bounded across the chain.
    const inReplyToUri = extractInReplyToUri(note.inReplyTo);
    const threadLink = inReplyToUri ? await this.resolveThreadLink(inReplyToUri, depth, true) : null;

    try {
      const created = await getPostCreator().create({
        oxyUserId: authorOxyUserId,
        federation: {
          activityId: noteActivityId,
          inReplyTo: inReplyToUri,
          url: typeof note.url === 'string' ? note.url : noteActivityId,
          sensitive,
          spoilerText: summary,
        },
        parentPostId: threadLink?.parentPostId ?? null,
        threadId: threadLink?.threadId ?? null,
        content: {
          // The body, and its ONLY home (`variants[0]` is the primary).
          variants: variants.length > 0 ? variants : undefined,
          media: media.length > 0 ? media : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        visibility: mapApVisibility(note.to, note.cc),
        hashtags,
        // AP-derived language + author instance for the Stage-A baseline (and the
        // top-level `post.language`), via PostCreationService's classifier wiring.
        // The singular `language` is the primary; the full declared set feeds
        // `postClassification.languages`.
        language: extractApLanguage(note),
        languages: extractApLanguages(note),
        instanceDomain: authorUri ? getRemoteHost(authorUri) : undefined,
        status: 'published',
        metadata: { isSensitive: sensitive },
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
        ...(published ? { createdAt: published, updatedAt: published } : {}),
      });
      return String(created._id);
    } catch (err) {
      // Concurrent import may have created it — re-read to return the id.
      if (isDuplicateKeyError(err)) {
        const raced = await Post.findOne(
          { 'federation.activityId': noteActivityId },
          { _id: 1 },
        ).lean();
        return raced ? String(raced._id) : null;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FedSync] failed to store boosted note ${objectUri}: ${message}`);
      return null;
    }
  }
}

export const outboxSyncService = new OutboxSyncService();
export default outboxSyncService;
