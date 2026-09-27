import { randomUUID } from 'node:crypto';
import { enqueueFederatedMediaDeletions, FederatedMediaGoneError } from '../../db/federation/mediaDeletionRepository';
import { PostVisibility, type MediaItem } from '@mention/shared-types';
import type { NormalizedExternalMedia, NormalizedExternalPost } from '@oxy.so/federation';
import { isUniqueViolation } from '@oxy.so/db';
import { and, eq, gt, inArray, isNotNull, isNull, like, lte } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { postSourceKeys } from '../../db/schema/postContent';
import { posts } from '../../db/schema/posts';
import { claimSourceKey, findFilledSourceKeys, releaseSourceKeyClaim } from '../../db/posts/postSourceKeyRepository';
import { mediaMetadataService } from '../../services/MediaMetadataService';
import { deleteFederatedPostSubtree } from '../../services/FederatedPostDeletionService';
import { persistRemoteMediaForFederatedOwnerDetailed } from '../../services/mediaCache/cacheWorker';
import { getPostCreator } from '../../services/serviceRegistry';
import { logger } from '../../utils/logger';
import {
  INSTAGRAM_SOURCE_KEY_PREFIX,
  instagramShortcodeFromPermalink,
  instagramSourceKey,
  kilogramNoteIdFor,
} from '../shared/instagramSourceKey';
import { getRemoteHost } from '../shared/url';
import type { ExtractedMediaAttachment } from '../shared/federatedMedia';
import {
  GRAPH_MEDIA_PAGE_SIZE,
  INSTAGRAM_IDENTITY_DOMAIN,
  MAX_RECONCILE_DELETIONS,
  SOURCE_KEY_CLAIM_TTL_MS,
} from './constants';
import {
  fetchBusinessDiscovery,
  InstagramGraphError,
  type GraphBusinessProfile,
  type GraphMedia,
} from './graphClient';
import { mapGraphMediaToNormalizedPost, type InstagramMappedPost, type InstagramMediaPlan } from './media.mapper';
import type { GraphCallKind } from './usageBudget';

/**
 * Import one Instagram account's posts from the Graph API as native posts.
 *
 * Through the SAME `getPostCreator().create` path the ActivityPub and atproto
 * imports use (no notifications, no socket emit, no outbound federation, the
 * original `createdAt`).
 *
 * MEDIA IS RE-HOSTED OR THE POST WAITS. Meta's CDN URLs are signed and expire
 * (`oe=`), so an Instagram post never keeps one as its media: a slot whose file
 * cannot be stored falls back to its poster image, a slot that is gone for good
 * is dropped, and a slot that failed for a reason that may pass (media writes
 * off, Oxy unavailable, a throttled download) leaves the whole post for the next
 * sync rather than storing it with a link that dies in days.
 *
 * ONE POST, TWO ROADS. Before any download the post's source key
 * (`instagram:<shortcode>`) is CLAIMED in `post_source_keys`; the post insert
 * fills that claim. A kilogram push racing it collides on the claim (and its
 * inbox job retries into the finished post), so an upload is never made for a
 * post that then loses the race — oxy-api has no route to delete a durable
 * federation asset again. A post the bridge delivered before `post_source_keys`
 * existed is recognised by its bridge Note id.
 *
 * DELETIONS. The media listing is newest-first and contiguous, so the posts it
 * returns are EVERY post of the account after its oldest entry. A stored
 * Instagram post of this account inside that window that the listing no longer
 * has was probably deleted on Instagram. Deleting is irreversible, so one such
 * observation only MARKS it (`post_source_keys.missing_since`); it is removed
 * when a later sync still does not list it, and the mark is cleared whenever
 * it is listed again.
 */

export interface InstagramImportTarget {
  /** The Instagram username to ask Business Discovery about. */
  username: string;
  /** Every imported post's author. Required: no orphan posts. */
  ownerOxyUserId: string;
  /**
   * `posts.federation_actor_uri` for imported posts: the kilogram actor URI for a
   * bridge-identity account (so identity projection, cross-post detection and a
   * bridge Delete/Update — all keyed on it — treat the two roads as one source),
   * or `instagram-graph:<id>`.
   */
  actorUri: string;
  /**
   * The Instagram user id this account is pinned to (first successful sync, or
   * the id in an `instagram-graph:<id>` URI). A username can be released and
   * re-registered: if Business Discovery answers with another id, nothing is
   * imported or deleted under this identity.
   */
  expectedIgUserId?: string;
  /** Set for a kilogram-backed account: its bridge actor URI, for legacy dedupe. */
  kilogramActorUri?: string;
}

export interface InstagramImportOptions {
  /** Maximum posts to inspect, newest first. */
  limit: number;
  /** Do not fetch another page once a page contained an already-imported post. */
  stopAtKnown: boolean;
  /** Which budget tier the Graph calls draw from. */
  kind: GraphCallKind;
  /** Epoch ms after which no new page or post is started (lease safety). */
  deadline?: number;
}

export type InstagramImportOutcome =
  | 'ok'
  /** Finished, but some post waits for media that could not be stored yet. */
  | 'partial'
  /** Stopped at the deadline; the rest is for the next run. */
  | 'deadline'
  | 'identity_mismatch'
  | InstagramGraphError['kind'];

export interface InstagramImportResult {
  outcome: InstagramImportOutcome;
  imported: number;
  /** The posts this run stored, newest first. */
  posts: NormalizedExternalPost[];
  /** Media items the Graph API returned (before dedupe). */
  seen: number;
  /** Stored posts removed because Instagram no longer lists them (second observation). */
  deleted: number;
  /** Stored posts marked missing for the first time (removed only if still missing next time). */
  markedMissing: number;
  /**
   * How many media items this run walked newest-first WITHOUT stopping at
   * known posts, and whether the listing ended inside that walk. A sync that
   * stopped at known posts reports 0.
   */
  historyWalked: { items: number; exhausted: boolean };
  profile?: Omit<GraphBusinessProfile, 'media'>;
}

type SlotOutcome =
  | { kind: 'stored'; media: MediaItem; attachment: ExtractedMediaAttachment }
  | { kind: 'gone' }
  | { kind: 'retry' };

/** Re-host one remote file. `retry` = it may work later; `gone` = it never will. */
async function persistOne(
  item: NormalizedExternalMedia,
  ownerOxyUserId: string,
  context: { activityId: string; actorUri: string },
): Promise<SlotOutcome> {
  const remoteUrl = item.remoteUrl ?? item.id;
  const result = await persistRemoteMediaForFederatedOwnerDetailed(remoteUrl, ownerOxyUserId, {
    remoteHost: getRemoteHost(remoteUrl),
    activityId: context.activityId,
    actorUri: context.actorUri,
    mediaType: item.type,
  });
  if (!result.ok) {
    // For Instagram an over-cap or non-media file is as final as a 404: the
    // same bytes fail every retry, and — unlike ActivityPub media, whose stable
    // remote URL the proxy can keep streaming — keeping this URL would leave a
    // signed link that expires. The generic classifier deliberately keeps these
    // retryable for ActivityPub, so the Instagram rule lives here.
    const final = result.permanent || result.reason === 'too-large' || result.reason === 'not-media';
    return final ? { kind: 'gone' } : { kind: 'retry' };
  }
  const oxyFileId = result.media.oxyFileId;
  return {
    kind: 'stored',
    media: {
      id: oxyFileId,
      type: item.type,
      // Kept for provenance only; it is never rendered — the id is the Oxy file.
      remoteUrl,
      cachedFromFederation: true,
    },
    attachment: { type: 'media', id: oxyFileId, mediaType: item.type },
  };
}

/**
 * Re-host every slot, in order. A slot whose primary fails for ANY reason falls
 * back to its poster image (a Reel degrades to its still); a slot with nothing
 * storable is dropped when that is permanent, and makes the whole post wait
 * (`waitFor: 'retry'`, with the files already uploaded) when it might succeed
 * later. Exported for tests.
 */
export async function materializeInstagramMedia(
  plans: readonly InstagramMediaPlan[],
  ownerOxyUserId: string,
  context: { activityId: string; actorUri: string },
): Promise<{ media: MediaItem[]; attachments: ExtractedMediaAttachment[] } | { waitFor: 'retry'; uploaded: string[] }> {
  const media: MediaItem[] = [];
  const attachments: ExtractedMediaAttachment[] = [];
  for (const plan of plans) {
    let outcome = await persistOne(plan.primary, ownerOxyUserId, context);
    if (outcome.kind !== 'stored' && plan.fallback) {
      // The poster stands in whatever stopped the video. If it cannot be stored
      // either, the slot is only "gone" when BOTH are gone for good; otherwise
      // one of them may still work, and the post waits for it.
      const fallback = await persistOne(plan.fallback, ownerOxyUserId, context);
      if (fallback.kind === 'stored') outcome = fallback;
      else outcome = outcome.kind === 'gone' && fallback.kind === 'gone' ? { kind: 'gone' } : { kind: 'retry' };
    }
    // The slots already re-hosted are handed back so the caller can queue them
    // for deletion: the post waits, and nothing may reference them meanwhile.
    if (outcome.kind === 'retry') return { waitFor: 'retry', uploaded: media.map((item) => item.id) };
    if (outcome.kind === 'stored') {
      media.push(outcome.media);
      attachments.push(outcome.attachment);
    }
  }
  const enriched = media.length > 0 ? await mediaMetadataService.enrichFromOxy(media) : media;
  return { media: enriched, attachments };
}

/** The mapped posts already here (either road) — by source key. */
async function findAlreadyImported(
  mapped: readonly InstagramMappedPost[],
  kilogramActorUri: string | undefined,
): Promise<Set<string>> {
  if (mapped.length === 0) return new Set();
  const keys = mapped.map((entry) => entry.post.activityId);
  const known = await findFilledSourceKeys(keys);

  const byKilogramId = new Map<string, string>();
  for (const entry of mapped) {
    const noteId = kilogramActorUri ? kilogramNoteIdFor(kilogramActorUri, entry.shortcode) : undefined;
    if (noteId) byKilogramId.set(noteId, entry.post.activityId);
  }
  // Graph-imported rows carry the key as their activity id too; bridge rows
  // stored before `post_source_keys` existed carry only their Note id.
  const activityIds = [...keys, ...byKilogramId.keys()];
  const rows = await getDb()
    .select({ activityId: posts.federationActivityId })
    .from(posts)
    .where(inArray(posts.federationActivityId, activityIds));
  for (const row of rows) {
    if (!row.activityId) continue;
    known.add(byKilogramId.get(row.activityId) ?? row.activityId);
  }
  return known;
}

type CreateOutcome = 'created' | 'exists' | 'deferred' | 'failed';

/** Queue files this import uploaded but no post references (best-effort; logged). */
async function queueUnused(fileIds: readonly string[]): Promise<void> {
  if (fileIds.length === 0) return;
  await enqueueFederatedMediaDeletions(fileIds).catch((err: unknown) => {
    logger.warn('[instagram] could not queue unused re-hosted media for deletion', {
      files: fileIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Claim, re-host, insert. */
async function createInstagramPost(entry: InstagramMappedPost, target: InstagramImportTarget): Promise<CreateOutcome> {
  const { post } = entry;
  const claimToken = randomUUID();
  if (!(await claimSourceKey(post.activityId, claimToken, new Date(Date.now() + SOURCE_KEY_CLAIM_TTL_MS)))) {
    // Filled (the other road got here) or being imported right now.
    return 'exists';
  }

  let materialized: Awaited<ReturnType<typeof materializeInstagramMedia>>;
  try {
    materialized = await materializeInstagramMedia(entry.mediaPlans, target.ownerOxyUserId, {
      activityId: post.activityId,
      actorUri: target.actorUri,
    });
  } catch (err) {
    await releaseSourceKeyClaim(post.activityId, claimToken).catch(() => undefined);
    logger.warn('[instagram] media re-hosting failed', { error: err instanceof Error ? err.message : String(err) });
    return 'deferred';
  }
  if ('waitFor' in materialized) {
    await releaseSourceKeyClaim(post.activityId, claimToken).catch(() => undefined);
    await queueUnused(materialized.uploaded);
    return 'deferred';
  }
  if (materialized.media.length === 0 && post.text.trim().length === 0) {
    // Nothing left to show: every slot is permanently gone and there is no caption.
    await releaseSourceKeyClaim(post.activityId, claimToken).catch(() => undefined);
    return 'failed';
  }

  try {
    await getPostCreator().create({
      oxyUserId: target.ownerOxyUserId,
      federation: {
        activityId: post.activityId,
        actorUri: target.actorUri,
        url: post.url,
        sensitive: false,
        sourcePostKey: post.activityId,
        sourceKeyClaimToken: claimToken,
        // Instagram's CDN URLs EXPIRE: a media id mid-deletion must not be
        // swapped back to one. The insert refuses, and the post waits.
        goneMediaPolicy: 'refuse',
      },
      content: {
        text: post.text,
        media: materialized.media.length > 0 ? materialized.media : undefined,
        attachments: materialized.attachments.length > 0 ? materialized.attachments : undefined,
      },
      visibility: PostVisibility.PUBLIC,
      hashtags: post.hashtags,
      instanceDomain: INSTAGRAM_IDENTITY_DOMAIN,
      status: 'published',
      metadata: { isSensitive: false },
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
      ...(post.createdAt ? { createdAt: post.createdAt, updatedAt: post.createdAt } : {}),
    });
    return 'created';
  } catch (err) {
    await releaseSourceKeyClaim(post.activityId, claimToken).catch(() => undefined);
    // Whatever stopped the insert, the files uploaded for it are referenced by
    // nothing now: queue them. The drain re-checks references first, so a file
    // another post shares (or one the other road's copy uses) is kept.
    await queueUnused(materialized.media.map((item) => item.id));
    // A re-hosted file came back with the id of a file being deleted (Oxy
    // dedupes by content hash): wait for the deletion to finish, then a fresh
    // upload gets a fresh id.
    if (err instanceof FederatedMediaGoneError) return 'deferred';
    if (isUniqueViolation(err)) return 'exists';
    logger.warn('[instagram] failed to import post', { error: err instanceof Error ? err.message : String(err) });
    return 'failed';
  }
}

/**
 * Reconcile stored Instagram posts of this account against the listing, within
 * the window the listing proves complete: AFTER its oldest (tail) entry — the
 * bound is exclusive, since another post could share the tail's second and not
 * have been listed — up to its newest.
 *
 * A post missing for the first time is MARKED; one already marked by an earlier
 * sync and still missing is removed; a listed post loses any mark. Guarded: an
 * implausibly large number of missing posts is a listing anomaly, and then
 * nothing is marked or removed.
 */
async function reconcileDeletions(
  target: InstagramImportTarget,
  listed: readonly GraphMedia[],
  listedKeys: ReadonlySet<string>,
): Promise<{ deleted: number; marked: number }> {
  const none = { deleted: 0, marked: 0 };
  if (listed.length === 0) return none;

  // A post that reappeared is no longer suspected, wherever it sits.
  if (listedKeys.size > 0) {
    await getDb()
      .update(postSourceKeys)
      .set({ missingSince: null })
      .where(and(inArray(postSourceKeys.sourceKey, [...listedKeys]), isNotNull(postSourceKeys.missingSince)));
  }

  // Pinned posts can head the listing out of order; the TAIL is the oldest
  // entry of the contiguous run, the max is its newest.
  const times = listed.map((item) => Date.parse(item.timestamp ?? '')).filter(Number.isFinite);
  const tail = Date.parse(listed[listed.length - 1].timestamp ?? '');
  if (!Number.isFinite(tail) || times.length === 0) return none;
  const from = new Date(tail);
  const to = new Date(Math.max(...times));

  const stored = await getDb()
    .select({ id: posts.id, sourceKey: postSourceKeys.sourceKey, missingSince: postSourceKeys.missingSince })
    .from(posts)
    .innerJoin(postSourceKeys, eq(postSourceKeys.postId, posts.id))
    .where(and(
      eq(posts.federationActorUri, target.actorUri),
      eq(posts.oxyUserId, target.ownerOxyUserId),
      like(postSourceKeys.sourceKey, `${INSTAGRAM_SOURCE_KEY_PREFIX}%`),
      gt(posts.createdAt, from),
      lte(posts.createdAt, to),
    ));
  const missing = stored.filter((row) => !listedKeys.has(row.sourceKey));
  if (missing.length === 0) return none;
  if (missing.length > MAX_RECONCILE_DELETIONS) {
    logger.warn('[instagram] refused to reconcile an implausible number of missing posts', { missing: missing.length });
    return none;
  }

  const firstSeen = missing.filter((row) => row.missingSince === null).map((row) => row.sourceKey);
  if (firstSeen.length > 0) {
    await getDb()
      .update(postSourceKeys)
      .set({ missingSince: new Date() })
      .where(and(inArray(postSourceKeys.sourceKey, firstSeen), isNull(postSourceKeys.missingSince)));
  }

  let deleted = 0;
  for (const row of missing) {
    if (row.missingSince === null) continue;
    if ((await deleteFederatedPostSubtree(row.id, target.actorUri)) === 'deleted') deleted += 1;
  }
  if (deleted > 0 || firstSeen.length > 0) {
    logger.info('[instagram] reconciled posts missing on Instagram', { deleted, marked: firstSeen.length });
  }
  return { deleted, marked: firstSeen.length };
}

/**
 * Page through the account's media newest-first, import what is new and remove
 * what Instagram no longer lists. Never throws: a Graph failure is the result's
 * `outcome`, with whatever earlier pages already imported counted.
 */
export async function importInstagramMedia(
  target: InstagramImportTarget,
  options: InstagramImportOptions,
): Promise<InstagramImportResult> {
  let imported = 0;
  let deferred = 0;
  const importedPosts: NormalizedExternalPost[] = [];
  const listed: GraphMedia[] = [];
  const listedKeys = new Set<string>();
  let seen = 0;
  let exhausted = false;
  let after: string | undefined;
  let profile: InstagramImportResult['profile'];
  const result = (
    outcome: InstagramImportOutcome,
    reconciled: { deleted: number; marked: number } = { deleted: 0, marked: 0 },
  ): InstagramImportResult => ({
    outcome,
    imported,
    posts: importedPosts,
    seen,
    deleted: reconciled.deleted,
    markedMissing: reconciled.marked,
    historyWalked: options.stopAtKnown ? { items: 0, exhausted: false } : { items: seen, exhausted },
    profile,
  });
  const pastDeadline = () => options.deadline !== undefined && Date.now() >= options.deadline;

  while (seen < options.limit) {
    if (pastDeadline()) return result('deadline');
    const pageSize = Math.min(GRAPH_MEDIA_PAGE_SIZE, options.limit - seen);
    let page: GraphBusinessProfile;
    try {
      page = await fetchBusinessDiscovery(target.username, {
        kind: options.kind,
        media: { limit: pageSize, after },
      });
    } catch (err) {
      const outcome = err instanceof InstagramGraphError ? err.kind : 'transport';
      if (outcome !== 'not_business') {
        logger.info('[instagram] Graph import stopped', { outcome, imported });
      }
      return result(outcome);
    }

    if (target.expectedIgUserId && page.id !== target.expectedIgUserId) {
      // The username now names a different Instagram account.
      logger.warn('[instagram] username resolves to a different Instagram account; import refused');
      return result('identity_mismatch');
    }

    const { media, ...pageProfile } = page;
    profile = pageProfile;
    const items: GraphMedia[] = media?.data ?? [];
    seen += items.length;
    listed.push(...items);
    // EVERY listed item's key, including items that map to no importable post
    // (nothing to show, no media): such an item is still on Instagram, and a
    // stored copy of it must never look deleted.
    for (const item of items) {
      const key = instagramSourceKey(instagramShortcodeFromPermalink(item.permalink));
      if (key) listedKeys.add(key);
    }

    const mapped = items
      .map((item) => mapGraphMediaToNormalizedPost(item, target.actorUri))
      .filter((entry): entry is InstagramMappedPost => entry !== null);
    const known = await findAlreadyImported(mapped, target.kilogramActorUri);

    for (const entry of mapped) {
      if (known.has(entry.post.activityId)) continue;
      if (pastDeadline()) return result('deadline');
      const outcome = await createInstagramPost(entry, target);
      if (outcome === 'created') {
        imported += 1;
        importedPosts.push({ ...entry.post, authorOxyUserId: target.ownerOxyUserId });
      } else if (outcome === 'deferred') {
        deferred += 1;
      }
    }

    after = media?.after;
    if (!after || items.length < pageSize) {
      exhausted = true;
      break;
    }
    const pageHadKnown = mapped.some((entry) => known.has(entry.post.activityId));
    if (options.stopAtKnown && pageHadKnown) break;
  }

  const reconciled = await reconcileDeletions(target, listed, listedKeys).catch((err: unknown) => {
    logger.warn('[instagram] deletion reconcile failed', { error: err instanceof Error ? err.message : String(err) });
    return { deleted: 0, marked: 0 };
  });
  return result(deferred > 0 ? 'partial' : 'ok', reconciled);
}
