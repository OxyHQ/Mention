/**
 * Content import: a user's old posts from another platform, written into Mention
 * as their own posts.
 *
 * Oxy Move (a separate first-party app) reads the source account and calls the
 * ingest API (`routes/imports.ts`); this is the domain half. The contract Move
 * relies on is `docs/import.mdx` — change the two together.
 *
 * ## What an imported post is
 *
 * An ORDINARY native post of its author, created through
 * `PostCreationService.create` like every other one, with four differences:
 *
 * - it keeps its ORIGINAL `created_at`, so it lands at its real place in the
 *   author's profile and outbox rather than on top of everyone's feed;
 * - it runs NO live side effects — no notification, no socket broadcast, no
 *   push federation delivery (`skipNotifications` returns before the fan-out,
 *   and the two other flags say so explicitly). A backfill of years of posts
 *   is not news, and pushing it would flood followers and remote inboxes;
 * - it derives NO mentions (`neutralizeMentions`): the people it names were
 *   addressed on another platform, not on Mention;
 * - it gets a `post_imports` ledger row, which is its dedupe key, its undo
 *   scope and its provenance.
 *
 * It is still PUBLISHED and still federates by PULL: the ActivityPub outbox
 * serves it (with `published` = the original date) to any server that asks.
 *
 * ## Idempotency
 *
 * `(oxy_user_id, platform, source_id)` is unique. An item already in the ledger
 * answers `existing` with its post id and writes nothing. Two concurrent sends
 * of one item race on the ledger insert, not on a read: the loser deletes the
 * post it just created (through the normal delete path) and answers `existing`.
 */

import {
  PostVisibility,
  type ImportPlatform,
  type MediaItem,
  type PostContent,
} from '@mention/shared-types';
import {
  findBatchPostIds,
  findFederatedCopies,
  findImportsBySourceIds,
  insertPostImport,
} from '../db/imports/postImportRepository';
import { loadPostRecord, updatePostRecord } from '../db/posts/postRepository';
import { config } from '../config';
import { logger } from '../utils/logger';
import { mergeHashtags } from '../utils/textProcessing';
import { normalizeAltInput } from '../utils/mediaInput';
import { mediaMetadataService } from './MediaMetadataService';
import { postCreationService } from './PostCreationService';
import { deleteAuthoredPost } from './PostDeletionService';
import { persistPreparedArticle, prepareArticle } from './postArticles';

/** Items per `posts:batch` call. Keeps one request well inside the body limit and a request timeout. */
export const MAX_IMPORT_BATCH_ITEMS = 50;
/** Media per imported post: the largest carousel a supported platform allows (Instagram). */
export const MAX_IMPORT_MEDIA_PER_ITEM = 10;
/** Links per imported post that may be appended to its body. */
export const MAX_IMPORT_LINKS_PER_ITEM = 10;
/**
 * How far in the future an item's `createdAt` may claim to be. A source clock is
 * not ours to trust (`utils/ingestTimestamp.ts` makes the same call for
 * federation); an item beyond this is refused rather than re-dated.
 */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

export type ImportVisibility = PostVisibility.PUBLIC | PostVisibility.FOLLOWERS_ONLY;

/** One item as the route validated it. */
export interface ImportItemInput {
  sourceId: string;
  sourceUrl: string;
  createdAt: Date;
  text: string;
  contentWarning?: string;
  language?: string;
  visibility: ImportVisibility;
  replyToSourceId?: string;
  quoteSourceId?: string;
  media: Array<{ assetId: string; alt?: string }>;
  /** Already sanitized (`sanitizeArticle`); absent when there is none. */
  article?: { title?: string; body?: string };
  links?: string[];
}

/**
 * - `created` — a new post exists.
 * - `existing` — the item was imported before; `postId` is that post. Nothing written.
 * - `deferred` — the parent or quoted item is not imported yet. Nothing written;
 *   send it again once the referenced item has been sent, or without the
 *   reference to import it as a standalone post.
 * - `failed` — the item was refused; `error` says why. Nothing written.
 */
export type ImportItemStatus = 'created' | 'existing' | 'deferred' | 'failed';

export interface ImportItemResult {
  sourceId: string;
  status: ImportItemStatus;
  postId?: string;
  error?: string;
}

export interface ImportLookupResult {
  /** Source id → Mention post id, for items this user already imported. */
  imported: Record<string, string>;
  /**
   * AS2 object id / at-uri → the federated copy Mention already ingested of it,
   * for ids that federation brought in before the account moved.
   */
  federated: Record<string, { postId: string; actorUri: string | null; url: string | null; oxyUserId: string | null }>;
}

/** An item was refused; the message is the stable `error` code Move reads. */
class ImportItemRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ImportItemRefusal';
  }
}

/** The Mention media type of an Oxy asset, from its MIME type; `null` when it is not one a post can carry. */
function mediaTypeFromMime(mime: string): MediaItem['type'] | null {
  const normalized = mime.toLowerCase();
  if (normalized === 'image/gif') return 'gif';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  return null;
}

/**
 * The body as it will be stored: the source text, then every link the source
 * carried that the text does not already show.
 *
 * A link can live OUTSIDE the text on its source — a Bluesky facet whose visible
 * text is a truncated label, a card that is not in the caption. Appending it is
 * what keeps it reachable and lets the link preview run; a link the text already
 * contains is not repeated.
 */
function composeBody(text: string, links: readonly string[] | undefined): string {
  const missing = (links ?? []).filter((link) => !text.includes(link));
  if (missing.length === 0) return text;
  return [text.trimEnd(), ...missing].filter((part) => part.length > 0).join('\n');
}

class PostImportService {
  /**
   * Import one batch, IN ORDER.
   *
   * Order matters: an item may reply to or quote an item earlier in the same
   * batch, and it resolves because that one was created first. Items are
   * independent otherwise — one refusal never stops the rest, and every item gets
   * exactly one result, in input order.
   */
  async ingestBatch(params: {
    oxyUserId: string;
    platform: ImportPlatform;
    batchId: string;
    items: readonly ImportItemInput[];
  }): Promise<ImportItemResult[]> {
    const { oxyUserId, platform, batchId, items } = params;

    // ONE ledger read for every source id the batch names — its items and the
    // items they reply to or quote. Kept current as items are created, so a
    // later item finds an earlier one without another query.
    const referenced = items.flatMap((item) => [
      item.sourceId,
      ...(item.replyToSourceId ? [item.replyToSourceId] : []),
      ...(item.quoteSourceId ? [item.quoteSourceId] : []),
    ]);
    const known = new Map<string, string>();
    for (const [sourceId, row] of await findImportsBySourceIds(oxyUserId, platform, referenced)) {
      known.set(sourceId, row.postId);
    }

    // ONE Oxy round trip for every asset in the batch. A failed lookup fails the
    // items that carry media — never silently attaches an asset nobody checked.
    const assetIds = items.flatMap((item) => item.media.map((media) => media.assetId));
    let assets: Awaited<ReturnType<typeof mediaMetadataService.resolveOxyAssets>> | null = new Map();
    if (assetIds.length > 0) {
      try {
        assets = await mediaMetadataService.resolveOxyAssets(assetIds);
        if ([...assets.values()].some((asset) => asset.ownerUserId === undefined)) {
          // Only an internal-tier service token is told the owner; without it
          // every media item fails `media_not_owned`, which is a deploy fault.
          logger.warn('[PostImport] Oxy did not report asset owners; media items will fail', {
            count: assetIds.length,
          });
        }
      } catch (error) {
        logger.warn('[PostImport] asset metadata lookup failed; media items will fail', {
          error: error instanceof Error ? error.message : String(error),
          count: assetIds.length,
        });
        assets = null;
      }
    }

    const results: ImportItemResult[] = [];
    for (const item of items) {
      const existing = known.get(item.sourceId);
      if (existing) {
        results.push({ sourceId: item.sourceId, status: 'existing', postId: existing });
        continue;
      }
      try {
        const result = await this.importItem({ oxyUserId, platform, batchId, item, known, assets });
        if (result.postId) known.set(item.sourceId, result.postId);
        results.push(result);
      } catch (error) {
        if (error instanceof ImportItemRefusal) {
          results.push({ sourceId: item.sourceId, status: 'failed', error: error.code });
          continue;
        }
        logger.error('[PostImport] item failed', {
          platform,
          sourceId: item.sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
        results.push({ sourceId: item.sourceId, status: 'failed', error: 'internal_error' });
      }
    }
    return results;
  }

  private async importItem(ctx: {
    oxyUserId: string;
    platform: ImportPlatform;
    batchId: string;
    item: ImportItemInput;
    known: ReadonlyMap<string, string>;
    assets: ReadonlyMap<string, { mime: string; status: string; ownerUserId?: string | null }> | null;
  }): Promise<ImportItemResult> {
    const { oxyUserId, platform, batchId, item, known, assets } = ctx;

    if (item.createdAt.getTime() > Date.now() + MAX_FUTURE_SKEW_MS) {
      throw new ImportItemRefusal('created_at_in_future');
    }

    // A reference to an item that is not here yet DEFERS, never degrades: once
    // a post is created as a root it cannot become a reply later, so guessing
    // would make the thread wrong for good.
    let parentPostId: string | null = null;
    let threadId: string | null = null;
    if (item.replyToSourceId) {
      const parentId = known.get(item.replyToSourceId);
      if (!parentId) return { sourceId: item.sourceId, status: 'deferred', error: 'parent_not_imported' };
      const parent = await loadPostRecord(parentId);
      if (!parent) return { sourceId: item.sourceId, status: 'deferred', error: 'parent_not_imported' };
      parentPostId = parent.id;
      // A reply to one's own post is a thread continuation, joined exactly the
      // way `POST /posts/thread` joins one: every entry carries the root's id,
      // and so does the root.
      threadId = parent.threadId ?? parent.id;
      if (!parent.threadId && !parent.parentPostId) {
        await updatePostRecord(parent.id, { threadId: parent.id });
      }
    }
    let quoteOf: string | null = null;
    if (item.quoteSourceId) {
      const quotedId = known.get(item.quoteSourceId);
      if (!quotedId) return { sourceId: item.sourceId, status: 'deferred', error: 'quote_not_imported' };
      quoteOf = quotedId;
    }

    const media: MediaItem[] = [];
    if (item.media.length > 0) {
      if (!assets) throw new ImportItemRefusal('media_lookup_failed');
      for (const entry of item.media) {
        const asset = assets.get(entry.assetId);
        if (!asset || asset.status !== 'active') throw new ImportItemRefusal('media_not_found');
        // An asset id is not a capability: Move may only attach the acting
        // user's own uploads. Oxy reports the owner to internal apps only, so
        // an absent owner (`undefined`) is unverifiable and refused too, as is
        // a system-owned file (`null`).
        if (asset.ownerUserId !== oxyUserId) throw new ImportItemRefusal('media_not_owned');
        const type = mediaTypeFromMime(asset.mime);
        if (!type) throw new ImportItemRefusal('media_unsupported');
        const alt = normalizeAltInput(entry.alt);
        media.push({ id: entry.assetId, type, mime: asset.mime, ...(alt ? { alt } : {}) });
      }
    }

    const text = composeBody(item.text, item.links);
    if (text.length > config.posts.maxTextLength) throw new ImportItemRefusal('text_too_long');

    const preparedArticle = prepareArticle(item.article, oxyUserId);
    if (text.trim().length === 0 && media.length === 0 && !preparedArticle) {
      throw new ImportItemRefusal('empty');
    }

    const content: PostContent = { text, media };
    if (preparedArticle) content.article = preparedArticle.content;
    // The same order `buildOrderedAttachments` gives a composer that sent none:
    // the article block, then the media in the order the source had them.
    const attachments = [
      ...(preparedArticle ? [{ type: 'article' as const }] : []),
      ...media.map((entry) => ({ type: 'media' as const, id: entry.id, mediaType: entry.type })),
    ];
    if (attachments.length > 0) content.attachments = attachments;

    const contentWarning = item.contentWarning?.trim() || undefined;

    const post = await postCreationService.create({
      oxyUserId,
      content,
      visibility: item.visibility,
      parentPostId,
      threadId,
      quoteOf,
      hashtags: mergeHashtags(text),
      mentions: [],
      neutralizeMentions: true,
      ...(item.language ? { language: item.language, languages: [item.language] } : {}),
      status: 'published',
      // A content warning gates the body; the flag is what federates (AP
      // `sensitive`), and the label itself is rendered from the ledger row.
      ...(contentWarning ? { metadata: { isSensitive: true } } : {}),
      createdAt: item.createdAt,
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
    });

    // The post and its ledger row are two writes: without the row the post is
    // invisible to dedupe and undo, so it never outlives a failed insert.
    const removePost = () => deleteAuthoredPost(post.id, oxyUserId).catch((error: unknown) => {
      logger.error('[PostImport] failed to remove an unrecorded import', {
        postId: post.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    let recorded: boolean;
    try {
      recorded = await insertPostImport({
        postId: post.id,
        oxyUserId,
        platform,
        sourceId: item.sourceId,
        sourceUrl: item.sourceUrl,
        contentWarning: contentWarning ?? null,
        importBatchId: batchId,
      });
    } catch (error) {
      await removePost();
      throw error;
    }
    if (!recorded) {
      // A concurrent send of the SAME item recorded it first: ours is the duplicate.
      await removePost();
      const winner = (await findImportsBySourceIds(oxyUserId, platform, [item.sourceId])).get(item.sourceId);
      return winner
        ? { sourceId: item.sourceId, status: 'existing', postId: winner.postId }
        : { sourceId: item.sourceId, status: 'failed', error: 'internal_error' };
    }

    await persistPreparedArticle(preparedArticle, post.id, 'Failed to save imported article content');
    return { sourceId: item.sourceId, status: 'created', postId: post.id };
  }

  /**
   * Delete every post `oxyUserId` imported in batch `batchId`, through the
   * normal delete path — so each public one sends its federated `Delete` and
   * its MTN tombstone, exactly as if the author had deleted it by hand.
   *
   * Newest first (see `findBatchPostIds`). A post that is already gone — removed
   * with a parent earlier in the walk, or deleted by the author — counts as
   * neither deleted nor failed.
   */
  async undoBatch(params: { oxyUserId: string; batchId: string }): Promise<{ deleted: number; failed: number }> {
    const postIds = await findBatchPostIds(params.oxyUserId, params.batchId);
    let deleted = 0;
    let failed = 0;
    for (const postId of postIds) {
      try {
        const removed = await deleteAuthoredPost(postId, params.oxyUserId);
        if (removed) deleted += 1;
      } catch (error) {
        failed += 1;
        logger.error('[PostImport] undo could not delete a post', {
          postId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { deleted, failed };
  }

  /**
   * What Mention already holds for a set of source items: the ones this user
   * imported, and — by AS2 object id or at-uri — the federated copies of their
   * old account's posts that federation ingested before they moved.
   *
   * The federated half only REPORTS; adopting such a copy as the user's own is
   * a later step (it needs a verified `Move` of the old actor).
   */
  async lookup(params: {
    oxyUserId: string;
    platform: ImportPlatform;
    sourceIds: readonly string[];
    federatedIds: readonly string[];
  }): Promise<ImportLookupResult> {
    const [imports, copies] = await Promise.all([
      findImportsBySourceIds(params.oxyUserId, params.platform, params.sourceIds),
      findFederatedCopies(params.federatedIds),
    ]);
    const imported: ImportLookupResult['imported'] = {};
    for (const [sourceId, row] of imports) imported[sourceId] = row.postId;
    const federated: ImportLookupResult['federated'] = {};
    for (const copy of copies) {
      federated[copy.activityId] = {
        postId: copy.postId,
        actorUri: copy.actorUri,
        url: copy.url,
        oxyUserId: copy.oxyUserId,
      };
    }
    return { imported, federated };
  }
}

export const postImportService = new PostImportService();
