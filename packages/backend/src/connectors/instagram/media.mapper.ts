import { normalizeMultilineText } from '@oxy.so/core';
import { qualifyBareHandles } from '@mention/shared-types/textEntities';
import type { NormalizedExternalMedia } from '@oxy.so/federation';
import { extractHashtags } from '../../utils/textProcessing';
import { clampFutureDate } from '../../utils/ingestTimestamp';
import { instagramShortcodeFromPermalink, instagramSourceKey } from '../shared/instagramSourceKey';
import type { NormalizedExternalPost } from '../pendingUpstreamWidening';
import { INSTAGRAM_GRAPH_NETWORK_ID } from '../pendingUpstreamWidening';
import { INSTAGRAM_IDENTITY_DOMAIN } from './constants';
import type { GraphChildMedia, GraphMedia } from './graphClient';

/**
 * Graph API media → network-neutral post. PURE: no I/O, no clock beyond the
 * future-timestamp clamp.
 *
 * - `text` is the caption, whitespace-normalized, with bare `@handles`
 *   qualified onto instagram.com — the same rule the kilogram ingest applies,
 *   because a bare `@reuben` in an Instagram caption means the Instagram
 *   account, not a Mention one.
 * - `activityId` is `instagram:<shortcode>` from the permalink — the dedupe key
 *   shared with the kilogram bridge (see `shared/instagramSourceKey.ts`). An item
 *   whose permalink carries no shortcode is not importable and maps to null.
 * - Media: an IMAGE is its `media_url`; a VIDEO is its `media_url` with the
 *   `thumbnail_url` kept as a FALLBACK image (a Reel with licensed music can come
 *   back with no `media_url` at all — then the thumbnail IS the media); a
 *   CAROUSEL_ALBUM is every child, in order.
 */

/** Clamp self-reported future timestamps like every other connector. */
const MAX_FUTURE_SKEW_MS = 60 * 60 * 1000;

/** One media slot: what to import, and what to import instead if that fails. */
export interface InstagramMediaPlan {
  primary: NormalizedExternalMedia;
  /** The poster image of a video, imported when the video itself cannot be. */
  fallback?: NormalizedExternalMedia;
}

export interface InstagramMappedPost {
  post: NormalizedExternalPost;
  /** The shortcode the permalink named (the source key without its prefix). */
  shortcode: string;
  /** Parallel to `post.media`: the same slots, with their fallbacks. */
  mediaPlans: InstagramMediaPlan[];
}

function httpsUrl(value: string | undefined): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function imageMedia(url: string): NormalizedExternalMedia {
  return { id: url, type: 'image', remoteUrl: url };
}

function videoMedia(url: string): NormalizedExternalMedia {
  return { id: url, type: 'video', remoteUrl: url };
}

/** The plan for one IMAGE/VIDEO node (a top-level item or a carousel child). */
function planForNode(node: GraphChildMedia | GraphMedia): InstagramMediaPlan | null {
  const mediaUrl = httpsUrl(node.media_url);
  const thumbnailUrl = httpsUrl(node.thumbnail_url);
  const type = typeof node.media_type === 'string' ? node.media_type.toUpperCase() : '';

  if (type === 'VIDEO') {
    if (mediaUrl) {
      return { primary: videoMedia(mediaUrl), ...(thumbnailUrl ? { fallback: imageMedia(thumbnailUrl) } : {}) };
    }
    // No playable file (licensed audio): the still is all Instagram gives out.
    return thumbnailUrl ? { primary: imageMedia(thumbnailUrl) } : null;
  }

  // IMAGE, and anything Meta adds later that still carries a URL.
  const url = mediaUrl ?? thumbnailUrl;
  return url ? { primary: imageMedia(url) } : null;
}

/** Every media slot of one Graph media item, in display order. */
export function planInstagramMedia(item: GraphMedia): InstagramMediaPlan[] {
  const type = typeof item.media_type === 'string' ? item.media_type.toUpperCase() : '';
  if (type === 'CAROUSEL_ALBUM') {
    const children = Array.isArray(item.children?.data) ? item.children.data : [];
    const plans = children
      .map((child) => planForNode(child))
      .filter((plan): plan is InstagramMediaPlan => plan !== null);
    if (plans.length > 0) return plans;
    // A carousel whose children were not returned still has its cover.
    const cover = planForNode({ media_type: 'IMAGE', media_url: item.media_url, thumbnail_url: item.thumbnail_url });
    return cover ? [cover] : [];
  }
  const plan = planForNode(item);
  return plan ? [plan] : [];
}

/**
 * Map one Graph media item authored by `actorUri`. Returns null when the item
 * has no Instagram shortcode (nothing to dedupe on) or nothing to show.
 */
export function mapGraphMediaToNormalizedPost(item: GraphMedia, actorUri: string): InstagramMappedPost | null {
  const shortcode = instagramShortcodeFromPermalink(item.permalink);
  const activityId = instagramSourceKey(shortcode);
  if (!shortcode || !activityId) return null;

  const rawCaption = typeof item.caption === 'string' ? item.caption : '';
  const text = normalizeMultilineText(qualifyBareHandles(rawCaption, INSTAGRAM_IDENTITY_DOMAIN));
  const mediaPlans = planInstagramMedia(item);
  if (text.trim().length === 0 && mediaPlans.length === 0) return null;

  const hashtags = extractHashtags(text);
  const post: NormalizedExternalPost = {
    network: INSTAGRAM_GRAPH_NETWORK_ID,
    activityId,
    actorUri,
    url: item.permalink,
    sensitive: false,
    text,
    media: mediaPlans.length > 0 ? mediaPlans.map((plan) => plan.primary) : undefined,
    hashtags: hashtags.length > 0 ? hashtags : undefined,
    createdAt: clampFutureDate(item.timestamp, MAX_FUTURE_SKEW_MS),
  };
  return { post, shortcode, mediaPlans };
}
