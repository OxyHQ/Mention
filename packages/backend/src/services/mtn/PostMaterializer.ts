/**
 * MTN PostMaterializer — projects a VERIFIED signed `app.mention.feed.*` record
 * into the feed-readable Mongo store (the same `Post` / `Like` / `Bookmark` rows
 * the hot read path already reads).
 *
 * This is the READ-side dual of the write emitter (`MentionRecordEmitter`): the
 * emitter turns a native Mongo write into a signed record; the materializer turns
 * a signed record back into the native Mongo rows. The two together let the chain
 * become the source of truth in a later phase (B3+) — but in B2 the materializer
 * is NOT wired into the live create/like/boost path. It is invoked only by the
 * B2 backfill and (future) node ingest.
 *
 * CONTRACT:
 *  - IDEMPOTENT — every projection is keyed by the envelope's `rkey` (the Mongo
 *    `_id` of the post/like/etc.), so re-projecting the same record converges to
 *    the same row (no duplicates, stable classification). Re-runs are safe.
 *  - ZERO-REGRESSION — a post upsert uses a FIELD-SCOPED `$set` of only the fields
 *    the record owns (text, reply, tags, langs, sources, location, …). It NEVER
 *    replaces the whole document, and it only writes `content.media` when the
 *    embed RESOLVES to ≥1 renderable item (see below), so re-projecting an
 *    existing post whose `content.media` fileId items would not re-resolve KEEPS
 *    that media untouched. The authoritative native write path is unchanged; media
 *    rendering stays byte-identical (URLs are resolved by the existing
 *    `mediaResolver` at hydration time, exactly as for native fileId media).
 *  - READ-SIDE BLOB RESOLUTION — `record.embed` carries content-addressed blob
 *    refs (the WRITE side populates `embed[].blob.sha256` via the service SDK).
 *    The READ side turns each bare `sha256` back into a servable native MediaItem
 *    with the REVERSE content-address lookup `getServiceAssetMetadataBySha256`
 *    (core 5.2.0, `POST /assets/service/by-sha256`) — the inverse of the FORWARD
 *    `fileId → sha256` lookup the write side uses. {@link resolveRecordFileIds}
 *    maps each resolvable blob to `{ id: <resolved Oxy fileId>, type, alt? }`, so
 *    the materialized post's `content.media` renders through the EXISTING
 *    `getFileDownloadUrl` CDN path EXACTLY like a normal fileId post. FAIL-SOFT: a
 *    `sha256` with no live asset in our S3 is dropped (the upstream omits
 *    unknown/trashed hashes), so a record whose blobs are not yet mirrored yields
 *    fewer/zero items and never a fake URL. ZERO-REGRESSION GUARD: the post upsert
 *    only writes `content.media` when the resolver produced ≥1 item; an empty
 *    resolution leaves the field untouched, so the B2 round-trip (Mention's own
 *    records re-projected onto the SAME `rkey`) keeps its existing fileId media.
 *    This path matters for records INGESTED from a node whose blobs are
 *    content-addressed (the node-blob mirror in `MentionNodeSyncService` makes
 *    those blobs resolvable by `sha256` first).
 *  - NEVER THROWS — any failure (bad subject DID, invalid inner record, DB error)
 *    is wrapped and returned as `{ ok: false, reason }` so the backfill/ingest
 *    caller can log and continue. Validation runs FIRST: the inner `record` is
 *    parsed with the matching `mention*RecordSchema` before any projection.
 */

import mongoose from 'mongoose';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';
import {
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
  MENTION_BOOKMARK_COLLECTION,
  mentionPostRecordSchema,
  mentionLikeRecordSchema,
  mentionRepostRecordSchema,
  mentionTombstoneRecordSchema,
  mentionBookmarkRecordSchema,
  MtnUri,
  canonicalizeLanguageTag,
  toBaseLanguage,
  type MentionPostRecord,
  type MentionLikeRecord,
  type MentionRepostRecord,
  type MentionTombstoneRecord,
  type MentionBookmarkRecord,
  type MtnMediaEmbed,
  type MediaItem,
  type PostContentVariant,
} from '@mention/shared-types';
import { PostType, PostVisibility } from '@mention/shared-types';
import { Post, POST_CLASSIFICATION_PENDING } from '../../models/Post';
import Like from '../../models/Like';
import Bookmark from '../../models/Bookmark';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { parseUserDid } from './mentionDid';
import { baselineContentClassifier } from '../BaselineContentClassifier';
import { buildAuthorship } from '../../utils/postAuthorship';

/** The kind of native row a successful projection produced/removed. */
export type ProjectedKind = 'post' | 'like' | 'repost' | 'tombstone' | 'bookmark';

/**
 * The outcome of {@link projectRecord}. Discriminates a successful projection
 * (with the affected row id) from a no-op/failure (with a machine-readable
 * reason). NEVER an exception — the caller logs `reason` and continues.
 */
export type ProjectResult =
  | { ok: true; kind: ProjectedKind; id: string }
  | { ok: false; reason: string };

/**
 * Reverse-resolve EVERY content address a post record references — the shared
 * `embed`, each variant's media override, and the blob keys of each variant's
 * localized `alt` map — into live Oxy file ids, in ONE batched lookup however
 * many languages the record carries.
 *
 * The lookup is `getServiceAssetMetadataBySha256` (core 5.2.0, `POST
 * /assets/service/by-sha256`) — the inverse of the write side's forward
 * `fileId → sha256`. Each resolved blob becomes a `MediaItem` whose `id` is the
 * Oxy fileId, so a materialized post renders through the EXISTING
 * `getFileDownloadUrl`/`mediaResolver` CDN path exactly like a native fileId
 * post — no new render path, no fake URL.
 *
 * Only `active` assets are renderable; a `trash`ed one is treated as
 * unresolvable rather than linked to a dead file. FAIL-SOFT — NEVER THROWS: a
 * blob with no live asset here (unknown/trashed — the upstream omits it from the
 * batch) is DROPPED, and any lookup error (e.g. a `files:read`-scope 403 on the
 * federation credential) yields an empty index. Every downstream resolution then
 * degrades to "no media" and projection continues; the caller skips the empty
 * write, so an existing post's media survives (zero-regression guard).
 */
async function resolveRecordFileIds(record: MentionPostRecord): Promise<Map<string, string>> {
  const sha256s = new Set<string>();

  const collectEmbed = (embed: MtnMediaEmbed | undefined): void => {
    if (!embed || !Array.isArray(embed.items)) return;
    for (const item of embed.items) {
      const sha256 = item.blob?.sha256;
      if (typeof sha256 === 'string' && sha256.length > 0) sha256s.add(sha256);
    }
  };

  collectEmbed(record.embed);
  for (const variant of record.variants ?? []) {
    collectEmbed(variant.embed);
    for (const sha256 of Object.keys(variant.alt ?? {})) {
      if (sha256.length > 0) sha256s.add(sha256);
    }
  }

  if (sha256s.size === 0) return new Map();

  try {
    const metadata = await getServiceOxyClient().getServiceAssetMetadataBySha256([...sha256s]);
    const fileIdBySha256 = new Map<string, string>();
    for (const entry of metadata) {
      if (entry.status === 'active' && typeof entry.id === 'string' && entry.id.length > 0) {
        fileIdBySha256.set(entry.sha256, entry.id);
      }
    }
    return fileIdBySha256;
  } catch (error) {
    // Best-effort: a failed reverse lookup must never abort projection.
    logger.warn('PostMaterializer: content-address lookup failed; projecting without record media', {
      sha256Count: sha256s.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Map();
  }
}

/**
 * Project a record's body back onto native `content.variants` — the post's ONLY
 * body storage. Every variant on the chain is authored by definition (a machine
 * translation is never signed), so they all materialize as `source:'author'`.
 *
 * TWO SHAPES, one output:
 *  - A MULTILINGUAL record carries `variants[]`, each with its own tag.
 *  - A MONOLINGUAL record carries none — its single body is the record's primary
 *    `text`, tagged by `langs[0]`. Emitting a one-entry `variants` array on the
 *    wire would just be a second copy of `text`, so the writer omits it and this
 *    reader reconstitutes it. That is also the DEGRADATION path: a record written
 *    by a reader that never heard of `variants` still materializes a complete,
 *    correctly-tagged post from `text` + `langs` alone.
 *
 * The body may end up UNTAGGED (no `langs`, or an unusable one). That is a real
 * state, not a failure: the post is text nobody could assign a language to.
 *
 * The `alt` map is re-keyed from blob `sha256` (what the chain speaks) back to
 * the Oxy media id (what the renderer speaks); an entry whose blob is not
 * mirrored here is dropped rather than left pointing at a key no renderer can
 * match. `alt` and `media` are mutually exclusive by the content model, so a
 * (malformed) record carrying both keeps the media override and drops the alt
 * map — never two sources of truth for one alt text.
 *
 * A variant whose media override resolves to NOTHING (its blobs are not mirrored
 * here yet) is materialized WITHOUT a media set, so it inherits the shared one.
 * Inheriting the post's real images beats rendering a variant with none.
 */
function buildVariantsFromRecord(
  record: MentionPostRecord,
  fileIdBySha256: Map<string, string>,
  createdAt: Date,
): PostContentVariant[] {
  const variants: PostContentVariant[] = [];
  const createdAtIso = createdAt.toISOString();

  // Monolingual record: rebuild the single primary rendition from `text`+`langs`.
  if (!record.variants || record.variants.length === 0) {
    const text = typeof record.text === 'string' ? record.text : '';
    // An empty body has no rendition at all (a boost) — not an empty one.
    if (text.length === 0) return [];
    const primary: PostContentVariant = { source: 'author', text, createdAt: createdAtIso };
    const tag = canonicalizeLanguageTag(record.langs?.[0]);
    if (tag !== null) primary.tag = tag;
    return [primary];
  }

  for (const source of record.variants) {
    const tag = canonicalizeLanguageTag(source.tag);
    if (tag === null || typeof source.text !== 'string') continue;

    const variant: PostContentVariant = {
      tag,
      source: 'author',
      text: source.text,
      createdAt: createdAtIso,
    };

    const media = resolveEmbedItemsToMedia(source.embed, fileIdBySha256);
    if (media.length > 0) {
      variant.media = media;
    } else if (source.alt) {
      const alt: Record<string, string> = {};
      for (const [sha256, text] of Object.entries(source.alt)) {
        if (typeof text !== 'string' || text.length === 0) continue;
        const fileId = fileIdBySha256.get(sha256);
        if (!fileId) continue;
        alt[fileId] = text;
      }
      if (Object.keys(alt).length > 0) variant.alt = alt;
    }

    if (source.article) {
      const article: NonNullable<PostContentVariant['article']> = {};
      if (source.article.title) article.title = source.article.title;
      if (source.article.body) article.body = source.article.body;
      if (source.article.excerpt) article.excerpt = source.article.excerpt;
      if (Object.keys(article).length > 0) variant.article = article;
    }

    variants.push(variant);
  }

  return variants;
}

/**
 * The synchronous core of the blob → MediaItem mapping, shared by the shared
 * embed and every variant override (the network lookup already happened once, in
 * {@link resolveRecordFileIds}).
 */
function resolveEmbedItemsToMedia(
  embed: MtnMediaEmbed | undefined,
  fileIdBySha256: Map<string, string>,
): MediaItem[] {
  if (!embed || !Array.isArray(embed.items) || embed.items.length === 0) return [];

  const media: MediaItem[] = [];
  for (const item of embed.items) {
    const blob = item.blob;
    if (!blob || typeof blob.sha256 !== 'string' || blob.sha256.length === 0) continue;
    const fileId = fileIdBySha256.get(blob.sha256);
    if (!fileId) continue;
    const resolved: MediaItem = { id: fileId, type: blob.mediaType };
    if (typeof item.alt === 'string' && item.alt.length > 0) {
      resolved.alt = item.alt;
    }
    media.push(resolved);
  }
  return media;
}

/**
 * Recover the Mongo `_id` (rkey) of the post referenced by an MTN URI. Returns
 * `null` when the URI is not a parseable MTN URI.
 */
function rkeyFromMtnUri(uri: string): string | null {
  if (!MtnUri.isValid(uri)) return null;
  try {
    return MtnUri.parse(uri).rkey;
  } catch {
    return null;
  }
}

/** Coerce an rkey string to an ObjectId, or `null` when it is not a valid id. */
function toObjectId(rkey: string): mongoose.Types.ObjectId | null {
  if (!mongoose.Types.ObjectId.isValid(rkey)) return null;
  return new mongoose.Types.ObjectId(rkey);
}

/**
 * Build the Stage-A `postClassification` subdoc + primary `language` for a post
 * record, MIRRORING `PostCreationService.applyBaselineClassification` EXACTLY so
 * a materialized post's classification is identical to a natively-created one.
 *
 * Best-effort: the classifier is pure/synchronous, but any throw is caught so it
 * can never fail projection — the caller then leaves the schema-default
 * `{ status: 'pending' }` subdoc in place (mirrors PostCreationService).
 */
function buildClassificationFields(record: MentionPostRecord): Record<string, unknown> {
  try {
    const signals = baselineContentClassifier.classify({
      text: record.text,
      hashtags: record.tags,
      // The record's `langs[0]` is the primary; the full `langs` list is the
      // declared/authoritative set (same precedence the native path uses).
      language: record.langs?.[0],
      languages: record.langs,
      // A federated post never emits a record, so a materialized post is always
      // native: no `sensitive`/`instanceDomain` source flag to thread through.
    });

    const fields: Record<string, unknown> = {
      postClassification: {
        status: POST_CLASSIFICATION_PENDING,
        attempts: 0,
        topics: signals.topics,
        languages: signals.languages,
        region: signals.region,
        hashtagsNorm: signals.hashtagsNorm,
        sensitive: signals.sensitive,
        scores: signals.scores,
        version: signals.version,
        classifiedAt: new Date(signals.classifiedAt),
      },
    };

    // Keep the top-level AP `post.language` in sync with the resolved primary
    // (`languages[0]`), exactly as PostCreationService does.
    const primaryLanguage = signals.languages[0];
    if (primaryLanguage != null) {
      fields.language = primaryLanguage;
    }

    return fields;
  } catch (error) {
    // Never fail projection on classification — leave the default pending subdoc.
    logger.warn('PostMaterializer: baseline classification failed; projecting without Stage-A signals', error);
    return {};
  }
}

/**
 * Project an `app.mention.feed.post` record into a `Post` row, upserted by
 * `_id = rkey`. Only the fields the record OWNS are `$set` (text/reply/tags/…).
 * `content.media` is written ONLY when the record's content-addressed `embed`
 * RESOLVES to ≥1 live MediaItem ({@link resolveEmbedItemsToMedia}); an empty
 * resolution leaves the field untouched, so an existing post's fileId media
 * survives re-projection (zero-regression guard).
 */
async function projectPost(
  rkey: string,
  oxyUserId: string,
  record: MentionPostRecord,
  createdAt: Date,
): Promise<ProjectResult> {
  // Recover the reply context from the MTN reply ref. `threadId` is the reply
  // ROOT's rkey; `parentPostId` is the direct PARENT's rkey. A top-level post
  // (no reply) → both null.
  let parentPostId: string | null = null;
  let threadId: string | null = null;
  if (record.reply) {
    parentPostId = rkeyFromMtnUri(record.reply.parent);
    threadId = rkeyFromMtnUri(record.reply.root);
  }

  const tags = Array.isArray(record.tags) ? [...record.tags] : [];

  const set: Record<string, unknown> = {
    oxyUserId,
    authorship: buildAuthorship(oxyUserId, []),
    type: PostType.TEXT,
    hashtags: tags,
    parentPostId,
    threadId,
    createdAt,
  };

  // The top-level AP `post.language` is a BASE subtag (the classifier's alphabet),
  // while the record's `langs` are BCP-47 (`es-ES`). Normalize rather than storing
  // a regional tag in a field the ranking layer reads as a base code.
  const primaryBase = toBaseLanguage(record.langs?.[0]);
  if (primaryBase !== null) {
    set.language = primaryBase;
  }

  // ONE content-address lookup for the whole record: the shared embed, every
  // variant's media override, and the blob keys of every variant's `alt` map.
  const fileIdBySha256 = await resolveRecordFileIds(record);

  // `content.media`: reverse-resolve the content-addressed blob embed to native
  // fileId MediaItems. Only set the path when ≥1 blob resolved — an empty result
  // (no embed, or blobs not yet in our S3) is intentionally OMITTED so the upsert
  // never clobbers an existing post's fileId media to empty.
  const media = resolveEmbedItemsToMedia(record.embed, fileIdBySha256);
  if (media.length > 0) {
    set['content.media'] = media;
  }

  // The body — `content.variants` is its only home, and `variants[0]` is the
  // primary. Always written (even empty, for a bodiless record) so a re-projection
  // can never leave a stale rendition of a body the chain has since changed.
  set['content.variants'] = buildVariantsFromRecord(record, fileIdBySha256, createdAt);

  // `content.sources`: map the record's source links to the native shape.
  if (Array.isArray(record.sources) && record.sources.length > 0) {
    set['content.sources'] = record.sources.map((s) =>
      s.title ? { url: s.url, title: s.title } : { url: s.url },
    );
  }

  // `content.location`: a GeoJSON Point, when present on the record.
  if (record.location) {
    set['content.location'] = {
      type: 'Point',
      coordinates: [record.location.coordinates[0], record.location.coordinates[1]],
    };
  }

  await Post.findByIdAndUpdate(
    rkey,
    {
      $set: set,
      $setOnInsert: { visibility: PostVisibility.PUBLIC, status: 'published' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  // Re-derive the Stage-A classification from the SAME inputs the native path
  // uses, and write it with a dotted `$set` (so it overwrites the whole subdoc
  // + the top-level primary language without touching unrelated fields).
  const classificationFields = buildClassificationFields(record);
  if (Object.keys(classificationFields).length > 0) {
    await Post.findByIdAndUpdate(rkey, { $set: classificationFields });
  }

  return { ok: true, kind: 'post', id: rkey };
}

/** Project an `app.mention.feed.like` record into a `Like` row (upsert by _id). */
async function projectLike(
  rkey: string,
  userId: string,
  record: MentionLikeRecord,
): Promise<ProjectResult> {
  const likedRkey = rkeyFromMtnUri(record.subject);
  if (!likedRkey) return { ok: false, reason: 'unresolvable_like_subject' };
  const postId = toObjectId(likedRkey);
  if (!postId) return { ok: false, reason: 'invalid_like_post_id' };

  await Like.findByIdAndUpdate(
    rkey,
    { $set: { userId, postId, value: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { ok: true, kind: 'like', id: rkey };
}

/**
 * Project an `app.mention.feed.repost` record into a `type: 'boost'` Post row
 * (upsert by `_id = rkey`). A boost has an INTENTIONALLY EMPTY content body and
 * relies on `boostOf` for hydration (see the boost-hydration gotcha).
 *
 * "Empty body" now means NO RENDITION — an empty `content.variants`, not a
 * rendition whose text happens to be `''`. A boost has nothing to say in any
 * language, so there is nothing to tag.
 */
async function projectRepost(
  rkey: string,
  oxyUserId: string,
  record: MentionRepostRecord,
  createdAt: Date,
): Promise<ProjectResult> {
  const boostOf = rkeyFromMtnUri(record.subject);
  if (!boostOf) return { ok: false, reason: 'unresolvable_repost_subject' };

  await Post.findByIdAndUpdate(
    rkey,
    {
      $set: {
        oxyUserId,
        authorship: buildAuthorship(oxyUserId, []),
        type: PostType.BOOST,
        boostOf,
        'content.variants': [],
        createdAt,
      },
      $setOnInsert: { visibility: PostVisibility.PUBLIC, status: 'published' },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { ok: true, kind: 'repost', id: rkey };
}

/** Project an `app.mention.feed.bookmark` record into a `Bookmark` row (upsert). */
async function projectBookmark(
  rkey: string,
  userId: string,
  record: MentionBookmarkRecord,
): Promise<ProjectResult> {
  const bookmarkedRkey = rkeyFromMtnUri(record.subject);
  if (!bookmarkedRkey) return { ok: false, reason: 'unresolvable_bookmark_subject' };
  const postId = toObjectId(bookmarkedRkey);
  if (!postId) return { ok: false, reason: 'invalid_bookmark_post_id' };

  await Bookmark.findByIdAndUpdate(
    rkey,
    { $set: { userId, postId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  return { ok: true, kind: 'bookmark', id: rkey };
}

/**
 * Project an `app.mention.feed.tombstone` record: soft-remove the row referenced
 * by `record.subject`. The codebase removes these by HARD delete (delete-post is
 * `Post.findOneAndDelete`, unlike is `Like.findOneAndDelete`, unsave is
 * `Bookmark.findOneAndDelete`), so the materializer mirrors that. The subject's
 * COLLECTION selects which model to delete from. Idempotent: removing an
 * already-removed row is a no-op (still `ok`).
 */
async function projectTombstone(record: MentionTombstoneRecord): Promise<ProjectResult> {
  if (!MtnUri.isValid(record.subject)) {
    return { ok: false, reason: 'unresolvable_tombstone_subject' };
  }
  let subject: MtnUri;
  try {
    subject = MtnUri.parse(record.subject);
  } catch {
    return { ok: false, reason: 'unresolvable_tombstone_subject' };
  }

  const rkey = subject.rkey;

  switch (subject.collection) {
    case MENTION_POST_COLLECTION:
    case MENTION_REPOST_COLLECTION:
      // A post or boost: delete the Post by id (mirrors delete-post's hard
      // delete). Idempotent — a missing row deletes nothing.
      await Post.findByIdAndDelete(rkey);
      return { ok: true, kind: 'tombstone', id: rkey };
    case MENTION_LIKE_COLLECTION:
      await Like.findByIdAndDelete(rkey);
      return { ok: true, kind: 'tombstone', id: rkey };
    case MENTION_BOOKMARK_COLLECTION:
      await Bookmark.findByIdAndDelete(rkey);
      return { ok: true, kind: 'tombstone', id: rkey };
    default:
      return { ok: false, reason: 'unsupported_tombstone_subject_collection' };
  }
}

/**
 * Project a VERIFIED `app.mention.feed.*` signed record into the feed-readable
 * Mongo store. Idempotent (keyed by `rkey`), zero-regression (field-scoped post
 * upsert preserves existing media), and NEVER throws — every failure is returned
 * as `{ ok: false, reason }`.
 *
 * The caller MUST pass a record whose signature/chain has already been verified
 * (by the protocol engine on the ingest/backfill side); this function validates
 * only the inner `record` PAYLOAD shape against the matching lexicon schema.
 *
 * @param envelope A verified v2 envelope with `collection`/`rkey`/`subject`/`record`.
 */
export async function projectRecord(envelope: SignedRecordEnvelope): Promise<ProjectResult> {
  try {
    const { collection, rkey, subject, record } = envelope;

    if (typeof collection !== 'string' || typeof rkey !== 'string' || rkey.length === 0) {
      return { ok: false, reason: 'missing_record_key' };
    }

    // The subject DID identifies the chain owner (the author / liker / bookmarker).
    // A non-parseable subject DID is a clear no-op (we cannot key a native row).
    const oxyUserId = parseUserDid(subject);
    if (!oxyUserId) {
      return { ok: false, reason: 'unresolvable_subject_did' };
    }

    switch (collection) {
      case MENTION_POST_COLLECTION: {
        const parsed = mentionPostRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectPost(rkey, oxyUserId, parsed.data, new Date(parsed.data.createdAt));
      }
      case MENTION_LIKE_COLLECTION: {
        const parsed = mentionLikeRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectLike(rkey, oxyUserId, parsed.data);
      }
      case MENTION_REPOST_COLLECTION: {
        const parsed = mentionRepostRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectRepost(rkey, oxyUserId, parsed.data, new Date(parsed.data.createdAt));
      }
      case MENTION_TOMBSTONE_COLLECTION: {
        const parsed = mentionTombstoneRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectTombstone(parsed.data);
      }
      case MENTION_BOOKMARK_COLLECTION: {
        const parsed = mentionBookmarkRecordSchema.safeParse(record);
        if (!parsed.success) return { ok: false, reason: 'invalid_record' };
        return await projectBookmark(rkey, oxyUserId, parsed.data);
      }
      default:
        return { ok: false, reason: 'unsupported_collection' };
    }
  } catch (error) {
    logger.error('PostMaterializer: projectRecord failed', {
      collection: envelope.collection,
      rkey: envelope.rkey,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: 'error' };
  }
}
