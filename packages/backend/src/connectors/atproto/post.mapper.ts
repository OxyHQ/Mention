import { PostVisibility } from '@mention/shared-types';
import { logger } from '../../utils/logger';
import { Post } from '../../models/Post';
import { getPostCreator } from '../../services/serviceRegistry';
import { materializeFederatedMedia, type ExtractedMediaAttachment } from '../shared/federatedMedia';
import type { MediaItem } from '@mention/shared-types';
import type { NormalizedExternalActor, NormalizedExternalMedia, NormalizedExternalPost } from '../types';
import { xrpcGet } from './xrpcClient';
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
interface AtprotoFacet {
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
interface AtprotoEmbedView {
  $type?: string;
  images?: AtprotoEmbedImage[];
  playlist?: string;
  thumbnail?: string;
  aspectRatio?: { width: number; height: number };
  media?: AtprotoEmbedView;
}
interface AtprotoPostView {
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
            out.push({
              id: url,
              type: 'image',
              remoteUrl: url,
              alt: typeof image.alt === 'string' ? image.alt : undefined,
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

  return {
    network: 'atproto',
    activityId: postView.uri,
    actorUri: did,
    url,
    inReplyTo,
    sensitive: hasAdultLabel(record),
    authorOxyUserId: undefined,
    text: typeof record.text === 'string' ? record.text : '',
    media: media.length > 0 ? media : undefined,
    hashtags: extractHashtags(record),
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
      content: {
        text: post.text,
        media: materialized.media.length > 0 ? materialized.media : undefined,
        attachments: materialized.attachments.length > 0 ? materialized.attachments : undefined,
      },
      visibility: PostVisibility.PUBLIC,
      hashtags: post.hashtags,
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
  const normalized: NormalizedExternalPost[] = [];
  for (const item of items) {
    if (item?.reason) continue; // skip reposts in C2
    const mapped = mapPostViewToNormalizedPost(item.post, did);
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
