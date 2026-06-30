/**
 * MTN record builders — map Mention's native shapes to `app.mention.feed.*`
 * lexicon payloads (the signed `record` body).
 *
 * The builders themselves are PURE functions: every input is passed in (no DB
 * access) so they are trivially unit-testable and never add I/O to the
 * dual-write side-effect path. The payloads are the wire projection of a native
 * row — they intentionally carry ONLY the fields the lexicon defines, validated
 * by the matching `mention*RecordSchema` before signing.
 *
 * MEDIA EMBED — content addressing: post media is stored on the Post by Oxy file
 * `id`, but the lexicon `embed.blob.sha256` is a CONTENT address. {@link
 * resolvePostMediaEmbed} (the ONE I/O step in this module) resolves each media
 * item's `fileId → sha256` via the service-scoped Oxy SDK, then `buildPostRecord`
 * folds the resolved `embed` in. The lookup is fail-soft: when it errors (e.g. the
 * Mention federation credential lacks the `files:read` scope), the resolver
 * yields no embed and the record is emitted WITHOUT media — the dual-write stays
 * best-effort and a missing blob never blocks the post.
 */

import type { IPost } from '../../models/Post';
import {
  createPostUri,
  type MentionPostRecord,
  type MentionLikeRecord,
  type MentionRepostRecord,
  type MentionTombstoneRecord,
  type MentionBookmarkRecord,
  type MtnFacet,
  type MtnMediaEmbed,
  type MtnEmbedMediaItem,
  type MtnReplyRef,
  type MtnSourceLink,
  type MtnGeoPoint,
} from '@mention/shared-types';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';

/** A post's reply context with the OWNER oxyUserId of the referenced posts. */
export interface ReplyContext {
  /** The thread root post id and its owner oxyUserId. */
  root: { postId: string; oxyUserId: string };
  /** The direct parent post id and its owner oxyUserId. */
  parent: { postId: string; oxyUserId: string };
}

function toIso(value: string | Date | undefined): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function buildReplyRef(reply: ReplyContext | undefined): MtnReplyRef | undefined {
  if (!reply) return undefined;
  return {
    root: createPostUri(reply.root.oxyUserId, reply.root.postId),
    parent: createPostUri(reply.parent.oxyUserId, reply.parent.postId),
  };
}

function buildSources(post: IPost): MtnSourceLink[] | undefined {
  const sources = post.content?.sources;
  if (!Array.isArray(sources) || sources.length === 0) return undefined;
  return sources.map((s) => (s.title ? { url: s.url, title: s.title } : { url: s.url }));
}

function buildLocation(post: IPost): MtnGeoPoint | undefined {
  const loc = post.content?.location;
  if (!loc || loc.type !== 'Point' || !Array.isArray(loc.coordinates) || loc.coordinates.length !== 2) {
    return undefined;
  }
  return { type: 'Point', coordinates: [loc.coordinates[0], loc.coordinates[1]] };
}

function buildLangs(post: IPost): string[] | undefined {
  // Prefer the canonical multi-language classification set when present, else the
  // single top-level AP `post.language`.
  const classified = post.postClassification?.languages;
  if (Array.isArray(classified) && classified.length > 0) {
    return [...classified];
  }
  return post.language ? [post.language] : undefined;
}

/** Map a native MediaItem `type` to the lexicon blob `mediaType` (same enum). */
const MEDIA_TYPE_TO_BLOB_KIND: Record<'image' | 'video' | 'gif', MtnEmbedMediaItem['blob']['mediaType']> = {
  image: 'image',
  video: 'video',
  gif: 'gif',
};

/**
 * A bare Oxy file id is a content-addressable upload. Skip client-side temp ids
 * and absolute URLs (federated/external media has no Oxy `sha256`) — mirrors the
 * `ensureProfileMediaPublic` guard. A local-authored post (the only kind that
 * emits a record) carries real Oxy file ids, but this stays defensive.
 */
function isResolvableFileId(id: string | undefined): id is string {
  return typeof id === 'string' && id.length > 0 && !id.startsWith('temp-') && !/^https?:\/\//i.test(id);
}

/**
 * Resolve a post's native `content.media` (Oxy file ids) into a lexicon media
 * `embed` whose blobs are CONTENT-addressed by `sha256`, via the service-scoped
 * SDK's `getServiceAssetMetadataByIds` (one batched call per post).
 *
 * FAIL-SOFT: any error (notably a `files:read`-scope 403 on the Mention
 * federation credential) or an empty/unresolvable media set yields `undefined`
 * so `buildPostRecord` emits the record WITHOUT an embed. The signed record is
 * always honest — it never carries a fileId where a `sha256` belongs — and the
 * dual-write stays best-effort: a missing blob NEVER blocks the post.
 */
export async function resolvePostMediaEmbed(post: IPost): Promise<MtnMediaEmbed | undefined> {
  const media = post.content?.media;
  if (!Array.isArray(media) || media.length === 0) return undefined;

  // Only bare Oxy file ids are content-addressable; preserve order for the embed.
  const resolvable = media.filter((m) => isResolvableFileId(m?.id));
  const fileIds = resolvable.map((m) => m.id);
  if (fileIds.length === 0) return undefined;

  try {
    const metadata = await getServiceOxyClient().getServiceAssetMetadataByIds(fileIds);
    const sha256ById = new Map(metadata.map((m) => [m.id, m]));

    const items: MtnEmbedMediaItem[] = [];
    for (const m of resolvable) {
      const meta = sha256ById.get(m.id);
      // Skip an item whose sha256 did not resolve (a failed/trashed asset) rather
      // than emit a partial/dishonest blob.
      if (!meta || typeof meta.sha256 !== 'string' || meta.sha256.length === 0) continue;
      const blob: MtnEmbedMediaItem['blob'] = {
        sha256: meta.sha256,
        mediaType: MEDIA_TYPE_TO_BLOB_KIND[m.type],
      };
      if (typeof meta.mime === 'string' && meta.mime.length > 0) blob.mime = meta.mime;
      if (typeof meta.size === 'number' && Number.isFinite(meta.size) && meta.size >= 0) blob.size = meta.size;
      const item: MtnEmbedMediaItem = { blob };
      if (typeof m.alt === 'string' && m.alt.length > 0) item.alt = m.alt;
      items.push(item);
    }

    if (items.length === 0) return undefined;
    return { type: 'media', items };
  } catch (error) {
    // Best-effort: a failed asset-metadata lookup must never block emitting the
    // record. The federation credential may not yet have the `files:read` scope.
    logger.warn('mentionRecordBuilders: resolvePostMediaEmbed failed; emitting record without media embed', {
      postId: String(post._id),
      mediaCount: fileIds.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * Build an `app.mention.feed.post` record payload from a native Post.
 *
 * `facets` is accepted explicitly (Mention does not yet store byte-range facets
 * on the Post; the caller passes them when available). `embed` is the pre-resolved
 * content-addressed media embed from {@link resolvePostMediaEmbed} — the only
 * field requiring an Oxy lookup, so it is resolved by the (async) caller and
 * passed in to keep this builder pure.
 */
export function buildPostRecord(
  post: IPost,
  options: { reply?: ReplyContext; facets?: MtnFacet[]; embed?: MtnMediaEmbed } = {},
): MentionPostRecord {
  const record: MentionPostRecord = {
    text: post.content?.text ?? '',
    createdAt: toIso(post.createdAt),
  };

  const reply = buildReplyRef(options.reply);
  if (reply) record.reply = reply;

  if (options.facets && options.facets.length > 0) record.facets = options.facets;

  if (options.embed && options.embed.items.length > 0) record.embed = options.embed;

  const langs = buildLangs(post);
  if (langs && langs.length > 0) record.langs = langs;

  const tags = post.hashtags;
  if (Array.isArray(tags) && tags.length > 0) record.tags = [...tags];

  const sources = buildSources(post);
  if (sources) record.sources = sources;

  const location = buildLocation(post);
  if (location) record.location = location;

  return record;
}

/**
 * Build an `app.mention.feed.like` record payload. `subject` is the MTN URI of
 * the liked post (built from the liked post's owner + id).
 */
export function buildLikeRecord(args: {
  likedPostId: string;
  likedPostOwnerOxyUserId: string;
  createdAt?: Date;
}): MentionLikeRecord {
  return {
    subject: createPostUri(args.likedPostOwnerOxyUserId, args.likedPostId),
    createdAt: toIso(args.createdAt),
  };
}

/**
 * Build an `app.mention.feed.repost` (boost) record payload. `subject` is the
 * MTN URI of the reposted post.
 */
export function buildRepostRecord(args: {
  repostedPostId: string;
  repostedPostOwnerOxyUserId: string;
  createdAt?: Date;
}): MentionRepostRecord {
  return {
    subject: createPostUri(args.repostedPostOwnerOxyUserId, args.repostedPostId),
    createdAt: toIso(args.createdAt),
  };
}

/**
 * Build an `app.mention.feed.tombstone` record payload that supersedes a
 * previously published record. `subject` is the MTN URI of the deleted record.
 */
export function buildTombstoneRecord(args: {
  subjectUri: string;
  createdAt?: Date;
}): MentionTombstoneRecord {
  return {
    subject: args.subjectUri,
    createdAt: toIso(args.createdAt),
  };
}

/**
 * Build an `app.mention.feed.bookmark` record payload. PRIVATE — bookmarks are
 * excluded from any public log export. `subject` is the MTN URI of the
 * bookmarked post.
 */
export function buildBookmarkRecord(args: {
  bookmarkedPostId: string;
  bookmarkedPostOwnerOxyUserId: string;
  createdAt?: Date;
}): MentionBookmarkRecord {
  return {
    subject: createPostUri(args.bookmarkedPostOwnerOxyUserId, args.bookmarkedPostId),
    createdAt: toIso(args.createdAt),
  };
}
