import { logger } from '../../utils/logger';
import FederatedActor, { IFederatedActor } from '../../models/FederatedActor';
import { Post } from '../../models/Post';
import {
  FEDERATION_MAX_CONTENT_LENGTH,
  AP_CONTENT_TYPE,
} from '../../utils/federation/constants';
import { PostVisibility } from '@mention/shared-types';
import { htmlToPlainText } from '../../utils/federation/htmlToPlainText';
import { normalizePostHashtags } from '../../utils/textProcessing';
import { getPostCreator } from '../serviceRegistry';
import { actorService } from './ActorService';
import {
  isAbsoluteHttpUrl,
  asRecord,
  activityPubItems,
  activityPubLinkUrl,
  signedFetch,
  fetchActivityPubObject,
  runWithTimeout,
  isDuplicateKeyError,
  extractAnnouncedObjectUri,
  extractActorUri,
  extractApMedia,
  extractApHashtags,
  mapApVisibility,
  resolvePostIdFromObjectUri,
  materializeFederatedMedia,
} from './sharedFederationHelpers';

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
 * Extracted verbatim from the monolithic FederationService — same behavior,
 * same signatures. Depends on ActorService (actor resolution), the shared
 * low-level helpers, and the registered PostCreator. Registers itself as the
 * BoostImporter so InboxProcessingService can reuse `importAnnounce` without a
 * load-order cycle.
 */
export class OutboxSyncService {
  /**
   * Fetch a remote actor's outbox and store posts in the DB.
   * Uses the same storage format as handleCreate so posts go through normal hydration.
   */
  async syncOutboxPosts(actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string }, limit = 20): Promise<number> {
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
    actor: Pick<IFederatedActor, 'outboxUrl' | 'acct' | 'uri'> & { oxyUserId?: string },
    limitOrOptions: number | OutboxSyncOptions = 20,
  ): Promise<OutboxSyncResult> {
    if (!actor.outboxUrl) {
      return { syncedCount: 0, shouldStampCooldown: false, reason: 'missing-outbox' };
    }

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
      const res = await signedFetch(actor.outboxUrl, AP_CONTENT_TYPE);
      if (!res.ok) {
        logger.info(`[FedSync] outbox fetch failed: ${res.status} ${res.statusText} for ${actor.outboxUrl}`);
        return { syncedCount: 0, shouldStampCooldown: false, reason: `outbox-http-${res.status}` };
      }

      const collection = await res.json() as Record<string, any>;
      logger.debug(`[FedSync] outbox collection type=${collection.type} totalItems=${collection.totalItems} hasOrderedItems=${!!collection.orderedItems} hasFirst=${!!collection.first}`);
      const remoteTotalItems = typeof collection.totalItems === 'number' ? collection.totalItems : undefined;

      const candidates: OutboxCandidate[] = [];
      let pagesFetched = 0;
      let nextCursor: OutboxSyncResult['nextCursor'];
      let reachedEnd = false;
      let paginationFailed = false;
      const visitedPageUrls = new Set<string>();

      const processPage = async (
        pageData: Record<string, any>,
        pageUrl: string,
        startItemOffset: number,
      ): Promise<void> => {
        const items = activityPubItems(pageData);
        const normalizedOffset = Math.max(0, Math.min(startItemOffset, items.length));
        if (items.length > 0) {
          const nextItemOffset = await this.extractCandidates(items, candidates, limit, normalizedOffset);
          if (nextItemOffset < items.length) {
            nextCursor = { url: pageUrl, itemOffset: nextItemOffset };
            return;
          }
        }

        const nextPageUrl = activityPubLinkUrl(pageData.next);
        if (nextPageUrl) {
          nextCursor = { url: nextPageUrl, itemOffset: 0 };
        } else {
          nextCursor = undefined;
          reachedEnd = true;
        }
      };

      const fetchAndProcessPage = async (pageUrl: string, startItemOffset: number): Promise<void> => {
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
          const pageData = await pageRes.json() as Record<string, any>;
          await processPage(pageData, pageUrl, startItemOffset);
        } catch (pageErr) {
          logger.debug(`[FedSync] outbox pagination error: ${pageErr}`);
          paginationFailed = true;
          nextCursor = undefined;
        }
      };

      const firstPageObject = asRecord(collection.first);
      const inlineItems = activityPubItems(collection);
      if (options.startPageUrl) {
        nextCursor = { url: options.startPageUrl, itemOffset: Math.max(0, options.startItemOffset) };
      } else if (inlineItems.length > 0) {
        await processPage(collection, actor.outboxUrl, 0);
      } else if (firstPageObject && activityPubItems(firstPageObject).length > 0) {
        await processPage(firstPageObject, activityPubLinkUrl(firstPageObject.id) ?? actor.outboxUrl, 0);
      } else {
        const firstPageUrl = activityPubLinkUrl(collection.first) ?? activityPubLinkUrl(collection.next);
        if (firstPageUrl) {
          nextCursor = { url: firstPageUrl, itemOffset: 0 };
        }
      }

      // Paginate through pages until we have enough candidates, run out of pages,
      // or exhaust the per-run page budget. The returned cursor is opaque remote
      // state: we persist it exactly and never synthesize pagination URLs.
      while (
        nextCursor
        && candidates.length < limit
        && !reachedEnd
        && !paginationFailed
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

      // Build documents for batch insert
      const newDocs: any[] = [];
      for (const { note, activity, activityId } of noteCandidates) {
        if (existingIds.has(activityId)) continue;

        const rawContent = note.content || '';
        if (rawContent.length > FEDERATION_MAX_CONTENT_LENGTH) continue;

        const rawText = htmlToPlainText(rawContent);
        const extracted = extractApMedia(note);
        // The raw collection insertMany below bypasses Mongoose middleware, so
        // run the centralized normalizer explicitly: clean spammy hashtag blocks
        // from the visible text and merge inline tags with the AP `tag` array
        // tags (passed as userProvided so non-inline federated tags survive).
        const { content: text, hashtags } = normalizePostHashtags(rawText, extractApHashtags(note));
        const published = note.published || activity.published;

        // Resolve author's Oxy User ID
        const actorUri = extractActorUri(note.attributedTo);
        const resolvedOxyUserId = actorUri ? actorOxyMap.get(actorUri) || null : null;
        if (!resolvedOxyUserId) {
          logger.debug(`[FedSync] no oxyUserId resolved for actorUri=${actorUri} activityId=${activityId}`);
        }
        const { media, attachments } = await materializeFederatedMedia(
          extracted.media,
          extracted.attachments,
          resolvedOxyUserId,
          { activityId, actorUri: actorUri ?? undefined },
        );

        newDocs.push({
          oxyUserId: resolvedOxyUserId,
          federation: {
            activityId,
            inReplyTo: note.inReplyTo || undefined,
            url: note.url || note.id,
            sensitive: note.sensitive || false,
            spoilerText: note.summary || undefined,
          },
          type: media.length > 0 ? (media.some((m: any) => m.type === 'video') ? 'video' : 'image') : 'text',
          content: {
            text,
            media: media.length > 0 ? media : undefined,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
          visibility: mapApVisibility(note.to, note.cc),
          hashtags,
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
            isSensitive: note.sensitive === true,
          },
          // The raw collection insertMany bypasses Mongoose schema defaults, so
          // seed the classification subdoc explicitly. Federated/imported posts
          // must default to `pending` so the classification batch job picks them
          // up exactly like locally created posts.
          postClassification: { status: 'pending', attempts: 0 },
          ...(published ? { createdAt: new Date(published), updatedAt: new Date(published) } : {}),
        });
      }

      // Strip empty location/coordinates from content to avoid 2dsphere index errors
      for (const doc of newDocs) {
        if (doc.content?.location) {
          if (!doc.content.location.coordinates || doc.content.location.coordinates.length !== 2) {
            delete doc.content.location;
          }
        }
        if (doc.location) {
          if (!doc.location.coordinates || doc.location.coordinates.length !== 2) {
            delete doc.location;
          }
        }
      }

      // Batch insert using raw collection to bypass Mongoose schema defaults
      // (Mongoose adds empty location.coordinates which breaks 2dsphere index)
      if (newDocs.length > 0) {
        await Post.collection.insertMany(newDocs, { ordered: false }).catch((err: any) => {
          // Partial write errors (duplicate key) are expected — log but don't throw
          const writeErrors = err?.writeErrors || [];
          const unexpectedErrors = writeErrors.filter((e: any) => e.err?.code !== 11000);
          if (unexpectedErrors.length > 0) {
            logger.warn(`[FedSync] insertMany unexpected errors: ${unexpectedErrors.map((e: any) => e.err?.errmsg).join('; ')}`);
          }
          if (writeErrors.length > 0 && writeErrors.length < newDocs.length) {
            logger.debug(`[FedSync] insertMany partial: ${writeErrors.length} errors, ${newDocs.length - writeErrors.length} inserted`);
          } else if (writeErrors.length === 0) {
            throw err;
          }
        });
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
    startIndex = 0,
  ): Promise<number> {
    for (let index = startIndex; index < items.length; index++) {
      if (candidates.length >= limit) return index;

      const activity = await this.resolveOutboxActivity(items[index]);
      if (!activity) continue;

      // Announce (boost) — capture the announced object URI for later import.
      if (activity.type === 'Announce') {
        const activityId = activity.id;
        const announcedUri = extractAnnouncedObjectUri(activity.object);
        if (!activityId || !announcedUri) continue;
        candidates.push({ kind: 'announce', activity, activityId, announcedUri });
        continue;
      }

      const note = await this.extractOutboxNote(activity);
      if (!note) continue;
      if (note.type !== 'Note' && note.type !== 'Article') continue;
      if (note.inReplyTo) continue;

      const activityId = note.id || activity.id;
      if (!activityId) continue;

      candidates.push({ kind: 'note', note, activity, activityId });
    }

    return items.length;
  }

  private async resolveOutboxActivity(item: unknown): Promise<Record<string, any> | null> {
    const inlineActivity = asRecord(item);
    if (inlineActivity) return inlineActivity;

    if (typeof item !== 'string' || !isAbsoluteHttpUrl(item)) return null;
    return fetchActivityPubObject(item);
  }

  private async extractOutboxNote(activity: Record<string, any>): Promise<Record<string, any> | null> {
    if (activity.type === 'Note' || activity.type === 'Article') return activity;
    if (activity.type !== 'Create') return null;

    const inlineObject = asRecord(activity.object);
    if (inlineObject) return inlineObject;

    if (typeof activity.object === 'string' && isAbsoluteHttpUrl(activity.object)) {
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

    const published = typeof announceActivity.published === 'string' ? announceActivity.published : undefined;

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
          url: typeof announceActivity.url === 'string' ? announceActivity.url : announceId,
        },
        status: 'published',
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
        ...(published ? { createdAt: new Date(published), updatedAt: new Date(published) } : {}),
      });
    } catch (err) {
      // A duplicate-key error means a concurrent import already created the
      // boost — treat as already-imported, not a failure.
      if (isDuplicateKeyError(err)) return false;
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[FedSync] failed to create boost for announce ${announceId}: ${message}`);
      return false;
    }

    // A new boost Post was created — move the boosted post's counter +1 in
    // lockstep so stats.boostsCount always equals the number of boost records.
    await Post.updateOne({ _id: originalPostId }, { $inc: { 'stats.boostsCount': 1 } });
    return true;
  }

  /**
   * Ensure a federated Note/Article exists locally as a Post and return its
   * local Post `_id` (as a string). Fetches the object via `signedFetch` when it
   * is not already stored. Returns null when the object cannot be fetched or is
   * not a Note/Article.
   *
   * Used by boost import so a boost's `boostOf` always references a real local
   * Post `_id`, exactly like native reposts (which the hydration layer resolves
   * by looking the original post up by `_id`).
   */
  private async ensureFederatedNote(objectUri: string): Promise<string | null> {
    // Already stored?
    const existing = await Post.findOne(
      { 'federation.activityId': objectUri },
      { _id: 1 },
    ).lean();
    if (existing) return String(existing._id);

    // Fetch the announced object (the boosted Note) from its origin.
    let note: Record<string, any>;
    try {
      const res = await signedFetch(objectUri, AP_CONTENT_TYPE);
      if (!res.ok) {
        logger.info(`[FedSync] failed to fetch boosted object ${objectUri}: ${res.status} ${res.statusText}`);
        return null;
      }
      note = await res.json() as Record<string, any>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info(`[FedSync] error fetching boosted object ${objectUri}: ${message}`);
      return null;
    }

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
    const authorUri = extractActorUri(note.attributedTo);
    let authorOxyUserId: string | null = null;
    if (authorUri) {
      const authorActor = await actorService.getOrFetchActor(authorUri);
      authorOxyUserId = authorActor?.oxyUserId ?? null;
    }

    const text = htmlToPlainText(rawContent);
    const extracted = extractApMedia(note);
    const hashtags = extractApHashtags(note);
    const published = typeof note.published === 'string' ? note.published : undefined;
    const noteActivityId = typeof note.id === 'string' ? note.id : objectUri;
    const { media, attachments } = await materializeFederatedMedia(
      extracted.media,
      extracted.attachments,
      authorOxyUserId,
      { activityId: noteActivityId, actorUri: authorUri ?? undefined },
    );

    try {
      const created = await getPostCreator().create({
        oxyUserId: authorOxyUserId,
        federation: {
          activityId: noteActivityId,
          inReplyTo: typeof note.inReplyTo === 'string' ? note.inReplyTo : undefined,
          url: typeof note.url === 'string' ? note.url : noteActivityId,
          sensitive: note.sensitive === true,
          spoilerText: typeof note.summary === 'string' ? note.summary : undefined,
        },
        content: {
          text,
          media: media.length > 0 ? media : undefined,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        visibility: mapApVisibility(note.to, note.cc),
        hashtags,
        status: 'published',
        metadata: { isSensitive: note.sensitive === true },
        skipNotifications: true,
        skipSocketEmit: true,
        skipFederationDelivery: true,
        ...(published ? { createdAt: new Date(published), updatedAt: new Date(published) } : {}),
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
