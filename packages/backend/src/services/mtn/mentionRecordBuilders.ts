/**
 * MTN record builders — map Mention's native shapes to `app.mention.feed.*`
 * lexicon payloads (the signed `record` body).
 *
 * Pure functions: every input is passed in (no DB access) so they are trivially
 * unit-testable and never add I/O to the dual-write side-effect path. The
 * payloads are the wire projection of a native row — they intentionally carry
 * ONLY the fields the lexicon defines, validated by the matching
 * `mention*RecordSchema` before signing.
 *
 * B1 SCOPE NOTE — media embed: post media is stored on the Post by Oxy file
 * `id`, but the lexicon `embed.blob.sha256` is a CONTENT address. Resolving
 * `fileId → File.sha256` needs an Oxy lookup, which the media-unification phase
 * (B2/B3) wires in. To keep the signed record HONEST (never a fileId where a
 * sha256 belongs) and the write path I/O-free, the post builder OMITS `embed` in
 * B1 — the blob refs land when the media chokepoint is unified. Everything else
 * the lexicon defines is populated.
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
  type MtnReplyRef,
  type MtnSourceLink,
  type MtnGeoPoint,
} from '@mention/shared-types';

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

/**
 * Build an `app.mention.feed.post` record payload from a native Post.
 *
 * `facets` is accepted explicitly (Mention does not yet store byte-range facets
 * on the Post; the caller passes them when available). `embed` is omitted in B1
 * (see the media note above).
 */
export function buildPostRecord(
  post: IPost,
  options: { reply?: ReplyContext; facets?: MtnFacet[] } = {},
): MentionPostRecord {
  const record: MentionPostRecord = {
    text: post.content?.text ?? '',
    createdAt: toIso(post.createdAt),
  };

  const reply = buildReplyRef(options.reply);
  if (reply) record.reply = reply;

  if (options.facets && options.facets.length > 0) record.facets = options.facets;

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
