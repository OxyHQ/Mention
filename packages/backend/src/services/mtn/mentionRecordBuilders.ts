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
 * resolvePostRecordEmbeds} (the ONE I/O step in this module) resolves every media
 * item the post references — the shared set AND each author variant's override —
 * `fileId → sha256` via the service-scoped Oxy SDK in a single batched call, then
 * `buildPostRecord` folds the resolved embeds in. The lookup is fail-soft: when it
 * errors (e.g. the Mention federation credential lacks the `files:read` scope),
 * the resolver yields no embeds and the record is emitted WITHOUT media — the
 * dual-write stays best-effort and a missing blob never blocks the post.
 */

import type { ServiceAssetMetadata } from '@oxyhq/core';
import type { IPost } from '../../models/Post';
import {
  canonicalizeLanguageTag,
  createPostUri,
  type MediaItem,
  type MentionPostRecord,
  type MentionPostVariant,
  type MentionLikeRecord,
  type MentionRepostRecord,
  type MentionTombstoneRecord,
  type MentionBookmarkRecord,
  type PostContentVariant,
  type MtnFacet,
  type MtnMediaEmbed,
  type MtnEmbedMediaItem,
  type MtnReplyRef,
  type MtnSourceLink,
  type MtnGeoPoint,
} from '@mention/shared-types';
import { authorVariants, resolveVariant } from '../postVariants';
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
  // What the AUTHOR actually declared, in the precise BCP-47 tags they wrote in
  // (`es-ES`, not `es`), primary first. This is the highest-fidelity source and
  // it is what lets a materializing reader reproduce the post's primary tag
  // exactly — the classification set below is normalized to base subtags, so a
  // post round-tripped through it would come back as `es` and lose the region.
  // (`langs` is BCP-47 by protocol in both MTN and atproto, so regional tags are
  // exactly what belongs here.)
  const declared = authorVariants(post.content)
    .map((variant) => canonicalizeLanguageTag(variant.tag))
    .filter((tag): tag is string => tag !== null);
  if (declared.length > 0) {
    return declared;
  }

  // Otherwise the classifier's resolved set (base subtags), else the single
  // top-level AP `post.language`.
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
 * Everything the (pure) record builder needs out of the ONE content-address
 * lookup a post requires.
 *
 * A multilingual post can carry media in three places at once: the shared set,
 * an alternate set on a variant that REPLACES it (a Spanish infographic and an
 * English one), and a variant's `alt` map that localizes the SHARED set. All
 * three speak Oxy file ids natively and blob `sha256` on the chain, so they are
 * resolved together in a single batched call rather than one per language.
 */
export interface PostRecordEmbeds {
  /** The shared media embed, absent when the post has no resolvable media. */
  embed?: MtnMediaEmbed;
  /** By author-variant tag: the embed that REPLACES the shared one for that language. */
  variantEmbeds: Map<string, MtnMediaEmbed>;
  /**
   * Oxy fileId → blob `sha256`. A variant's `alt` map is keyed by media id
   * natively but by blob address on the chain (the record has no file ids in
   * it), so re-keying needs this.
   */
  sha256ByFileId: Map<string, string>;
}

/** Build one lexicon media embed from native MediaItems, using a resolved sha256 index. */
function buildEmbedFromMedia(
  media: readonly MediaItem[],
  metadataByFileId: Map<string, ServiceAssetMetadata>,
): MtnMediaEmbed | undefined {
  const items: MtnEmbedMediaItem[] = [];
  for (const m of media) {
    if (!isResolvableFileId(m?.id)) continue;
    const meta = metadataByFileId.get(m.id);
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
  return items.length > 0 ? { type: 'media', items } : undefined;
}

/**
 * Resolve every Oxy file id a post references — the shared `content.media` AND
 * each author variant's media override — into CONTENT-addressed blob refs, via
 * the service-scoped SDK's `getServiceAssetMetadataByIds`. ONE batched call for
 * the whole post, however many languages it has.
 *
 * FAIL-SOFT: any error (notably a `files:read`-scope 403 on the Mention
 * federation credential) or an empty/unresolvable media set yields empty
 * embeds, so `buildPostRecord` emits the record WITHOUT media. The signed record
 * is always honest — it never carries a fileId where a `sha256` belongs — and
 * the dual-write stays best-effort: a missing blob NEVER blocks the post.
 */
export async function resolvePostRecordEmbeds(post: IPost): Promise<PostRecordEmbeds> {
  const empty: PostRecordEmbeds = { variantEmbeds: new Map(), sha256ByFileId: new Map() };

  const sharedMedia = Array.isArray(post.content?.media) ? post.content.media : [];
  const variants = authorVariants(post.content);

  // The union of every file id the post references, deduped: the shared set, each
  // variant's replacement set, and the media ids a variant's `alt` map localizes
  // (those keys are file ids, and their sha256 is what the record's `alt` map is
  // keyed by).
  const fileIds = new Set<string>();
  for (const m of sharedMedia) {
    if (isResolvableFileId(m?.id)) fileIds.add(m.id);
  }
  for (const variant of variants) {
    if (Array.isArray(variant.media)) {
      for (const m of variant.media) {
        if (isResolvableFileId(m?.id)) fileIds.add(m.id);
      }
    }
    if (variant.alt) {
      for (const mediaId of Object.keys(variant.alt)) {
        if (isResolvableFileId(mediaId)) fileIds.add(mediaId);
      }
    }
  }
  if (fileIds.size === 0) return empty;

  try {
    const metadata = await getServiceOxyClient().getServiceAssetMetadataByIds([...fileIds]);
    const metadataByFileId = new Map(metadata.map((m) => [m.id, m]));

    const sha256ByFileId = new Map<string, string>();
    for (const meta of metadata) {
      if (typeof meta.sha256 === 'string' && meta.sha256.length > 0) {
        sha256ByFileId.set(meta.id, meta.sha256);
      }
    }

    const variantEmbeds = new Map<string, MtnMediaEmbed>();
    for (const variant of variants) {
      // Keyed by tag, so an UNTAGGED variant has no entry — and needs none: it is
      // the post's sole rendition, so its media IS the shared set the record's
      // top-level `embed` already carries.
      if (variant.tag === undefined) continue;
      if (!Array.isArray(variant.media) || variant.media.length === 0) continue;
      const embed = buildEmbedFromMedia(variant.media, metadataByFileId);
      if (embed) variantEmbeds.set(variant.tag, embed);
    }

    return {
      embed: buildEmbedFromMedia(sharedMedia, metadataByFileId),
      variantEmbeds,
      sha256ByFileId,
    };
  } catch (error) {
    // Best-effort: a failed asset-metadata lookup must never block emitting the
    // record. The federation credential may not yet have the `files:read` scope.
    logger.warn('mentionRecordBuilders: resolvePostRecordEmbeds failed; emitting record without media embed', {
      postId: String(post._id),
      mediaCount: fileIds.size,
      error: error instanceof Error ? error.message : String(error),
    });
    return empty;
  }
}

/**
 * Project the post's AUTHOR-written variants onto the record, primary first (so
 * `variants[0]` always agrees with the record's primary `text`).
 *
 * MACHINE TRANSLATIONS ARE NEVER SIGNED. A translation is derived content, and
 * putting it on the author's chain would attribute to them words they never
 * wrote. {@link authorVariants} filters them out by construction; nothing
 * downstream needs to re-check.
 *
 * The variant's media override travels as its own content-addressed `embed`, and
 * its localized `alt` map is RE-KEYED from Oxy file id to blob `sha256`: the
 * record has no file ids anywhere in it, so a file-id-keyed map would be a
 * dangling reference the moment the chain is read by anyone but us. An alt entry
 * whose media did not resolve is dropped rather than emitted against a key no
 * reader can match.
 */
function buildRecordVariants(post: IPost, embeds: PostRecordEmbeds): MentionPostVariant[] | undefined {
  const authored = authorVariants(post.content);
  if (authored.length === 0) return undefined;

  const variants: MentionPostVariant[] = [];
  for (const source of authored) {
    // An UNTAGGED variant cannot be signed: a lexicon variant is keyed by its
    // BCP-47 `tag`. A post whose only rendition is untagged (a body too short to
    // detect a language in) therefore emits NO `variants` — and needs none: its
    // body is already the record's primary `text`, which is exactly the
    // degradation path the lexicon documents.
    const tag = canonicalizeLanguageTag(source.tag);
    if (tag === null) continue;

    const variant: MentionPostVariant = { tag, text: source.text };

    const embed = source.tag === undefined ? undefined : embeds.variantEmbeds.get(source.tag);
    if (embed) variant.embed = embed;

    const alt = buildVariantAlt(source, embeds.sha256ByFileId);
    if (alt) variant.alt = alt;

    const article = buildVariantArticle(source);
    if (article) variant.article = article;

    variants.push(variant);
  }

  // A single tagged variant is the whole post: `text` already carries that body,
  // so a one-entry `variants` array would just be a copy of it on the wire.
  return variants.length > 1 ? variants : undefined;
}

/** Re-key a variant's `alt` map from Oxy media id to the blob `sha256` the chain speaks. */
function buildVariantAlt(
  variant: PostContentVariant,
  sha256ByFileId: Map<string, string>,
): Record<string, string> | undefined {
  if (!variant.alt) return undefined;
  const alt: Record<string, string> = {};
  for (const [mediaId, text] of Object.entries(variant.alt)) {
    if (typeof text !== 'string' || text.length === 0) continue;
    const sha256 = sha256ByFileId.get(mediaId);
    if (!sha256) continue;
    alt[sha256] = text;
  }
  return Object.keys(alt).length > 0 ? alt : undefined;
}

/** The localized long-form fields of a variant, when it overrides the article. */
function buildVariantArticle(variant: PostContentVariant): MentionPostVariant['article'] {
  const article = variant.article;
  if (!article) return undefined;
  const projected: NonNullable<MentionPostVariant['article']> = {};
  if (article.title) projected.title = article.title;
  if (article.body) projected.body = article.body;
  if (article.excerpt) projected.excerpt = article.excerpt;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * Build an `app.mention.feed.post` record payload from a native Post.
 *
 * `facets` is accepted explicitly (Mention does not yet store byte-range facets
 * on the Post; the caller passes them when available). `embeds` is the
 * pre-resolved content-addressed media from {@link resolvePostRecordEmbeds} — the
 * only input requiring an Oxy lookup, so it is resolved by the (async) caller and
 * passed in to keep this builder pure.
 *
 * `text` stays the PRIMARY body even on a multilingual post: a reader on an older
 * schema strips the unknown `variants` key (the lexicon schema is a plain
 * `z.object`) and still materializes a complete, correct post from `text` alone.
 * That graceful degradation is what keeps the hash chain verifiable across
 * versions.
 */
export function buildPostRecord(
  post: IPost,
  options: { reply?: ReplyContext; facets?: MtnFacet[]; embeds?: PostRecordEmbeds } = {},
): MentionPostRecord {
  const embeds: PostRecordEmbeds = options.embeds ?? {
    variantEmbeds: new Map(),
    sha256ByFileId: new Map(),
  };

  const record: MentionPostRecord = {
    // The PRIMARY body, resolved from the primary variant. The record's single
    // `text` slot is a wire format (and the graceful-degradation path for an
    // older reader) — not a reason to keep a second copy of the body in storage.
    text: resolveVariant(post.content).text,
    createdAt: toIso(post.createdAt),
  };

  const reply = buildReplyRef(options.reply);
  if (reply) record.reply = reply;

  if (options.facets && options.facets.length > 0) record.facets = options.facets;

  if (embeds.embed && embeds.embed.items.length > 0) record.embed = embeds.embed;

  const langs = buildLangs(post);
  if (langs && langs.length > 0) record.langs = langs;

  const tags = post.hashtags;
  if (Array.isArray(tags) && tags.length > 0) record.tags = [...tags];

  const sources = buildSources(post);
  if (sources) record.sources = sources;

  const location = buildLocation(post);
  if (location) record.location = location;

  const variants = buildRecordVariants(post, embeds);
  if (variants) record.variants = variants;

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
