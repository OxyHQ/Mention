import { PostVisibility } from '@mention/shared-types';
import { normalizeMultilineText } from '@oxyhq/core';
import { logger } from '../../utils/logger';
import { Post } from '../../models/Post';
import FederatedActor from '../../models/FederatedActor';
import { normalizeAlt } from '../../services/MediaMetadataService';
import { getPostCreator } from '../../services/serviceRegistry';
import { mapWithConcurrency } from '../../utils/concurrency';
import { materializeFederatedMedia, type ExtractedMediaAttachment } from '../shared/federatedMedia';
import type { MediaItem } from '@mention/shared-types';
import type { NormalizedExternalActor, NormalizedExternalMedia, NormalizedExternalPost } from '../types';
import { xrpcGet } from './xrpcClient';
import { fetchAndUpsertAtprotoProfile } from './profile.mapper';
import { BSKY_APP_ORIGIN, POST_COLLECTION, PUBLIC_APPVIEW } from './constants';

/**
 * Maps Bluesky `app.bsky.feed.post` records (from `app.bsky.feed.getAuthorFeed`)
 * into native `Post` rows via the SAME `getPostCreator().create({...})` path the
 * ActivityPub ingest uses, deduped on `Post.federation.activityId` (the AT-URI),
 * with remote media mirrored to Oxy S3 by the shared `materializeFederatedMedia`.
 */

/** Adult/sensitive self-label values that flip a post's content warning on. */
const ADULT_LABEL_VALUES = new Set(['porn', 'nudity', 'sexual', 'graphic-media']);

/** Clamp self-asserted future timestamps (atproto `createdAt` is author-supplied). */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000; // 1 hour

// --- getAuthorFeed response shape (only the fields this connector reads) ---

interface AtprotoFacetFeature {
  $type?: string;
  tag?: string;
  uri?: string;
  did?: string;
}
/** Byte (UTF-8) offsets into the record `text` a facet annotates. */
interface AtprotoFacetIndex {
  byteStart?: number;
  byteEnd?: number;
}
interface AtprotoFacet {
  index?: AtprotoFacetIndex;
  features?: AtprotoFacetFeature[];
}
interface AtprotoReplyRef {
  uri?: string;
  cid?: string;
}
interface AtprotoPostRecord {
  $type?: string;
  text?: string;
  createdAt?: string;
  reply?: { root?: AtprotoReplyRef; parent?: AtprotoReplyRef };
  facets?: AtprotoFacet[];
  langs?: string[];
  tags?: string[];
  labels?: { values?: Array<{ val?: string }> };
}
interface AtprotoEmbedImage {
  thumb?: string;
  fullsize?: string;
  alt?: string;
  aspectRatio?: { width: number; height: number };
}
/**
 * A hydrated record embed view. Self-referential so it covers both nesting levels:
 * a top-level `app.bsky.embed.record#view` whose `.record` is the quoted
 * `#viewRecord` (carrying its `uri`), and the `app.bsky.embed.recordWithMedia#view`
 * whose `.record` is a nested `#view` whose `.record` is that `#viewRecord`.
 */
interface AtprotoEmbedRecordView {
  $type?: string;
  uri?: string;
  record?: AtprotoEmbedRecordView;
}
interface AtprotoEmbedView {
  $type?: string;
  images?: AtprotoEmbedImage[];
  playlist?: string;
  thumbnail?: string;
  aspectRatio?: { width: number; height: number };
  media?: AtprotoEmbedView;
  record?: AtprotoEmbedRecordView;
}
/**
 * A hydrated `app.bsky.feed.post` view. `getAuthorFeed`, `getFeed`, and `getPosts`
 * all return this identical shape, so it is the input the native-post import path
 * ({@link importPostViews}) consumes.
 */
export interface AtprotoPostView {
  uri?: string;
  cid?: string;
  author?: { did?: string; handle?: string };
  record?: AtprotoPostRecord;
  embed?: AtprotoEmbedView;
  indexedAt?: string;
}
interface AtprotoFeedItem {
  post?: AtprotoPostView;
  /** Present on reposts (`#reasonRepost`) — those are skipped in C2. */
  reason?: unknown;
}
interface AtprotoAuthorFeed {
  feed?: AtprotoFeedItem[];
  cursor?: string;
}

/** Parse an AT-URI `at://<authority>/<collection>/<rkey>` into its parts. */
function parseAtUri(uri: string): { authority: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { authority: match[1], collection: match[2], rkey: match[3] };
}

/** Parse an atproto `createdAt`, rejecting NaN and clamping far-future dates. */
function parseCreatedAt(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return undefined;
  if (ms > Date.now() + MAX_FUTURE_SKEW_MS) return undefined;
  return date;
}

/** Extract hashtags from richtext `#tag` facets and the record-level `tags`. */
function extractHashtags(record: AtprotoPostRecord): string[] {
  const tags = new Set<string>();
  for (const tag of record.tags ?? []) {
    if (typeof tag === 'string' && tag.trim()) tags.add(tag.trim().replace(/^#/, '').toLowerCase());
  }
  for (const facet of record.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature?.$type === 'app.bsky.richtext.facet#tag' && typeof feature.tag === 'string' && feature.tag.trim()) {
        tags.add(feature.tag.trim().replace(/^#/, '').toLowerCase());
      }
    }
  }
  return Array.from(tags);
}

/** Every atproto DID referenced by a record's richtext `#mention` facets. Pure. */
function extractMentionDids(record: AtprotoPostRecord | undefined): string[] {
  if (!record) return [];
  const dids: string[] = [];
  for (const facet of record.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (feature?.$type === 'app.bsky.richtext.facet#mention' && typeof feature.did === 'string' && feature.did) {
        dids.push(feature.did);
      }
    }
  }
  return dids;
}

/** A single byte-range text replacement derived from a richtext facet. */
interface FacetReplacement {
  byteStart: number;
  byteEnd: number;
  replacement: string;
}

/**
 * Build the byte-range text replacements + resolved mention ids for a record's
 * richtext facets:
 *   - `#link`: replace the (truncated) display text with the feature's FULL `uri`
 *     — this is what surfaces `gothamist.com/news/long-arti…` as the real URL so
 *     the link is never broken and the link-preview pipeline can unfurl it.
 *   - `#mention`: replace the `@handle` display text with the internal
 *     `[mention:<oxyUserId>]` placeholder when the DID resolved (from `mentionMap`);
 *     when it did not, emit no op so the bare `@handle` text is left in place.
 *   - `#tag`: left untouched — the `#tag` text renders as-is and the normalized
 *     tag set comes from {@link extractHashtags}.
 * Pure.
 */
function buildFacetReplacements(
  record: AtprotoPostRecord,
  mentionMap: ReadonlyMap<string, string>,
): { ops: FacetReplacement[]; mentionIds: string[] } {
  const ops: FacetReplacement[] = [];
  const mentionIds = new Set<string>();
  for (const facet of record.facets ?? []) {
    const byteStart = facet.index?.byteStart;
    const byteEnd = facet.index?.byteEnd;
    if (typeof byteStart !== 'number' || typeof byteEnd !== 'number') continue;
    for (const feature of facet.features ?? []) {
      if (feature?.$type === 'app.bsky.richtext.facet#link' && typeof feature.uri === 'string' && feature.uri) {
        ops.push({ byteStart, byteEnd, replacement: feature.uri });
        break; // one replacement per facet byte range
      }
      if (feature?.$type === 'app.bsky.richtext.facet#mention' && typeof feature.did === 'string' && feature.did) {
        const oxyUserId = mentionMap.get(feature.did);
        if (oxyUserId) {
          ops.push({ byteStart, byteEnd, replacement: `[mention:${oxyUserId}]` });
          mentionIds.add(oxyUserId);
        }
        break;
      }
    }
  }
  return { ops, mentionIds: [...mentionIds] };
}

/**
 * Apply byte-range replacements to `text`. atproto facet indices are UTF-8 BYTE
 * offsets (not JS UTF-16 string indices), so the splice runs over a UTF-8 byte
 * buffer and decodes back — multibyte text (emoji, accents) before a facet does
 * not shift its target. Replacements are applied in DESCENDING `byteStart` order
 * so an earlier splice never shifts a later (leftward) range; overlapping or
 * out-of-range facets are skipped. Pure.
 */
function applyFacetReplacements(text: string, ops: FacetReplacement[]): string {
  if (ops.length === 0) return text;
  const buffer = Buffer.from(text, 'utf8');
  const ordered = ops
    .filter((op) => op.byteStart >= 0 && op.byteStart < op.byteEnd && op.byteEnd <= buffer.length)
    .sort((a, b) => b.byteStart - a.byteStart);

  let out = buffer;
  // The start of the nearest already-applied range to the right; a facet that
  // ends past it overlaps and is skipped (facets never legally overlap).
  let nextStart = buffer.length;
  for (const op of ordered) {
    if (op.byteEnd > nextStart) continue;
    out = Buffer.concat([out.subarray(0, op.byteStart), Buffer.from(op.replacement, 'utf8'), out.subarray(op.byteEnd)]);
    nextStart = op.byteStart;
  }
  return out.toString('utf8');
}

/**
 * The quoted post's AT-URI from a hydrated record embed
 * (`app.bsky.embed.record#view`, or the record half of
 * `app.bsky.embed.recordWithMedia#view`) — but ONLY when the quoted record is a
 * real, viewable feed post (`#viewRecord` of `app.bsky.feed.post`). A blocked /
 * detached / not-found / feed-generator / list embed yields no quote. Pure.
 */
function extractQuotedUri(embed: AtprotoEmbedView | undefined): string | undefined {
  const recordView =
    embed?.$type === 'app.bsky.embed.record#view'
      ? embed.record
      : embed?.$type === 'app.bsky.embed.recordWithMedia#view'
        ? embed.record?.record
        : undefined;
  if (recordView?.$type === 'app.bsky.embed.record#viewRecord' && typeof recordView.uri === 'string') {
    const parsed = parseAtUri(recordView.uri);
    if (parsed && parsed.collection === POST_COLLECTION) return recordView.uri;
  }
  return undefined;
}

/** Normalize `record.langs` to ISO 639-1 primary subtags (deduped, capped at 3). */
function normalizeLangs(langs: unknown): string[] {
  if (!Array.isArray(langs)) return [];
  const out: string[] = [];
  for (const lang of langs) {
    if (typeof lang !== 'string') continue;
    const code = lang.trim().toLowerCase().split('-')[0];
    if (code && !out.includes(code)) out.push(code);
    if (out.length >= 3) break;
  }
  return out;
}

/** True when the post carries an adult self-label. */
function hasAdultLabel(record: AtprotoPostRecord): boolean {
  const values = record.labels?.values;
  if (!Array.isArray(values)) return false;
  return values.some((entry) => typeof entry?.val === 'string' && ADULT_LABEL_VALUES.has(entry.val));
}

function patchFromAspectRatio(
  aspectRatio: { width: number; height: number } | undefined,
): Pick<NormalizedExternalMedia, 'width' | 'height' | 'orientation' | 'aspectRatio'> {
  if (!aspectRatio || aspectRatio.width <= 0 || aspectRatio.height <= 0) return {};
  const width = Math.trunc(aspectRatio.width);
  const height = Math.trunc(aspectRatio.height);
  const ratio = height / width;
  let orientation: 'portrait' | 'landscape' | 'square';
  if (ratio >= 1.1) orientation = 'portrait';
  else if (ratio <= 0.9) orientation = 'landscape';
  else orientation = 'square';
  return { width, height, orientation, aspectRatio: width / height };
}

/**
 * Extract playable media from a hydrated embed VIEW. Bluesky returns full CDN
 * URLs in `app.bsky.embed.images#view` (`fullsize`) and
 * `app.bsky.embed.video#view` (`playlist`, an HLS manifest); `recordWithMedia`
 * nests its media under `.media`.
 */
function extractMediaFromEmbed(embed: AtprotoEmbedView | undefined): NormalizedExternalMedia[] {
  const out: NormalizedExternalMedia[] = [];
  const collect = (view: AtprotoEmbedView | undefined): void => {
    if (!view) return;
    switch (view.$type) {
      case 'app.bsky.embed.images#view':
        for (const image of view.images ?? []) {
          const url = image?.fullsize || image?.thumb;
          if (typeof url === 'string' && url) {
            // Alt text is a one-line label authored on a remote client, so it gets
            // the SAME canonical rule as every other alt in the system (native
            // writes, AP attachments): whitespace-only becomes absent, never `''`.
            out.push({
              id: url,
              type: 'image',
              remoteUrl: url,
              alt: normalizeAlt(image.alt),
              ...patchFromAspectRatio(image.aspectRatio),
            });
          }
        }
        break;
      case 'app.bsky.embed.video#view': {
        const url = view.playlist || view.thumbnail;
        if (typeof url === 'string' && url) {
          out.push({
            id: url,
            type: 'video',
            remoteUrl: url,
            ...patchFromAspectRatio(view.aspectRatio),
          });
        }
        break;
      }
      case 'app.bsky.embed.recordWithMedia#view':
        collect(view.media);
        break;
      default:
        break;
    }
  };
  collect(embed);
  return out;
}

/**
 * Map a single `app.bsky.feed.post` PostView into a network-neutral post.
 *
 * Returns null for anything that is not an `app.bsky.feed.post` authored by
 * `expectedAuthorDid` (the synced actor) — mirroring the ActivityPub
 * actor-match guard so an author feed cannot smuggle in another actor's post.
 */
export function mapPostViewToNormalizedPost(
  postView: AtprotoPostView | undefined,
  expectedAuthorDid: string,
  mentionMap: ReadonlyMap<string, string> = new Map(),
): NormalizedExternalPost | null {
  if (!postView || typeof postView.uri !== 'string') return null;
  const parsed = parseAtUri(postView.uri);
  if (!parsed || parsed.collection !== POST_COLLECTION) return null;

  const did = postView.author?.did;
  if (typeof did !== 'string' || did !== expectedAuthorDid) return null;

  const record = postView.record;
  if (!record || record.$type !== POST_COLLECTION) return null;

  const handle = typeof postView.author?.handle === 'string' ? postView.author.handle : undefined;
  const profileRef = handle || did;
  const url = `${BSKY_APP_ORIGIN}/profile/${profileRef}/post/${parsed.rkey}`;
  const langs = normalizeLangs(record.langs);
  const media = extractMediaFromEmbed(postView.embed);
  const inReplyTo = typeof record.reply?.parent?.uri === 'string' ? record.reply.parent.uri : undefined;
  const quotedUri = extractQuotedUri(postView.embed);

  // Rewrite richtext facets over the RAW body FIRST, then normalize whitespace:
  // the facet indices are byte offsets into `record.text`, so they must be applied
  // before normalization shifts the bytes. `#link` display text becomes the full
  // URL; resolved `#mention`s become `[mention:<oxyUserId>]` placeholders.
  const rawText = typeof record.text === 'string' ? record.text : '';
  const { ops, mentionIds } = buildFacetReplacements(record, mentionMap);
  // The post body is third-party text: the author's line breaks are meaningful and
  // survive, but the surrounding whitespace noise is normalized away.
  const text = normalizeMultilineText(applyFacetReplacements(rawText, ops));

  return {
    network: 'atproto',
    activityId: postView.uri,
    actorUri: did,
    url,
    inReplyTo,
    quotedUri,
    sensitive: hasAdultLabel(record),
    authorOxyUserId: undefined,
    text,
    media: media.length > 0 ? media : undefined,
    hashtags: extractHashtags(record),
    mentions: mentionIds.length > 0 ? mentionIds : undefined,
    language: langs[0],
    languages: langs.length > 0 ? langs : undefined,
    createdAt: parseCreatedAt(record.createdAt),
  };
}

/** True for a MongoDB duplicate-key (E11000) error — a concurrent import race. */
function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: number }).code === 11000);
}

/**
 * Resolve a mentioned atproto DID to its Oxy user id. Prefers an already-synced
 * `FederatedActor` (no network round trip); otherwise resolves + mints the actor
 * through the shared atproto profile path (`fetchAndUpsertAtprotoProfile`). Returns
 * undefined (fail-soft) when the DID cannot be resolved to an Oxy user — the caller
 * then leaves the bare `@handle` display text rather than minting a broken link.
 */
async function resolveAtprotoMentionOxyId(did: string): Promise<string | undefined> {
  try {
    const existing = await FederatedActor.findOne({ uri: did })
      .select('oxyUserId')
      .lean<{ oxyUserId?: string } | null>();
    if (existing?.oxyUserId) return String(existing.oxyUserId);
  } catch (err) {
    logger.warn(`[atproto] mention actor lookup failed for ${did}`, err);
  }
  const actor = await fetchAndUpsertAtprotoProfile(did);
  return actor?.oxyUserId ? String(actor.oxyUserId) : undefined;
}

/**
 * Batch-resolve every mentioned DID in an author feed to its Oxy user id (deduped,
 * parallel, fail-soft). The returned map feeds the pure mapper so it can splice
 * `[mention:<oxyUserId>]` placeholders in the same byte pass as `#link` facets.
 * Unresolvable DIDs are simply absent from the map.
 */
async function resolveMentionDids(dids: Set<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (dids.size === 0) return map;
  await Promise.all(
    [...dids].map(async (did) => {
      const oxyUserId = await resolveAtprotoMentionOxyId(did);
      if (oxyUserId) map.set(did, oxyUserId);
    }),
  );
  return map;
}

/**
 * Resolve a federated atproto post's `inReplyTo` / quoted AT-URIs to LOCAL thread +
 * quote links by matching each against an imported post's `federation.activityId`.
 * Mirrors the ActivityPub inbox reply rule (`threadId = parent.threadId ??
 * parent._id`). Best-effort: a parent / quoted post not yet imported is left
 * unlinked (a later re-ingest resolves it once that post exists locally).
 */
async function resolveThreadAndQuoteLinks(
  inReplyTo: string | undefined,
  quotedUri: string | undefined,
): Promise<{ parentPostId?: string; threadId?: string; quoteOf?: string }> {
  const uris = [inReplyTo, quotedUri].filter((uri): uri is string => typeof uri === 'string' && uri.length > 0);
  if (uris.length === 0) return {};

  const docs = await Post.find({ 'federation.activityId': { $in: uris } })
    .select('_id threadId federation.activityId')
    .lean<Array<{ _id: unknown; threadId?: string; federation?: { activityId?: string } }>>();
  const byUri = new Map<string, { _id: unknown; threadId?: string }>();
  for (const doc of docs) {
    const uri = doc.federation?.activityId;
    if (uri) byUri.set(uri, doc);
  }

  const links: { parentPostId?: string; threadId?: string; quoteOf?: string } = {};
  if (inReplyTo) {
    const parent = byUri.get(inReplyTo);
    if (parent) {
      links.parentPostId = String(parent._id);
      links.threadId = parent.threadId ? String(parent.threadId) : String(parent._id);
    }
  }
  if (quotedUri) {
    const quoted = byUri.get(quotedUri);
    if (quoted) links.quoteOf = String(quoted._id);
  }
  return links;
}

/**
 * Persist a normalized atproto post as a native `Post` via the shared creation
 * path, after mirroring its media to Oxy S3. Returns true on a fresh insert,
 * false when it already existed (dedup race) or creation failed.
 */
async function createPostFromNormalized(
  post: NormalizedExternalPost,
  ownerOxyUserId: string,
  did: string,
  instanceDomain: string,
): Promise<boolean> {
  const media: MediaItem[] = (post.media ?? []).map((item) => ({
    id: item.id,
    type: item.type,
    ...(item.remoteUrl ? { remoteUrl: item.remoteUrl } : {}),
    ...(item.alt ? { alt: item.alt } : {}),
    ...(item.width !== undefined ? { width: item.width } : {}),
    ...(item.height !== undefined ? { height: item.height } : {}),
    ...(item.durationSec !== undefined ? { durationSec: item.durationSec } : {}),
    ...(item.orientation !== undefined ? { orientation: item.orientation } : {}),
    ...(item.aspectRatio !== undefined ? { aspectRatio: item.aspectRatio } : {}),
  }));
  const attachments: ExtractedMediaAttachment[] = (post.media ?? []).map((item) => ({
    type: 'media',
    id: item.id,
    mediaType: item.type,
  }));

  const materialized = await materializeFederatedMedia(media, attachments, ownerOxyUserId, {
    activityId: post.activityId,
    actorUri: did,
  });

  // Resolve reply-parent + quoted AT-URIs to local thread/quote links (best-effort;
  // a not-yet-imported parent/quote is left unlinked).
  const links = await resolveThreadAndQuoteLinks(post.inReplyTo, post.quotedUri);

  try {
    await getPostCreator().create({
      oxyUserId: ownerOxyUserId,
      federation: {
        activityId: post.activityId,
        actorUri: did,
        inReplyTo: post.inReplyTo,
        url: post.url,
        sensitive: post.sensitive ?? false,
      },
      parentPostId: links.parentPostId ?? null,
      threadId: links.threadId ?? null,
      quoteOf: links.quoteOf ?? null,
      content: {
        text: post.text,
        media: materialized.media.length > 0 ? materialized.media : undefined,
        attachments: materialized.attachments.length > 0 ? materialized.attachments : undefined,
      },
      visibility: PostVisibility.PUBLIC,
      hashtags: post.hashtags,
      // Resolved @mention Oxy user ids, keyed by the `[mention:<id>]` placeholders
      // now in the body, so hydration renders each as a real profile link.
      mentions: post.mentions,
      language: post.language,
      languages: post.languages,
      instanceDomain,
      status: 'published',
      metadata: { isSensitive: post.sensitive === true },
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
      ...(post.createdAt ? { createdAt: post.createdAt, updatedAt: post.createdAt } : {}),
    });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    logger.warn(`[atproto] failed to import post ${post.activityId}`, err);
    return false;
  }
}

/**
 * Fetch `app.bsky.feed.getAuthorFeed` for the resolved atproto `actor`, map each
 * original `app.bsky.feed.post` to a native `Post`, dedup on the AT-URI, and
 * import the new ones. Reposts (items carrying a `reason`) are skipped in C2.
 *
 * The actor MUST already carry a resolved `oxyUserId` (no orphan posts).
 */
export async function importAuthorFeed(
  actor: NormalizedExternalActor,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ posts: NormalizedExternalPost[]; cursor?: string }> {
  const did = actor.externalId;
  const ownerOxyUserId = actor.oxyUserId;
  if (!ownerOxyUserId) {
    logger.warn(`[atproto] importAuthorFeed called for ${did} without a resolved Oxy user; skipping (no orphan)`);
    return { posts: [] };
  }
  // Stamp the actor's instance domain (e.g. `bsky.social`) on imported posts —
  // matching the AP convention (`Post.instanceDomain` = the actor's host), not
  // the bare full handle.
  const instanceDomain = actor.instanceDomain;

  let feed: AtprotoAuthorFeed;
  try {
    feed = await xrpcGet<AtprotoAuthorFeed>(PUBLIC_APPVIEW, 'app.bsky.feed.getAuthorFeed', {
      actor: did,
      limit: opts.limit ?? 20,
      cursor: opts.cursor,
    });
  } catch (err) {
    logger.debug(`[atproto] getAuthorFeed failed for ${did}`, err);
    return { posts: [] };
  }

  const items = Array.isArray(feed?.feed) ? feed.feed : [];

  // Pre-resolve every mentioned DID across the batch (deduped, fail-soft) so the
  // pure mapper can splice `[mention:<oxyUserId>]` placeholders in the same byte
  // pass as `#link` facets. Reposts are skipped here exactly as in the map loop.
  const mentionDids = new Set<string>();
  for (const item of items) {
    if (item?.reason) continue;
    for (const mentionedDid of extractMentionDids(item.post?.record)) mentionDids.add(mentionedDid);
  }
  const mentionMap = await resolveMentionDids(mentionDids);

  const normalized: NormalizedExternalPost[] = [];
  for (const item of items) {
    if (item?.reason) continue; // skip reposts in C2
    const mapped = mapPostViewToNormalizedPost(item.post, did, mentionMap);
    if (mapped) normalized.push({ ...mapped, authorOxyUserId: ownerOxyUserId });
  }

  if (normalized.length === 0) return { posts: [], cursor: feed?.cursor };

  // Dedup against AT-URIs already imported (the unique sparse
  // `federation.activityId` index is the backstop for concurrent races).
  const atUris = normalized.map((post) => post.activityId);
  const existingDocs = await Post.find({ 'federation.activityId': { $in: atUris } })
    .select('federation.activityId')
    .lean();
  const seen = new Set<string>();
  for (const doc of existingDocs) {
    const id = (doc as { federation?: { activityId?: string } }).federation?.activityId;
    if (id) seen.add(id);
  }

  const imported: NormalizedExternalPost[] = [];
  for (const post of normalized) {
    if (seen.has(post.activityId)) continue;
    const created = await createPostFromNormalized(post, ownerOxyUserId, did, instanceDomain);
    if (created) imported.push(post);
  }

  return { posts: imported, cursor: feed?.cursor };
}

/** The `app.bsky.feed.getPosts` response — only the field this connector reads. */
interface AtprotoGetPostsResponse {
  posts?: AtprotoPostView[];
}

/** Resolved local thread + quote links for a single re-fetched atproto post. */
export interface AtprotoRepairLinks {
  parentPostId?: string;
  threadId?: string;
  quoteOf?: string;
}

/** Outcome of re-fetching a single stored atproto post for in-place repair. */
export type AtprotoRepairFetch =
  | { kind: 'ok'; post: NormalizedExternalPost; links: AtprotoRepairLinks }
  | { kind: 'gone' }
  | { kind: 'error' };

/**
 * Re-fetch a single already-stored atproto post by its AT-URI and re-run the
 * CURRENT mapping, so a caller (the reingest repair script) can update the stored
 * `Post` in place through the SAME facet/quote/thread logic fresh ingest uses.
 *
 * `app.bsky.feed.getPosts` returns the identical hydrated `PostView` shape
 * `getAuthorFeed` does, so {@link mapPostViewToNormalizedPost} produces byte-for-byte
 * the same body (`#link` display text expanded to the full URL, resolved
 * `#mention`s spliced to `[mention:<oxyUserId>]`), hashtags, langs, sensitivity,
 * `inReplyTo` and quoted AT-URI as a live import. Mentioned DIDs are resolved
 * through the same batched, fail-soft path, and the reply / quote AT-URIs are
 * resolved to LOCAL thread + quote links exactly like {@link createPostFromNormalized}.
 *
 * The fetch is classified so the caller can distinguish a post that no longer
 * exists upstream (`gone` — the AppView returned no view for the URI, or the view
 * no longer maps to `expectedAuthorDid`) from a transient failure (`error` — leave
 * the stored post untouched for a later re-run).
 */
export async function refetchAtprotoPostForRepair(
  atUri: string,
  expectedAuthorDid: string,
  ownerOxyUserId: string,
): Promise<AtprotoRepairFetch> {
  let response: AtprotoGetPostsResponse;
  try {
    response = await xrpcGet<AtprotoGetPostsResponse>(PUBLIC_APPVIEW, 'app.bsky.feed.getPosts', { uris: atUri });
  } catch (err) {
    logger.warn(`[atproto] getPosts failed for repair of ${atUri}`, err);
    return { kind: 'error' };
  }

  // The AppView echoes the requested URI; a deleted / blocked / unresolvable post
  // is silently omitted, so an absent view is a permanently-gone post.
  const postView = Array.isArray(response.posts)
    ? response.posts.find((view) => view?.uri === atUri)
    : undefined;
  if (!postView) return { kind: 'gone' };

  const mentionMap = await resolveMentionDids(new Set(extractMentionDids(postView.record)));
  const mapped = mapPostViewToNormalizedPost(postView, expectedAuthorDid, mentionMap);
  // A view that no longer maps (author reassigned the handle, record type changed)
  // is treated as gone rather than silently repaired against the wrong author.
  if (!mapped) return { kind: 'gone' };

  const post: NormalizedExternalPost = { ...mapped, authorOxyUserId: ownerOxyUserId };
  const links = await resolveThreadAndQuoteLinks(post.inReplyTo, post.quotedUri);
  return { kind: 'ok', post, links };
}

/** How many distinct post authors to resolve to Oxy users in parallel. */
const FEED_AUTHOR_CONCURRENCY = 6;

/** The `app.bsky.feed.getFeed` response — the same hydrated shape `getAuthorFeed` returns. */
interface AtprotoGetFeedResponse {
  feed?: AtprotoFeedItem[];
  cursor?: string;
}

/**
 * Fetch one page of a Bluesky FEED GENERATOR's output (`app.bsky.feed.getFeed`)
 * from the public AppView. Returns the hydrated `PostView`s in the generator's
 * ranking ORDER plus the paging cursor.
 *
 * `getFeed` returns the identical hydrated `PostView` shape `getAuthorFeed` does,
 * so its posts feed straight into {@link importPostViews} → the same native-post
 * import path the author-feed backfill uses. Unlike an author feed, a generator
 * mixes many authors and its items carry the algorithm's ranking, so the `.post`
 * of every item is kept in order (a `reason`/repost item still resolves to the
 * post's REAL author, which is what gets imported). Fail-soft: a fetch error
 * yields an empty page, never throws.
 */
export async function getFeed(
  feedUri: string,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ posts: AtprotoPostView[]; cursor?: string }> {
  let response: AtprotoGetFeedResponse;
  try {
    response = await xrpcGet<AtprotoGetFeedResponse>(PUBLIC_APPVIEW, 'app.bsky.feed.getFeed', {
      feed: feedUri,
      limit: opts.limit ?? 30,
      cursor: opts.cursor,
    });
  } catch (err) {
    logger.debug(`[atproto] getFeed failed for ${feedUri}`, err);
    return { posts: [] };
  }

  const items = Array.isArray(response?.feed) ? response.feed : [];
  const posts: AtprotoPostView[] = [];
  for (const item of items) {
    if (item?.post) posts.push(item.post);
  }
  return { posts, cursor: response?.cursor };
}

/** A resolved post author: the federated Oxy user + the instance domain to stamp on the post. */
interface ResolvedAuthor {
  oxyUserId: string;
  instanceDomain: string;
}

/**
 * Resolve each DISTINCT post-author DID to its federated Oxy user (mints it if new)
 * through the shared atproto profile path, with bounded concurrency. Returns a
 * `did → {oxyUserId, instanceDomain}` map; DIDs that fail to resolve to an Oxy user
 * are absent (fail-soft — a post whose author we can't mint is dropped, no orphan).
 */
async function resolveFeedAuthors(dids: readonly string[]): Promise<Map<string, ResolvedAuthor>> {
  const map = new Map<string, ResolvedAuthor>();
  if (dids.length === 0) return map;

  const settled = await mapWithConcurrency(dids, FEED_AUTHOR_CONCURRENCY, async (did) => {
    const actor = await fetchAndUpsertAtprotoProfile(did);
    return actor?.oxyUserId
      ? { did, oxyUserId: String(actor.oxyUserId), instanceDomain: actor.instanceDomain }
      : undefined;
  });

  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      const { did, oxyUserId, instanceDomain } = result.value;
      map.set(did, { oxyUserId, instanceDomain });
    }
  }
  return map;
}

/**
 * Import a batch of hydrated `PostView`s (from a feed generator's {@link getFeed})
 * as native `Post` rows, and return the AT-URIs that map to a local post — in INPUT
 * ORDER — so the caller can load + hydrate them preserving the generator's ranking.
 *
 * This is the MULTI-AUTHOR sibling of {@link importAuthorFeed}: a generator feed
 * mixes many authors, so each post's author is independently resolved/minted to its
 * federated Oxy user (deduped, bounded). Everything else reuses the exact same path
 * as the author-feed backfill — {@link mapPostViewToNormalizedPost} (author validated
 * against its own DID), the batched mention resolution, media materialization,
 * AT-URI dedup, and {@link createPostFromNormalized}. Best-effort + fail-soft: an
 * unresolvable author or unmappable view is skipped, a duplicate is a no-op, and
 * nothing throws. A returned URI whose creation genuinely failed simply won't have a
 * local `Post` for the caller to load — it drops out of the page rather than
 * appearing blank.
 */
export async function importPostViews(postViews: ReadonlyArray<AtprotoPostView | undefined>): Promise<string[]> {
  // Keep only real feed-post views that carry both an AT-URI and an author DID, in
  // the generator's order.
  const candidates: Array<{ uri: string; did: string; view: AtprotoPostView }> = [];
  for (const view of postViews) {
    const uri = typeof view?.uri === 'string' ? view.uri : '';
    const did = typeof view?.author?.did === 'string' ? view.author.did : '';
    if (!uri || !did) continue;
    const parsed = parseAtUri(uri);
    if (!parsed || parsed.collection !== POST_COLLECTION) continue;
    candidates.push({ uri, did, view: view as AtprotoPostView });
  }
  if (candidates.length === 0) return [];

  // Resolve each distinct author to its federated Oxy user (no orphan posts) and
  // pre-resolve every mentioned DID across the batch, both bounded + fail-soft.
  const authorMap = await resolveFeedAuthors([...new Set(candidates.map((c) => c.did))]);
  const mentionDids = new Set<string>();
  for (const candidate of candidates) {
    for (const mentionedDid of extractMentionDids(candidate.view.record)) mentionDids.add(mentionedDid);
  }
  const mentionMap = await resolveMentionDids(mentionDids);

  // Map each view to a normalized post (author validated against its own DID).
  const mapped: Array<{ uri: string; post: NormalizedExternalPost; owner: string; did: string; instanceDomain: string }> = [];
  for (const candidate of candidates) {
    const author = authorMap.get(candidate.did);
    if (!author) continue; // unresolved author → skip (no orphan)
    const normalized = mapPostViewToNormalizedPost(candidate.view, candidate.did, mentionMap);
    if (!normalized) continue;
    mapped.push({
      uri: candidate.uri,
      post: { ...normalized, authorOxyUserId: author.oxyUserId },
      owner: author.oxyUserId,
      did: candidate.did,
      instanceDomain: author.instanceDomain,
    });
  }
  if (mapped.length === 0) return [];

  // Dedup against AT-URIs already imported (the unique sparse `federation.activityId`
  // index is the backstop for concurrent races), then create the new ones. Every
  // mapped URI is returned in order — a pre-existing / freshly-created / dup-raced
  // post all have a local `Post`; only a genuine creation failure has none, and the
  // caller's load naturally drops it.
  const atUris = mapped.map((entry) => entry.uri);
  const existingDocs = await Post.find({ 'federation.activityId': { $in: atUris } })
    .select('federation.activityId')
    .lean();
  const seen = new Set<string>();
  for (const doc of existingDocs) {
    const id = (doc as { federation?: { activityId?: string } }).federation?.activityId;
    if (id) seen.add(id);
  }

  for (const entry of mapped) {
    if (!seen.has(entry.uri)) {
      await createPostFromNormalized(entry.post, entry.owner, entry.did, entry.instanceDomain);
    }
  }
  return atUris;
}
