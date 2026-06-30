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
 *    `fileId → sha256` lookup the write side uses. {@link resolveEmbedToMedia}
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
  type MentionPostRecord,
  type MentionLikeRecord,
  type MentionRepostRecord,
  type MentionTombstoneRecord,
  type MentionBookmarkRecord,
  type MtnMediaEmbed,
  type MediaItem,
} from '@mention/shared-types';
import { PostType, PostVisibility } from '@mention/shared-types';
import { Post, POST_CLASSIFICATION_PENDING } from '../../models/Post';
import Like from '../../models/Like';
import Bookmark from '../../models/Bookmark';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { parseUserDid } from './mentionDid';
import { baselineContentClassifier } from '../BaselineContentClassifier';

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
 * Resolve a record `embed` (content-addressed blob refs) to native
 * `content.media` MediaItems by REVERSE content-address lookup.
 *
 * Each `embed.items[].blob.sha256` is batch-resolved through the service-scoped
 * SDK's `getServiceAssetMetadataBySha256` (core 5.2.0, `POST
 * /assets/service/by-sha256`) — the inverse of the write side's forward
 * `fileId → sha256` lookup. Every blob that resolves to a LIVE (`status:'active'`)
 * asset becomes a `MediaItem` whose `id` is the resolved Oxy `fileId` and whose
 * `type` is the lexicon `mediaType` (the two enums are identical), preserving the
 * embed's order and `alt` text. The materialized post's `content.media` then
 * renders through the EXISTING `getFileDownloadUrl`/`mediaResolver` CDN path
 * exactly like a normal fileId post — no new render path, no fake URL.
 *
 * FAIL-SOFT — NEVER THROWS:
 *  - No embed / empty items → `[]` (the caller then leaves `content.media`
 *    untouched, preserving any existing fileId media).
 *  - A `sha256` with no live asset in our S3 (unknown/trashed — the upstream
 *    omits these from the batch) is simply DROPPED, never placeholdered with a
 *    guessed URL. A record whose blobs are not yet mirrored yields fewer/zero
 *    items rather than failing.
 *  - Any lookup error (e.g. a `files:read`-scope 403 on the federation
 *    credential) is logged and yields `[]`, so a media-resolution failure can
 *    never abort projection.
 */
async function resolveEmbedToMedia(embed: MtnMediaEmbed | undefined): Promise<MediaItem[]> {
  if (!embed || !Array.isArray(embed.items) || embed.items.length === 0) {
    return [];
  }

  // Collect the distinct content addresses to resolve (preserve item order for
  // the output; the lookup itself is order-independent and deduped).
  const sha256s = Array.from(
    new Set(
      embed.items
        .map((item) => item.blob?.sha256)
        .filter((sha): sha is string => typeof sha === 'string' && sha.length > 0),
    ),
  );
  if (sha256s.length === 0) {
    return [];
  }

  try {
    const metadata = await getServiceOxyClient().getServiceAssetMetadataBySha256(sha256s);
    // sha256 → live fileId. Only `active` assets are renderable; a `trash` asset
    // is dropped (treated as unresolvable) rather than linked to a dead file.
    const fileIdBySha = new Map<string, string>();
    for (const entry of metadata) {
      if (entry.status === 'active' && typeof entry.id === 'string' && entry.id.length > 0) {
        fileIdBySha.set(entry.sha256, entry.id);
      }
    }

    const media: MediaItem[] = [];
    for (const item of embed.items) {
      const sha = item.blob?.sha256;
      if (typeof sha !== 'string' || sha.length === 0) continue;
      const fileId = fileIdBySha.get(sha);
      // Unresolvable blob (not in our S3 / trashed): drop it — no fake URL.
      if (!fileId) continue;
      const resolved: MediaItem = { id: fileId, type: item.blob.mediaType };
      if (typeof item.alt === 'string' && item.alt.length > 0) {
        resolved.alt = item.alt;
      }
      media.push(resolved);
    }
    return media;
  } catch (error) {
    // Best-effort: a failed reverse lookup must never abort projection. Leave the
    // post's existing media untouched (the caller skips the empty write).
    logger.warn('PostMaterializer: resolveEmbedToMedia failed; projecting without record media', {
      sha256Count: sha256s.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
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
 * RESOLVES to ≥1 live MediaItem ({@link resolveEmbedToMedia}); an empty
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
    type: PostType.TEXT,
    'content.text': record.text ?? '',
    hashtags: tags,
    parentPostId,
    threadId,
    createdAt,
  };

  if (record.langs?.[0]) {
    set.language = record.langs[0];
  }

  // `content.media`: reverse-resolve the content-addressed blob embed to native
  // fileId MediaItems. Only set the path when ≥1 blob resolved — an empty result
  // (no embed, or blobs not yet in our S3) is intentionally OMITTED so the upsert
  // never clobbers an existing post's fileId media to empty.
  const media = await resolveEmbedToMedia(record.embed);
  if (media.length > 0) {
    set['content.media'] = media;
  }

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
        type: PostType.BOOST,
        boostOf,
        'content.text': '',
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
