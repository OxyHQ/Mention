import { PostVisibility } from '@mention/shared-types';
import { normalizeMultilineText } from '@oxy.so/core';
import { isUniqueViolation } from '@oxy.so/db';
import { logger } from '../../utils/logger';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { findActorByUri, findActorsByUris } from '../../db/federation/actorRepository';
import { setFederatedAuthorPinnedPost } from '../../db/posts/postRepository';
import { normalizeAlt } from '../../services/MediaMetadataService';
import { getPostCreator } from '../../services/serviceRegistry';
import { previewableUrls } from '../../utils/clarityDocuments';
import { mapWithConcurrency } from '../../utils/concurrency';
import { materializeFederatedMedia, type ExtractedMediaAttachment } from '../shared/federatedMedia';
import { createFederatedBoost } from '../shared/federatedBoost';
import {
  findPostsByFederatedObjects,
  postMatchesFederatedObjectSql,
  upstreamPostKey,
} from '../shared/upstreamPostKey';
import { absorbTransportCopy, transportCopyFacts } from '../shared/transportCopies';
import { findRecordedTransportCopies } from '../../db/posts/postTransportCopyRepository';
import { toStoredContent } from '../../services/postVariants';
import {
  linkPreviewKey,
  remoteLinkPreview,
  remoteLinkUrl,
  storeRemoteLinkPreviews,
  type RemoteLinkPreview,
} from '../shared/linkPreviews';
import type { MediaItem, PostContent } from '@mention/shared-types';
import type {
  NormalizedExternalActor,
  NormalizedExternalMedia,
  NormalizedExternalPost,
} from '@oxy.so/federation';
import { xrpcGet } from './xrpcClient';
import { fetchAndUpsertAtprotoProfile } from './profile.mapper';
import { pdsEndpointFromDidDocument, resolveDidDocument } from './identityResolver';
import { atprotoLabelValues, type AtprotoLabel } from './labels';
import {
  BSKY_APP_ORIGIN,
  BSKY_MODERATION_LABELER,
  POST_COLLECTION,
  PUBLIC_APPVIEW,
} from './constants';
import { clampFutureDate } from '../../utils/ingestTimestamp';

/**
 * Maps Bluesky `app.bsky.feed.post` records (from `app.bsky.feed.getAuthorFeed`
 * and feed generators) into native `posts` rows via the SAME
 * `getPostCreator().create({...})` path the ActivityPub ingest uses, deduped on
 * `posts.federation_activity_id` (the AT-URI), with remote media mirrored to Oxy
 * S3 by the shared `materializeFederatedMedia`, link cards stored by the shared
 * `storeRemoteLinkPreviews`, and reposts stored as boosts by the shared
 * `createFederatedBoost`.
 */

/** Adult/sensitive label values that flip a post's content warning on. */
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
  /**
   * The quote as the author wrote it: `app.bsky.embed.record` names the quoted
   * post by strong ref, `app.bsky.embed.recordWithMedia` nests that under `record`.
   */
  embed?: { $type?: string; record?: { uri?: string; record?: { uri?: string } } };
}
interface AtprotoEmbedImage {
  thumb?: string;
  fullsize?: string;
  alt?: string;
  aspectRatio?: { width: number; height: number };
}
interface AtprotoAuthor {
  did?: string;
  handle?: string;
}
/**
 * A hydrated record embed view. Self-referential so it covers both nesting levels:
 * a top-level `app.bsky.embed.record#view` whose `.record` is the quoted
 * `#viewRecord`, and the `app.bsky.embed.recordWithMedia#view` whose `.record` is
 * a nested `#view` whose `.record` is that `#viewRecord`. The `#viewRecord` is
 * the quoted post itself, hydrated: its record is `value` and its embeds
 * `embeds`.
 */
interface AtprotoEmbedRecordView {
  $type?: string;
  uri?: string;
  cid?: string;
  author?: AtprotoAuthor;
  value?: AtprotoPostRecord;
  labels?: AtprotoLabel[];
  embeds?: AtprotoEmbedView[];
  indexedAt?: string;
  record?: AtprotoEmbedRecordView;
}
/** `app.bsky.embed.external#viewExternal` — a link card, or a GIF from the picker. */
interface AtprotoExternalView {
  uri?: string;
  title?: string;
  description?: string;
}
interface AtprotoEmbedView {
  $type?: string;
  images?: AtprotoEmbedImage[];
  /** `app.bsky.embed.video#view`: the video blob's CID, its HLS manifest, poster and alt. */
  cid?: string;
  playlist?: string;
  thumbnail?: string;
  alt?: string;
  aspectRatio?: { width: number; height: number };
  external?: AtprotoExternalView;
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
  author?: AtprotoAuthor;
  record?: AtprotoPostRecord;
  embed?: AtprotoEmbedView;
  /** Self-labels AND labels a labeler applied (Bluesky's moderation service by default). */
  labels?: AtprotoLabel[];
  indexedAt?: string;
}
/** `#reasonRepost` on a repost, `#reasonPin` on the pinned post. */
interface AtprotoFeedReason {
  $type?: string;
  /** The reposter. */
  by?: AtprotoAuthor;
  /** The `app.bsky.feed.repost` record's AT-URI — the repost's own identity. */
  uri?: string;
  indexedAt?: string;
}
interface AtprotoFeedItem {
  post?: AtprotoPostView;
  /**
   * The post this item replies to and its thread root, hydrated. Either can be a
   * `#notFoundPost` / `#blockedPost` stub, which carries no record and maps to
   * nothing.
   */
  reply?: { root?: AtprotoPostView; parent?: AtprotoPostView };
  reason?: AtprotoFeedReason;
}

const REASON_PIN = 'app.bsky.feed.defs#reasonPin';
const REASON_REPOST = 'app.bsky.feed.defs#reasonRepost';

/** True for the author's pinned post, which `includePins` puts first on page one. */
function isPinItem(item: AtprotoFeedItem | undefined): boolean {
  return item?.reason?.$type === REASON_PIN;
}
interface AtprotoAuthorFeed {
  feed?: AtprotoFeedItem[];
  cursor?: string;
}

/**
 * A normalized atproto post plus what only this connector reads off it: the
 * thread root (atproto names it on every reply), and the link a post's external
 * embed is about with the card the author's client rendered for it.
 */
export interface AtprotoNormalizedPost extends NormalizedExternalPost {
  rootUri?: string;
  linkUrl?: string;
  linkPreview?: RemoteLinkPreview;
}

/** Parse an AT-URI `at://<authority>/<collection>/<rkey>` into its parts. */
function parseAtUri(uri: string): { authority: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!match) return null;
  return { authority: match[1], collection: match[2], rkey: match[3] };
}

/**
 * Parse an atproto `createdAt`, rejecting NaN and far-future dates. The guard is
 * {@link clampFutureDate}, shared with every other ingest path; only the tolerance
 * window is an atproto policy decision.
 */
function parseCreatedAt(value: unknown): Date | undefined {
  return clampFutureDate(value, MAX_FUTURE_SKEW_MS);
}

/** Extract hashtags from richtext `#tag` facets and the record-level `tags`. */
function extractHashtags(record: AtprotoPostRecord): string[] {
  const tags = new Set<string>();
  for (const tag of record.tags ?? []) {
    if (typeof tag === 'string' && tag.trim()) tags.add(tag.trim().replace(/^#/, '').toLowerCase());
  }
  for (const facet of record.facets ?? []) {
    for (const feature of facet.features ?? []) {
      if (
        feature?.$type === 'app.bsky.richtext.facet#tag' &&
        typeof feature.tag === 'string' &&
        feature.tag.trim()
      ) {
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
      if (
        feature?.$type === 'app.bsky.richtext.facet#mention' &&
        typeof feature.did === 'string' &&
        feature.did
      ) {
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
      if (
        feature?.$type === 'app.bsky.richtext.facet#link' &&
        typeof feature.uri === 'string' &&
        feature.uri
      ) {
        ops.push({ byteStart, byteEnd, replacement: feature.uri });
        break; // one replacement per facet byte range
      }
      if (
        feature?.$type === 'app.bsky.richtext.facet#mention' &&
        typeof feature.did === 'string' &&
        feature.did
      ) {
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
    out = Buffer.concat([
      out.subarray(0, op.byteStart),
      Buffer.from(op.replacement, 'utf8'),
      out.subarray(op.byteEnd),
    ]);
    nextStart = op.byteStart;
  }
  return out.toString('utf8');
}

/**
 * The quoted record's view in a record embed (`app.bsky.embed.record#view`, or
 * the record half of `app.bsky.embed.recordWithMedia#view`), whatever its kind.
 */
function embeddedRecordView(
  embed: AtprotoEmbedView | undefined,
): AtprotoEmbedRecordView | undefined {
  return embed?.$type === 'app.bsky.embed.record#view'
    ? embed.record
    : embed?.$type === 'app.bsky.embed.recordWithMedia#view'
      ? embed.record?.record
      : undefined;
}

/** The AT-URI of the post an `app.bsky.feed.post` record quotes, from its own embed. */
function recordQuotedUri(record: AtprotoPostRecord | undefined): string | undefined {
  const embed = record?.embed;
  const uri =
    embed?.$type === 'app.bsky.embed.record'
      ? embed.record?.uri
      : embed?.$type === 'app.bsky.embed.recordWithMedia'
        ? embed.record?.record?.uri
        : undefined;
  return typeof uri === 'string' && parseAtUri(uri)?.collection === POST_COLLECTION
    ? uri
    : undefined;
}

/**
 * Hydrated quote stubs whose URI still names the quoted post. The AppView did
 * not hydrate it (deleted, or a block between the accounts), but the quote is
 * the author's own statement, so the link is kept: it resolves only to a post
 * already imported here, and nothing is read from the stub. `#viewDetached` is
 * not one of them: the quoted author removed their post from this quote, and
 * re-attaching it would undo that choice.
 */
const UNHYDRATED_QUOTE_VIEWS: ReadonlySet<string> = new Set([
  'app.bsky.embed.record#viewNotFound',
  'app.bsky.embed.record#viewBlocked',
]);

/**
 * The AT-URI of the post a post view quotes: the hydrated `#viewRecord`'s, or,
 * for a {@link UNHYDRATED_QUOTE_VIEWS} stub, the record's own strong ref. Pure.
 */
function quotedPostUri(postView: AtprotoPostView): string | undefined {
  const hydrated = quotedRecordView(postView.embed)?.uri;
  if (hydrated) return hydrated;
  const stub = embeddedRecordView(postView.embed);
  return stub?.$type && UNHYDRATED_QUOTE_VIEWS.has(stub.$type)
    ? recordQuotedUri(postView.record)
    : undefined;
}

/**
 * The quoted post's hydrated `#viewRecord` from a record embed
 * (`app.bsky.embed.record#view`, or the record half of
 * `app.bsky.embed.recordWithMedia#view`) — but ONLY when the quoted record is a
 * real, viewable feed post (`#viewRecord` of `app.bsky.feed.post`). A blocked /
 * detached / not-found / feed-generator / list embed yields nothing. Pure.
 */
function quotedRecordView(
  embed: AtprotoEmbedView | undefined,
): (AtprotoEmbedRecordView & { uri: string }) | undefined {
  const recordView = embeddedRecordView(embed);
  if (
    recordView?.$type === 'app.bsky.embed.record#viewRecord' &&
    typeof recordView.uri === 'string' &&
    parseAtUri(recordView.uri)?.collection === POST_COLLECTION
  ) {
    return recordView as AtprotoEmbedRecordView & { uri: string };
  }
  return undefined;
}

/**
 * The quoted post, re-shaped from its `#viewRecord` into the PostView it is, so
 * it imports through the same path as any other post. Pure.
 */
function quotedPostView(embed: AtprotoEmbedView | undefined): AtprotoPostView | undefined {
  const view = quotedRecordView(embed);
  if (!view) return undefined;
  return {
    uri: view.uri,
    cid: view.cid,
    author: view.author,
    record: view.value,
    embed: view.embeds?.[0],
    labels: view.labels,
    indexedAt: view.indexedAt,
  };
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

/**
 * True when the post carries an adult label: one of the author's self-labels
 * (in the record), or one the AppView applied — the author's own again, or
 * Bluesky's moderation service's. Any other labeler's verdict is ignored.
 */
function hasAdultLabel(postView: AtprotoPostView, authorDid: string): boolean {
  const selfLabels = postView.record?.labels?.values;
  if (
    Array.isArray(selfLabels) &&
    selfLabels.some((entry) => typeof entry?.val === 'string' && ADULT_LABEL_VALUES.has(entry.val))
  ) {
    return true;
  }
  const applied = atprotoLabelValues(postView.labels, [authorDid, BSKY_MODERATION_LABELER]);
  return [...applied].some((value) => ADULT_LABEL_VALUES.has(value));
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
 * The original bytes of a post's video: the blob on the author's PDS
 * (`com.atproto.sync.getBlob`), a progressive file the media mirror stores like
 * any other remote video. The AppView's `playlist` is an HLS manifest of
 * relative segment paths on Bluesky's video CDN: mirroring it stores a text file,
 * and proxying it breaks every segment. Undefined without an https PDS. Pure.
 */
function videoBlobUrl(
  pdsEndpoint: string | undefined,
  did: string,
  cid: string | undefined,
): string | undefined {
  if (!pdsEndpoint || !cid) return undefined;
  try {
    const url = new URL('/xrpc/com.atproto.sync.getBlob', pdsEndpoint);
    if (url.protocol !== 'https:') return undefined;
    url.searchParams.set('did', did);
    url.searchParams.set('cid', cid);
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * A GIF from Bluesky's picker: an external embed whose URL is the GIF itself
 * (`https://media.tenor.com/<id>/<name>.gif?hh=<height>&ww=<width>`). Stored as
 * an image, as an ActivityPub GIF attachment is. The picker writes the author's
 * alt text into the card's description, behind an `Alt: ` prefix. Pure.
 */
function gifFromExternal(external: AtprotoExternalView): NormalizedExternalMedia | undefined {
  let url: URL;
  try {
    url = new URL(external.uri ?? '');
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || !/\.gif$/i.test(url.pathname)) return undefined;
  const width = Number(url.searchParams.get('ww'));
  const height = Number(url.searchParams.get('hh'));
  const alt =
    typeof external.description === 'string'
      ? external.description.replace(/^alt:\s*/i, '')
      : undefined;
  return {
    id: url.href,
    type: 'image',
    remoteUrl: url.href,
    alt: normalizeAlt(alt),
    ...(Number.isFinite(width) && Number.isFinite(height)
      ? patchFromAspectRatio({ width, height })
      : {}),
  };
}

/**
 * What a hydrated embed VIEW carries: its media, and the link card of an
 * external embed. Bluesky returns full CDN URLs in `app.bsky.embed.images#view`
 * (`fullsize`); a video is its blob ({@link videoBlobUrl}); an external embed is
 * a GIF ({@link gifFromExternal}) or a link card; `recordWithMedia` nests its
 * media under `.media`. `pdsEndpoint` is the post author's PDS.
 */
function extractEmbedContent(
  embed: AtprotoEmbedView | undefined,
  did: string,
  pdsEndpoint: string | undefined,
): { media: NormalizedExternalMedia[]; linkPreview?: RemoteLinkPreview; linkUrl?: string } {
  const media: NormalizedExternalMedia[] = [];
  let linkUrl: string | undefined;
  let linkPreview: RemoteLinkPreview | undefined;
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
            media.push({
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
        const alt = normalizeAlt(view.alt);
        const shape = patchFromAspectRatio(view.aspectRatio);
        const url = videoBlobUrl(pdsEndpoint, did, view.cid);
        if (url) {
          media.push({ id: url, type: 'video', remoteUrl: url, alt, ...shape });
        } else if (typeof view.thumbnail === 'string' && view.thumbnail) {
          // No playable source: the poster frame is still a picture of the post,
          // and it is stored as what it is.
          media.push({
            id: view.thumbnail,
            type: 'image',
            remoteUrl: view.thumbnail,
            alt,
            ...shape,
          });
        }
        break;
      }
      case 'app.bsky.embed.external#view': {
        const external = view.external;
        if (!external) break;
        const gif = gifFromExternal(external);
        if (gif) {
          media.push(gif);
          break;
        }
        linkUrl = remoteLinkUrl(external.uri);
        linkPreview = remoteLinkPreview({
          url: external.uri,
          title: external.title,
          description: external.description,
        });
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
  return { media, linkUrl, linkPreview };
}

/**
 * Map a single `app.bsky.feed.post` PostView into a network-neutral post.
 *
 * Returns null for anything that is not an `app.bsky.feed.post` authored by
 * `expectedAuthorDid` (the synced actor) — mirroring the ActivityPub
 * actor-match guard so an author feed cannot smuggle in another actor's post.
 * `pdsEndpoint` is the author's PDS, which a video's playable bytes live on.
 */
export function mapPostViewToNormalizedPost(
  postView: AtprotoPostView | undefined,
  expectedAuthorDid: string,
  mentionMap: ReadonlyMap<string, string> = new Map(),
  pdsEndpoint?: string,
): AtprotoNormalizedPost | null {
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
  const embed = extractEmbedContent(postView.embed, did, pdsEndpoint);
  const inReplyTo =
    typeof record.reply?.parent?.uri === 'string' ? record.reply.parent.uri : undefined;
  const rootUri = typeof record.reply?.root?.uri === 'string' ? record.reply.root.uri : undefined;
  const quotedUri = quotedPostUri(postView);

  // Rewrite richtext facets over the RAW body FIRST, then normalize whitespace:
  // the facet indices are byte offsets into `record.text`, so they must be applied
  // before normalization shifts the bytes. `#link` display text becomes the full
  // URL; resolved `#mention`s become `[mention:<oxyUserId>]` placeholders.
  const rawText = typeof record.text === 'string' ? record.text : '';
  const { ops, mentionIds } = buildFacetReplacements(record, mentionMap);
  // The post body is third-party text: the author's line breaks are meaningful and
  // survive, but the surrounding whitespace noise is normalized away.
  const text = normalizeMultilineText(applyFacetReplacements(rawText, ops));

  // The external embed's link becomes the post's subject link (`content.linkUrl`)
  // only when the body does not already carry it — the usual case, since the
  // composer strips the pasted URL once it turns it into a card.
  const linkKey = embed.linkUrl ? linkPreviewKey(embed.linkUrl) : undefined;
  const bodyCarriesLink =
    linkKey !== undefined && previewableUrls(text).some((link) => linkPreviewKey(link) === linkKey);

  return {
    network: 'atproto',
    activityId: postView.uri,
    actorUri: did,
    url,
    inReplyTo,
    rootUri,
    quotedUri,
    sensitive: hasAdultLabel(postView, did),
    authorOxyUserId: undefined,
    text,
    media: embed.media.length > 0 ? embed.media : undefined,
    linkUrl: bodyCarriesLink ? undefined : embed.linkUrl,
    linkPreview: embed.linkPreview,
    hashtags: extractHashtags(record),
    mentions: mentionIds.length > 0 ? mentionIds : undefined,
    language: langs[0],
    languages: langs.length > 0 ? langs : undefined,
    createdAt: parseCreatedAt(record.createdAt),
  };
}

/**
 * Resolve a mentioned atproto DID to its Oxy user id. Prefers an already-synced
 * `federated_actors` row (no network round trip); otherwise resolves + mints the actor
 * through the shared atproto profile path (`fetchAndUpsertAtprotoProfile`). Returns
 * undefined (fail-soft) when the DID cannot be resolved to an Oxy user — the caller
 * then leaves the bare `@handle` display text rather than minting a broken link.
 */
async function resolveAtprotoMentionOxyId(
  did: string,
  allowIdentityMutation = true,
): Promise<string | undefined> {
  try {
    const existing = await findActorByUri(did);
    if (existing?.oxyUserId) return existing.oxyUserId;
  } catch (err) {
    logger.warn('[atproto] mention actor lookup failed', err);
  }
  if (!allowIdentityMutation) return undefined;
  const actor = await fetchAndUpsertAtprotoProfile(did);
  return actor?.oxyUserId ? String(actor.oxyUserId) : undefined;
}

/**
 * Batch-resolve every mentioned DID in an author feed to its Oxy user id (deduped,
 * parallel, fail-soft). The returned map feeds the pure mapper so it can splice
 * `[mention:<oxyUserId>]` placeholders in the same byte pass as `#link` facets.
 * Unresolvable DIDs are simply absent from the map.
 */
async function resolveMentionDids(
  dids: Set<string>,
  allowIdentityMutation = true,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (dids.size === 0) return map;
  await Promise.all(
    [...dids].map(async (did) => {
      const oxyUserId = await resolveAtprotoMentionOxyId(did, allowIdentityMutation);
      if (oxyUserId) map.set(did, oxyUserId);
    }),
  );
  return map;
}

/**
 * Resolve a federated atproto post's reply parent, thread root and quoted
 * AT-URIs to LOCAL thread + quote links by matching each against an imported
 * post — natively, or the same post stored through Bridgy Fed. The ActivityPub reply rule (`threadId =
 * parent.threadId ?? parent._id`), except that atproto NAMES the root on every
 * reply, so an unlinked parent still joins the root's thread. The importers
 * store the parent, root and quoted post first ({@link importPostViewBatch}), so
 * a miss here is a post that could not be imported (deleted, blocked, an
 * unresolvable author) and is left unlinked.
 */
async function resolveThreadAndQuoteLinks(
  post: AtprotoNormalizedPost,
): Promise<{ parentPostId?: string; threadId?: string; quoteOf?: string }> {
  const uris = [post.inReplyTo, post.rootUri, post.quotedUri].filter(
    (uri): uri is string => typeof uri === 'string' && uri.length > 0,
  );
  if (uris.length === 0) return {};

  const byUri = await findPostsByFederatedObjects(uris);

  const links: { parentPostId?: string; threadId?: string; quoteOf?: string } = {};
  const parent = post.inReplyTo ? byUri.get(post.inReplyTo) : undefined;
  if (parent) {
    const root = post.rootUri ? byUri.get(post.rootUri) : undefined;
    links.parentPostId = parent.id;
    links.threadId = parent.threadId ?? root?.id ?? parent.id;
  }
  const quoted = post.quotedUri ? byUri.get(post.quotedUri) : undefined;
  if (quoted) links.quoteOf = quoted.id;
  return links;
}

/** A normalized post's media re-hosted in Oxy and its thread/quote links: what both writes need. */
async function prepareNormalizedPost(
  post: AtprotoNormalizedPost,
  ownerOxyUserId: string,
  did: string,
) {
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
  const links = await resolveThreadAndQuoteLinks(post);
  const content: PostContent = {
    text: post.text,
    linkUrl: post.linkUrl,
    media: materialized.media.length > 0 ? materialized.media : undefined,
    attachments: materialized.attachments.length > 0 ? materialized.attachments : undefined,
  };
  return { content, links };
}

/**
 * Persist a normalized atproto post as a native `Post` via the shared creation
 * path, after mirroring its media to Oxy S3, and store the card its external
 * embed carried. Returns true on a fresh insert, false when it already existed
 * (dedup race) or creation failed.
 */
async function createPostFromNormalized(
  post: AtprotoNormalizedPost,
  ownerOxyUserId: string,
  did: string,
  instanceDomain: string,
): Promise<boolean> {
  const { content, links } = await prepareNormalizedPost(post, ownerOxyUserId, did);

  try {
    const created = await getPostCreator().create({
      oxyUserId: ownerOxyUserId,
      federation: {
        activityId: post.activityId,
        actorUri: did,
        inReplyTo: post.inReplyTo,
        url: post.url,
        sensitive: post.sensitive ?? false,
        sourcePostKey: upstreamPostKey(post.activityId),
      },
      parentPostId: links.parentPostId ?? null,
      threadId: links.threadId ?? null,
      quoteOf: links.quoteOf ?? null,
      content,
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
    // The card the author's client rendered: the fallback for a link Clarity
    // has not described yet, exactly as an ActivityPub FEP-8967 card.
    if (post.linkPreview) await storeRemoteLinkPreviews(created.id, [post.linkPreview]);
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    logger.warn('[atproto] failed to import post', err);
    return false;
  }
}

/**
 * Merge a normalized atproto post into the post another transport (Bridgy Fed)
 * already stored under the same at-URI key (`../shared/transportCopies`).
 */
async function absorbNormalizedCopy(
  postId: string,
  post: AtprotoNormalizedPost,
  ownerOxyUserId: string,
  did: string,
): Promise<void> {
  const { content, links } = await prepareNormalizedPost(post, ownerOxyUserId, did);
  const stored = toStoredContent(content, post.language);
  await absorbTransportCopy(postId, {
    objectUri: post.activityId,
    actorUri: did,
    facts: transportCopyFacts({
      actorUri: did,
      content: stored,
      createdAt: post.createdAt,
      url: post.url,
      inReplyTo: post.inReplyTo,
      quoteOf: links.quoteOf,
      replyTo:
        links.parentPostId && links.threadId
          ? { parentPostId: links.parentPostId, threadId: links.threadId }
          : null,
      language: post.language,
      sensitive: post.sensitive,
    }),
    content: stored,
    mentions: post.mentions ?? [],
  });
}

/** How many distinct post authors to resolve to Oxy users in parallel. */
const FEED_AUTHOR_CONCURRENCY = 6;

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

/** True when a post view embeds a video, whose playable bytes live on the author's PDS. */
function embedsVideo(view: AtprotoPostView): boolean {
  const embed = view.embed;
  return (
    embed?.$type === 'app.bsky.embed.video#view' ||
    embed?.media?.$type === 'app.bsky.embed.video#view'
  );
}

/**
 * Resolve the PDS of each DISTINCT author DID (its DID document's
 * `#atproto_pds`), bounded + fail-soft: an author whose document cannot be read
 * is absent, and its video keeps only its poster.
 */
async function resolvePdsEndpoints(dids: readonly string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const settled = await mapWithConcurrency(dids, FEED_AUTHOR_CONCURRENCY, async (did) => {
    const doc = await resolveDidDocument(did);
    const endpoint = doc ? pdsEndpointFromDidDocument(doc) : undefined;
    return endpoint ? { did, endpoint } : undefined;
  });
  for (const result of settled) {
    if (result.status === 'fulfilled' && result.value) {
      map.set(result.value.did, result.value.endpoint);
    }
  }
  return map;
}

/** One post view of a batch that mapped to a native post. */
interface ImportedView {
  uri: string;
  post: AtprotoNormalizedPost;
  /** False when it was already stored (or lost a dedup race, or creation failed). */
  created: boolean;
}

/**
 * Import a batch of hydrated `PostView`s as native `Post` rows, in input order —
 * the ONE path every atproto post takes, whether it is an author's own, a post
 * in a feed generator, a reposted original, or the context of one of those.
 *
 * `context` is the posts the batch replies to (a feed item's hydrated
 * `reply.root` / `reply.parent`); the posts the batch QUOTES are read off each
 * view's own embed. All of them are imported FIRST, so the batch's reply and
 * quote links resolve against real local rows — the equivalent of the
 * ActivityPub ancestor and quote imports (`ensureFederatedReplyLink`,
 * `ensureQuotedNote`). The recursion is one level deep: a context post's own
 * parent or quote links only if it is already stored.
 *
 * Each post's author is resolved to its federated Oxy user (deduped, bounded);
 * `authors` seeds already-resolved ones. A post whose author cannot be resolved
 * is skipped (no orphan), each view is validated against its OWN author's DID,
 * and the AT-URI dedup (its activity id, or the same post stored through
 * Bridgy Fed under its upstream key; both backstopped by unique indexes) makes
 * a re-import a no-op. Best-effort + fail-soft; nothing throws.
 */
async function importPostViewBatch(
  postViews: ReadonlyArray<AtprotoPostView | undefined>,
  options: {
    authors?: ReadonlyMap<string, ResolvedAuthor>;
    context?: ReadonlyArray<AtprotoPostView | undefined>;
    withContext?: boolean;
  } = {},
): Promise<ImportedView[]> {
  // Keep only real feed-post views that carry both an AT-URI and an author DID,
  // once each, in order.
  const candidates: Array<{ uri: string; did: string; view: AtprotoPostView }> = [];
  for (const view of postViews) {
    const uri = typeof view?.uri === 'string' ? view.uri : '';
    const did = typeof view?.author?.did === 'string' ? view.author.did : '';
    if (!uri || !did || candidates.some((candidate) => candidate.uri === uri)) continue;
    if (parseAtUri(uri)?.collection !== POST_COLLECTION) continue;
    candidates.push({ uri, did, view: view as AtprotoPostView });
  }

  if (options.withContext !== false) {
    const own = new Set(candidates.map((candidate) => candidate.uri));
    const context = [
      ...(options.context ?? []),
      ...candidates.map((candidate) => quotedPostView(candidate.view.embed)),
    ].filter((view) => typeof view?.uri === 'string' && !own.has(view.uri));
    if (context.length > 0) {
      await importPostViewBatch(context, { authors: options.authors, withContext: false });
    }
  }
  if (candidates.length === 0) return [];

  // Resolve each distinct author to its federated Oxy user (no orphan posts),
  // pre-resolve every mentioned DID across the batch, and find the PDS of each
  // author who posted a video — all bounded + fail-soft.
  const authorMap = new Map(options.authors);
  const unresolved = [...new Set(candidates.map((c) => c.did))].filter((d) => !authorMap.has(d));
  for (const [did, author] of await resolveFeedAuthors(unresolved)) authorMap.set(did, author);
  const mentionDids = new Set<string>();
  for (const candidate of candidates) {
    for (const mentionedDid of extractMentionDids(candidate.view.record))
      mentionDids.add(mentionedDid);
  }
  const mentionMap = await resolveMentionDids(mentionDids);
  const pdsMap = await resolvePdsEndpoints([
    ...new Set(candidates.filter((c) => embedsVideo(c.view)).map((c) => c.did)),
  ]);

  const mapped: Array<{ uri: string; post: AtprotoNormalizedPost; did: string } & ResolvedAuthor> =
    [];
  for (const candidate of candidates) {
    const author = authorMap.get(candidate.did);
    if (!author) continue; // unresolved author → skip (no orphan)
    const normalized = mapPostViewToNormalizedPost(
      candidate.view,
      candidate.did,
      mentionMap,
      pdsMap.get(candidate.did),
    );
    if (!normalized) continue;
    mapped.push({
      uri: candidate.uri,
      post: { ...normalized, authorOxyUserId: author.oxyUserId },
      did: candidate.did,
      ...author,
    });
  }
  if (mapped.length === 0) return [];

  const seen = await findPostsByFederatedObjects(mapped.map((entry) => entry.uri));
  // Posts Bridgy Fed delivered first (found by key) whose native copy is new.
  const keyed = mapped.filter((entry) => {
    const stored = seen.get(entry.uri);
    return stored !== undefined && stored.activityId !== entry.uri;
  });
  const merged = await findRecordedTransportCopies(keyed.map((entry) => entry.uri));

  const imported: ImportedView[] = [];
  for (const entry of mapped) {
    const stored = seen.get(entry.uri);
    if (stored && keyed.includes(entry) && !merged.has(entry.uri)) {
      await absorbNormalizedCopy(stored.id, entry.post, entry.oxyUserId, entry.did);
    }
    const created =
      !stored &&
      (await createPostFromNormalized(
        entry.post,
        entry.oxyUserId,
        entry.did,
        entry.instanceDomain,
      ));
    imported.push({ uri: entry.uri, post: entry.post, created });
  }
  return imported;
}

/** A repost on an author's feed: its own AT-URI, the reposted post's, and when. */
interface AuthorRepost {
  uri: string;
  subjectUri: string;
  createdAt?: Date;
}

/**
 * Store an author's reposts as boosts of the (already imported) originals,
 * through the network-neutral {@link createFederatedBoost} the ActivityPub
 * `Announce` import uses. Deduped on the repost's AT-URI (or its Bridgy Fed
 * copy's upstream key); a repost whose
 * original could not be imported is skipped.
 */
async function importReposts(
  reposts: readonly AuthorRepost[],
  boosterOxyUserId: string,
  did: string,
): Promise<void> {
  if (reposts.length === 0) return;
  const stored = await findPostsByFederatedObjects(
    reposts.flatMap((repost) => [repost.uri, repost.subjectUri]),
  );
  for (const repost of reposts) {
    const originalPostId = stored.get(repost.subjectUri)?.id;
    if (stored.has(repost.uri) || !originalPostId) continue;
    await createFederatedBoost({
      activityId: repost.uri,
      originalPostId,
      boosterOxyUserId,
      actorUri: did,
      createdAt: repost.createdAt,
    });
  }
}

/**
 * Fetch `app.bsky.feed.getAuthorFeed` for the resolved atproto `actor` and import
 * the page: the author's own posts (the pinned one included), the posts they
 * reply to and quote (so the links resolve), and their reposts — the reposted
 * original under ITS author, then a boost of it by this one, as an ActivityPub
 * `Announce` is stored. Page one also mirrors which post is pinned.
 *
 * The actor MUST already carry a resolved `oxyUserId` (no orphan posts).
 * Throws `XrpcError` when the AppView cannot be read.
 */
export async function importAuthorFeed(
  actor: NormalizedExternalActor,
  opts: { limit?: number; cursor?: string } = {},
): Promise<{ posts: NormalizedExternalPost[]; cursor?: string }> {
  const did = actor.externalId;
  const ownerOxyUserId = actor.oxyUserId;
  if (!ownerOxyUserId) {
    logger.warn('[atproto] skipped author feed import without a resolved Oxy user');
    return { posts: [] };
  }

  // A failed read THROWS (`XrpcError`) rather than answering an empty page:
  // the history backfill pages until there is no cursor, and an empty answer
  // would read as "reached the end". Every caller already catches.
  const feed = await xrpcGet<AtprotoAuthorFeed>(PUBLIC_APPVIEW, 'app.bsky.feed.getAuthorFeed', {
    actor: did,
    limit: opts.limit ?? 20,
    cursor: opts.cursor,
    // Page one leads with the pinned post, which may be older than the page.
    includePins: opts.cursor ? undefined : true,
  });

  const items = Array.isArray(feed?.feed) ? feed.feed : [];
  const own: AtprotoPostView[] = [];
  const context: Array<AtprotoPostView | undefined> = [];
  const reposts: AuthorRepost[] = [];
  let pinItemUri: string | undefined;
  for (const item of items) {
    const post = item?.post;
    if (typeof post?.uri !== 'string') continue;
    if (item.reason?.$type === REASON_REPOST) {
      if (item.reason.by?.did !== did || typeof item.reason.uri !== 'string') continue;
      context.push(post);
      reposts.push({
        uri: item.reason.uri,
        subjectUri: post.uri,
        createdAt: parseCreatedAt(item.reason.indexedAt),
      });
      continue;
    }
    if (item.reason && !isPinItem(item)) continue;
    // Only the author's own posts are theirs to import under this actor.
    if (post.author?.did !== did) continue;
    if (isPinItem(item)) pinItemUri = post.uri;
    own.push(post);
    context.push(item.reply?.root, item.reply?.parent);
  }

  // Stamp the actor's instance domain (e.g. `bsky.social`) on imported posts —
  // matching the AP convention (the post's instance domain = the actor's host), not
  // the bare full handle.
  const imported = await importPostViewBatch(own, {
    authors: new Map([[did, { oxyUserId: ownerOxyUserId, instanceDomain: actor.instanceDomain }]]),
    context,
  });
  await importReposts(reposts, ownerOxyUserId, did);

  // Page one is the only page that says what is pinned (including "nothing").
  if (!opts.cursor) {
    const pinnedUri = imported.some((entry) => entry.uri === pinItemUri) ? pinItemUri : undefined;
    const [pinned] = pinnedUri
      ? await getDb()
          .select({ id: posts.id })
          .from(posts)
          .where(and(postMatchesFederatedObjectSql(pinnedUri), eq(posts.oxyUserId, ownerOxyUserId)))
          .limit(1)
      : [];
    if (!pinnedUri || pinned)
      await setFederatedAuthorPinnedPost(ownerOxyUserId, pinned?.id ?? null);
  }

  return {
    posts: imported.filter((entry) => entry.created).map((entry) => entry.post),
    cursor: feed?.cursor,
  };
}

/** The `app.bsky.feed.getFeed` response — the same hydrated shape `getAuthorFeed` returns. */
interface AtprotoGetFeedResponse {
  feed?: AtprotoFeedItem[];
  cursor?: string;
}

/**
 * Fetch one page of a Bluesky FEED GENERATOR's output (`app.bsky.feed.getFeed`)
 * from the public AppView. Returns the hydrated `PostView`s in the generator's
 * ranking ORDER, the posts they reply to (`context`), and the paging cursor.
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
): Promise<{ posts: AtprotoPostView[]; context: AtprotoPostView[]; cursor?: string }> {
  let response: AtprotoGetFeedResponse;
  try {
    response = await xrpcGet<AtprotoGetFeedResponse>(PUBLIC_APPVIEW, 'app.bsky.feed.getFeed', {
      feed: feedUri,
      limit: opts.limit ?? 30,
      cursor: opts.cursor,
    });
  } catch (err) {
    logger.debug('[atproto] getFeed failed', err);
    return { posts: [], context: [] };
  }

  const items = Array.isArray(response?.feed) ? response.feed : [];
  const posts: AtprotoPostView[] = [];
  const context: AtprotoPostView[] = [];
  for (const item of items) {
    if (item?.post) posts.push(item.post);
    for (const view of [item?.reply?.root, item?.reply?.parent]) if (view) context.push(view);
  }
  return { posts, context, cursor: response?.cursor };
}

/**
 * Import a batch of hydrated `PostView`s (from a feed generator's {@link getFeed})
 * as native `Post` rows, and return the AT-URIs that map to a local post — in INPUT
 * ORDER — so the caller can load + hydrate them preserving the generator's ranking.
 * `context` is the posts they reply to ({@link getFeed}'s `context`), imported
 * first so the reply links resolve.
 *
 * The MULTI-AUTHOR sibling of {@link importAuthorFeed}, over the same
 * {@link importPostViewBatch}. A returned URI whose creation genuinely failed simply
 * won't have a local `Post` for the caller to load — it drops out of the page
 * rather than appearing blank.
 */
export async function importPostViews(
  postViews: ReadonlyArray<AtprotoPostView | undefined>,
  context: ReadonlyArray<AtprotoPostView | undefined> = [],
): Promise<string[]> {
  const imported = await importPostViewBatch(postViews, { context });
  return imported.map((entry) => entry.uri);
}

/** `app.bsky.feed.getPosts` hydrates at most this many AT-URIs per call. */
const GET_POSTS_MAX_URIS = 25;

/** Hydrate AT-URIs through `app.bsky.feed.getPosts`; a post that is gone is simply absent. */
async function getPostViews(uris: readonly string[]): Promise<AtprotoPostView[]> {
  const views: AtprotoPostView[] = [];
  for (let start = 0; start < uris.length; start += GET_POSTS_MAX_URIS) {
    const page = await xrpcGet<{ posts?: AtprotoPostView[] }>(
      PUBLIC_APPVIEW,
      'app.bsky.feed.getPosts',
      { uris: uris.slice(start, start + GET_POSTS_MAX_URIS) },
    );
    if (Array.isArray(page?.posts)) views.push(...page.posts);
  }
  return views;
}

/** The AT-URIs of `uris` that are not stored yet. */
async function unstoredUris(uris: readonly string[]): Promise<string[]> {
  if (uris.length === 0) return [];
  const stored = await getDb()
    .select({ activityId: posts.federationActivityId })
    .from(posts)
    .where(inArray(posts.federationActivityId, [...uris]));
  const known = new Set(stored.map((row) => row.activityId));
  return uris.filter((uri) => !known.has(uri));
}

/**
 * Post authors Mention already holds, from their stored actor rows, so a post
 * from an account we follow does not cost a profile read and an Oxy identity
 * resolution each time. The instance domain is the Oxy network of the stored
 * `network_acct` — what the profile upsert returns as `instanceDomain`.
 */
async function storedAuthors(dids: readonly string[]): Promise<Map<string, ResolvedAuthor>> {
  const actors = await findActorsByUris(dids);
  const authors = new Map<string, ResolvedAuthor>();
  for (const actor of actors) {
    if (actor.protocol !== 'atproto' || !actor.oxyUserId) continue;
    const network = actor.networkAcct?.split('@').pop();
    authors.set(actor.uri, { oxyUserId: actor.oxyUserId, instanceDomain: network || actor.domain });
  }
  return authors;
}

/**
 * Import posts known only by their AT-URIs — a stream of record events (the
 * Jetstream consumer) says WHICH posts exist, not what they look like. Each is
 * hydrated through the AppView (`app.bsky.feed.getPosts`), so it carries the same
 * moderation labels, CDN media and handle as an author-feed import, and then goes
 * through the one {@link importPostViewBatch} path; the posts they reply to are
 * hydrated and imported first, so the reply links resolve.
 *
 * Already-stored URIs cost one indexed query and no AppView call, which is what
 * makes an at-least-once stream cheap to replay. Throws `XrpcError` when the
 * AppView cannot be read, so the caller can retry instead of losing the posts.
 *
 * @returns how many posts were newly created.
 */
export async function importPostsByUri(uris: readonly string[]): Promise<number> {
  const missing = await unstoredUris([...new Set(uris)]);
  if (missing.length === 0) return 0;

  const views = await getPostViews(missing);
  if (views.length === 0) return 0;

  const asked = new Set(missing);
  const replyContextUris = new Set<string>();
  for (const view of views) {
    for (const uri of [view.record?.reply?.parent?.uri, view.record?.reply?.root?.uri]) {
      if (typeof uri === 'string' && !asked.has(uri)) replyContextUris.add(uri);
    }
  }
  const context = await getPostViews(await unstoredUris([...replyContextUris]));

  const authorDids = views.flatMap((view) =>
    typeof view.author?.did === 'string' ? [view.author.did] : [],
  );
  const imported = await importPostViewBatch(views, {
    authors: await storedAuthors([...new Set(authorDids)]),
    context,
  });
  return imported.filter((entry) => entry.created).length;
}
