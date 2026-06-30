/**
 * MTN Protocol lexicons — `app.mention.feed.*` record payloads.
 *
 * The "MTN Protocol" is Mention's app layer on top of the app-agnostic Oxy
 * Protocol (`@oxyhq/protocol` + `@oxyhq/contracts`). The Oxy Protocol owns the
 * WIRE grammar: a signed {@link SignedRecordEnvelope} whose `type` is an open
 * string and whose `record` is an opaque `Record<string, unknown>`. MTN layers
 * its own LEXICON on that grammar — a typed projection of the envelope's
 * `record` payload, addressed by an AtProto-style `(collection, rkey)` key —
 * WITHOUT forking the envelope schema (per the `LexiconRecord` recipe in
 * `@oxyhq/contracts/protocol`).
 *
 * Each record kind defines:
 *  1. its `record` PAYLOAD schema as a `z.ZodType<TPayload>` (validates ONLY the
 *     inner `record`, not the envelope), and
 *  2. its `collection` NSID as a constant.
 *
 * The envelope is validated with the unchanged `signedRecordEnvelopeSchema`
 * first; the inner `record` is then parsed with the matching payload schema and
 * paired with the `(collection, rkey)` key via `LexiconRecord<TPayload>`.
 *
 * Scope (closed): `post | like | repost | tombstone | bookmark`. Identity,
 * profile, the social graph (follow/block), and lists are owned by Oxy, NOT by
 * MTN — they are intentionally absent here.
 */

import { z } from 'zod';
import type { LexiconRecord } from '@oxyhq/contracts';

/* -------------------------------------------------------------------------- */
/*  Collection NSIDs                                                           */
/* -------------------------------------------------------------------------- */

/** A social post — the fundamental content unit. */
export const MENTION_POST_COLLECTION = 'app.mention.feed.post' as const;
/** A like on a post. */
export const MENTION_LIKE_COLLECTION = 'app.mention.feed.like' as const;
/** A repost (boost) of an existing post. */
export const MENTION_REPOST_COLLECTION = 'app.mention.feed.repost' as const;
/** A deletion marker that supersedes a previously published record. */
export const MENTION_TOMBSTONE_COLLECTION = 'app.mention.feed.tombstone' as const;
/** A private bookmark (excluded from any public log). */
export const MENTION_BOOKMARK_COLLECTION = 'app.mention.feed.bookmark' as const;

/** Every MTN feed collection NSID. */
export const MENTION_FEED_COLLECTIONS = [
  MENTION_POST_COLLECTION,
  MENTION_LIKE_COLLECTION,
  MENTION_REPOST_COLLECTION,
  MENTION_TOMBSTONE_COLLECTION,
  MENTION_BOOKMARK_COLLECTION,
] as const;

export type MentionFeedCollection = (typeof MENTION_FEED_COLLECTIONS)[number];

/* -------------------------------------------------------------------------- */
/*  Shared building blocks                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A content-addressed blob reference embedded in a record. The bytes themselves
 * live in the Oxy File Manager / CDN (deduped by `sha256`); the record only
 * carries the content address + the minimal descriptors needed to render and pin
 * it. `mediaType` is the coarse render kind; `mime`/`size` are best-effort hints.
 */
export interface MtnBlobRef {
  sha256: string;
  mediaType: 'image' | 'video' | 'gif';
  mime?: string;
  size?: number;
}

export const mtnBlobRefSchema: z.ZodType<MtnBlobRef> = z.object({
  sha256: z.string().min(1),
  mediaType: z.enum(['image', 'video', 'gif']),
  mime: z.string().min(1).optional(),
  size: z.number().int().nonnegative().optional(),
});

/** A single embedded media item: a blob ref plus optional alt text. */
export interface MtnEmbedMediaItem {
  blob: MtnBlobRef;
  alt?: string;
}

export const mtnEmbedMediaItemSchema: z.ZodType<MtnEmbedMediaItem> = z.object({
  blob: mtnBlobRefSchema,
  alt: z.string().optional(),
});

/** The media embed: an ordered list of blob-referenced media items. */
export interface MtnMediaEmbed {
  type: 'media';
  items: MtnEmbedMediaItem[];
}

export const mtnMediaEmbedSchema: z.ZodType<MtnMediaEmbed> = z.object({
  type: z.literal('media'),
  items: z.array(mtnEmbedMediaItemSchema),
});

/**
 * The thread position of a reply: the URIs of the thread root and the direct
 * parent (MTN URIs, `mtn://<oxyUserId>/<collection>/<rkey>`).
 */
export interface MtnReplyRef {
  root: string;
  parent: string;
}

export const mtnReplyRefSchema: z.ZodType<MtnReplyRef> = z.object({
  root: z.string().min(1),
  parent: z.string().min(1),
});

/** An external source cited within the post. */
export interface MtnSourceLink {
  url: string;
  title?: string;
}

export const mtnSourceLinkSchema: z.ZodType<MtnSourceLink> = z.object({
  url: z.string().url(),
  title: z.string().optional(),
});

/** A GeoJSON `Point` location attached to the post. */
export interface MtnGeoPoint {
  type: 'Point';
  coordinates: [number, number];
}

export const mtnGeoPointSchema: z.ZodType<MtnGeoPoint> = z.object({
  type: z.literal('Point'),
  coordinates: z.tuple([z.number(), z.number()]),
});

/* -------------------------------------------------------------------------- */
/*  Rich-text facets                                                           */
/* -------------------------------------------------------------------------- */

/** A byte-range slice into the post text (UTF-8, end-exclusive). */
export interface MtnFacetByteSlice {
  byteStart: number;
  byteEnd: number;
}

const mtnFacetByteSliceSchema: z.ZodType<MtnFacetByteSlice> = z.object({
  byteStart: z.number().int().nonnegative(),
  byteEnd: z.number().int().nonnegative(),
});

/** A `@mention` feature: the mentioned user's oxyUserId. */
export interface MtnMentionFeature {
  type: 'mention';
  did: string;
}

/** A link feature: an external URI. */
export interface MtnLinkFeature {
  type: 'link';
  uri: string;
}

/** A hashtag feature: the tag (without the leading `#`). */
export interface MtnHashtagFeature {
  type: 'hashtag';
  tag: string;
}

export type MtnFacetFeature = MtnMentionFeature | MtnLinkFeature | MtnHashtagFeature;

const mtnFacetFeatureSchema: z.ZodType<MtnFacetFeature> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mention'), did: z.string().min(1) }),
  z.object({ type: z.literal('link'), uri: z.string().min(1) }),
  z.object({ type: z.literal('hashtag'), tag: z.string().min(1) }),
]);

/** A rich-text facet: a byte range annotated with one or more features. */
export interface MtnFacet {
  index: MtnFacetByteSlice;
  features: MtnFacetFeature[];
}

export const mtnFacetSchema: z.ZodType<MtnFacet> = z.object({
  index: mtnFacetByteSliceSchema,
  features: z.array(mtnFacetFeatureSchema),
});

/* -------------------------------------------------------------------------- */
/*  app.mention.feed.post                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The payload of an `app.mention.feed.post` record. The signed projection of a
 * Mention post: its text + rich-text facets, an optional media embed (media
 * resolved to content-addressed blob refs), the thread position for replies, the
 * declared languages, tags, cited sources, an optional location, and the
 * authoring timestamp.
 */
export interface MentionPostRecord {
  text: string;
  facets?: MtnFacet[];
  embed?: MtnMediaEmbed;
  reply?: MtnReplyRef;
  langs?: string[];
  tags?: string[];
  sources?: MtnSourceLink[];
  location?: MtnGeoPoint;
  createdAt: string;
}

export const mentionPostRecordSchema: z.ZodType<MentionPostRecord> = z.object({
  text: z.string(),
  facets: z.array(mtnFacetSchema).optional(),
  embed: mtnMediaEmbedSchema.optional(),
  reply: mtnReplyRefSchema.optional(),
  langs: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  sources: z.array(mtnSourceLinkSchema).optional(),
  location: mtnGeoPointSchema.optional(),
  createdAt: z.string().min(1),
});

export type MentionPostLexiconRecord = LexiconRecord<MentionPostRecord>;

/* -------------------------------------------------------------------------- */
/*  app.mention.feed.like                                                      */
/* -------------------------------------------------------------------------- */

/** The payload of an `app.mention.feed.like` record: the URI of the liked post. */
export interface MentionLikeRecord {
  subject: string;
  createdAt: string;
}

export const mentionLikeRecordSchema: z.ZodType<MentionLikeRecord> = z.object({
  subject: z.string().min(1),
  createdAt: z.string().min(1),
});

export type MentionLikeLexiconRecord = LexiconRecord<MentionLikeRecord>;

/* -------------------------------------------------------------------------- */
/*  app.mention.feed.repost                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The payload of an `app.mention.feed.repost` record (a boost): the URI of the
 * reposted post.
 */
export interface MentionRepostRecord {
  subject: string;
  createdAt: string;
}

export const mentionRepostRecordSchema: z.ZodType<MentionRepostRecord> = z.object({
  subject: z.string().min(1),
  createdAt: z.string().min(1),
});

export type MentionRepostLexiconRecord = LexiconRecord<MentionRepostRecord>;

/* -------------------------------------------------------------------------- */
/*  app.mention.feed.tombstone                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The payload of an `app.mention.feed.tombstone` record: a deletion marker that
 * supersedes a previously published record. `subject` is the MTN URI of the
 * record being deleted; `rkey` (the envelope key) is the deleted record's key so
 * the tombstone materializes as a last-writer-wins removal of that key.
 */
export interface MentionTombstoneRecord {
  subject: string;
  createdAt: string;
}

export const mentionTombstoneRecordSchema: z.ZodType<MentionTombstoneRecord> = z.object({
  subject: z.string().min(1),
  createdAt: z.string().min(1),
});

export type MentionTombstoneLexiconRecord = LexiconRecord<MentionTombstoneRecord>;

/* -------------------------------------------------------------------------- */
/*  app.mention.feed.bookmark                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The payload of an `app.mention.feed.bookmark` record: the URI of the
 * bookmarked post. PRIVATE — bookmarks are never included in any public log
 * export.
 */
export interface MentionBookmarkRecord {
  subject: string;
  createdAt: string;
}

export const mentionBookmarkRecordSchema: z.ZodType<MentionBookmarkRecord> = z.object({
  subject: z.string().min(1),
  createdAt: z.string().min(1),
});

export type MentionBookmarkLexiconRecord = LexiconRecord<MentionBookmarkRecord>;
