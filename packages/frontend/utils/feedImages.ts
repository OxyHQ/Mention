/**
 * The images a feed row draws, as the URLs it draws them from: ONE answer for
 * the row and for the prefetch that warms a row's images before it scrolls in.
 * expo-image caches by URL, so a prefetch helps only when it asks for exactly
 * the URL the row will; both go through these functions.
 *
 * Size: a feed image is requested at the width it is drawn at times the screen's
 * pixel ratio, rounded up to a rung of Oxy's variant ladder
 * (`@oxy.so/utils/image`). The width depends only on the image and the feed, not
 * on what else the post carries: an image is sized for its widest form, alone in
 * its row (as wide as the body column, never taller than
 * {@link SINGLE_MEDIA_MAX_HEIGHT}). A cell beside other items is narrower and
 * gets the same URL, so the prefetch never needs to know the row's layout and a
 * post, its quote and its detail page share one cached image.
 *
 * Only URLs that serve every rung are resized: Oxy Cloud's content variants and
 * Clarity's document images. Anything else (a media-proxy URL, whose route
 * accepts only the resolver's own variants; a GIF original) is drawn as the
 * server sent it.
 *
 * On the web the browser picks among renditions itself (`srcset`), so the web
 * keeps the server's URL and the link card's rendition list.
 */
import { Dimensions, PixelRatio, Platform } from 'react-native';
import {
  CONTENT_IMAGE_VARIANTS,
  contentImageVariantForWidth,
  withImageVariant,
  type ContentImageVariantName,
  type ImageVariantSource,
} from '@oxy.so/utils/image';
import {
  MEDIA_VARIANT_AVATAR,
  MEDIA_VARIANT_FULL,
  MEDIA_VARIANT_THUMB,
} from '@mention/shared-types/post';
import type { HydratedPost } from '@mention/shared-types';
import { CLARITY_API_URL } from '@/config';
import { oxyServices } from '@/lib/oxyServices';
import { POST_ITEM_SPACING } from '@/styles/shared';
import { SINGLE_MEDIA_MAX_HEIGHT, MEDIA_CARD_HEIGHT, MEDIA_CARD_WIDTH } from '@/utils/composeUtils';
import { readMediaAspectRatio } from '@/utils/mediaTypes';
import { videoPosterUrl } from '@/utils/mediaUrls';
import { linkPreviewImageSources } from '@/utils/linkPreviewImage';
import { postLinkCards } from '@/utils/postLinkCards';

/** The fields of a media item the row reads to draw it. */
export interface FeedMediaRef {
  id: string;
  type?: 'image' | 'video' | 'gif';
  width?: number;
  height?: number;
  aspectRatio?: number;
  url?: string;
  thumbUrl?: string;
  posterUrl?: string;
  fullUrl?: string;
}

/** The narrowest a media cell is drawn. */
const MIN_MEDIA_WIDTH = 100;

/** A media item's shape until its record or its pixels say otherwise. */
export const FALLBACK_MEDIA_ASPECT_RATIO = MEDIA_CARD_WIDTH / MEDIA_CARD_HEIGHT;

const RUNG_INDEX = new Map<string, number>(CONTENT_IMAGE_VARIANTS.map((name, i) => [name, i]));

/** The largest rung a URL can be asked for, or `undefined` when it is drawn as sent. */
function largestRung(uri: string): ContentImageVariantName | undefined {
  if (uri.startsWith(`${CLARITY_API_URL}/images/documents/`)) return 'w1280';
  if (!uri.startsWith(`${oxyServices.cloudURL}/`)) return undefined;
  // Only a content rendition is resized: an avatar crop, a stream manifest or a
  // GIF's original keeps the URL it was given.
  const variant = /[?&]variant=([^&#]+)/.exec(uri)?.[1];
  return variant && RUNG_INDEX.has(variant) ? 'w2048' : undefined;
}

/**
 * `uri` at the rung that covers `widthDp` on this screen: the smallest at least
 * `widthDp` × the pixel ratio wide, capped at what the URL serves.
 */
export function sizedImageUri(uri: string, widthDp: number): string {
  if (Platform.OS === 'web' || !uri || !(widthDp > 0)) return uri;
  const largest = largestRung(uri);
  if (!largest) return uri;
  const wanted = contentImageVariantForWidth(Math.ceil(widthDp * PixelRatio.get()));
  const rung = (RUNG_INDEX.get(wanted) ?? 0) > (RUNG_INDEX.get(largest) ?? 0) ? largest : wanted;
  return withImageVariant(uri, rung);
}

/** The width of a feed row's body column: the window less the avatar gutter and the trailing padding. */
export function feedColumnWidth(): number {
  return Dimensions.get('window').width - POST_ITEM_SPACING.AVATAR_OFFSET - POST_ITEM_SPACING.HPAD;
}

/** The widest a media item of this shape is drawn in a feed row: alone, capped in height. */
export function feedMediaWidth(aspectRatio: number | undefined): number {
  const ratio = aspectRatio && aspectRatio > 0 ? aspectRatio : FALLBACK_MEDIA_ASPECT_RATIO;
  return Math.min(feedColumnWidth(), Math.max(SINGLE_MEDIA_MAX_HEIGHT * ratio, MIN_MEDIA_WIDTH));
}

/**
 * A media item's URL for one use: `thumb` (the feed card), `large` (the
 * lightbox) or `playable` (a video's source). Prefers the URLs the server
 * resolved; old cached DTOs without them fall back to the client resolver, at
 * the variant the server uses for the same use.
 */
export function feedMediaSrc(media: FeedMediaRef, use: 'thumb' | 'large' | 'playable'): string {
  const isGif = media.type === 'gif';
  let serverUrl: string | undefined;
  if (use === 'playable') serverUrl = media.url || media.thumbUrl;
  // A GIF animates only at its original; its variants are a still first frame.
  else if (isGif) serverUrl = media.url || media.fullUrl || media.thumbUrl;
  else if (use === 'large') serverUrl = media.fullUrl || media.url || media.thumbUrl;
  else serverUrl = media.thumbUrl || media.url;
  if (serverUrl) return serverUrl;
  const id = String(media.id || '');
  if (!id) return '';
  const variant =
    use === 'playable' || isGif
      ? undefined
      : use === 'large'
        ? MEDIA_VARIANT_FULL
        : MEDIA_VARIANT_THUMB;
  try {
    return oxyServices.assets.renderUrl(id, variant);
  } catch {
    return id;
  }
}

/** A feed image's card URL, at the size the row draws it. */
export function feedImageSrc(media: FeedMediaRef): string {
  return sizedImageUri(feedMediaSrc(media, 'thumb'), feedMediaWidth(readMediaAspectRatio(media)));
}

/** A feed video's poster URL, at the size the row draws it. */
export function feedVideoPoster(media: FeedMediaRef): string | undefined {
  const poster = media.posterUrl || videoPosterUrl(String(media.id || ''), oxyServices);
  return poster ? sizedImageUri(poster, feedMediaWidth(readMediaAspectRatio(media))) : undefined;
}

/**
 * A link card's cover. On a device, one URL at the column's width: expo-image on
 * Android cannot choose among width-only renditions (it ranks them by pixel
 * count, which a width alone does not have, and always takes the first, the
 * smallest). On the web, every rendition, for `srcset`.
 */
export function feedLinkCover(url: string | undefined): string | ImageVariantSource[] | undefined {
  if (!url) return undefined;
  if (Platform.OS === 'web') return linkPreviewImageSources(url);
  return sizedImageUri(url, feedColumnWidth());
}

/** An avatar's URL as Bloom's Avatar resolves it in a post header (`MEDIA_VARIANT_AVATAR`). */
function avatarUri(avatar: string | null | undefined): string | undefined {
  if (!avatar) return undefined;
  if (/^https?:\/\//i.test(avatar)) return avatar;
  try {
    return oxyServices.assets.renderUrl(avatar, MEDIA_VARIANT_AVATAR);
  } catch {
    return undefined;
  }
}

/** The fields of a post its row draws images from. */
export type FeedImagePost = Partial<
  Pick<
    HydratedPost,
    'user' | 'attachments' | 'content' | 'documents' | 'boost' | 'quotedPost' | 'originalPost'
  >
>;

/** Every image URL a feed row draws for `post` (its quoted post's included), for a prefetch. */
export function postFeedImages(post: FeedImagePost, into: string[] = []): string[] {
  const avatar = avatarUri(post.user?.avatar);
  if (avatar) into.push(avatar);
  const media = post.attachments?.media ?? post.content?.media;
  if (Array.isArray(media)) {
    for (const item of media) {
      if (item.type === 'video') {
        const poster = feedVideoPoster(item);
        if (poster) into.push(poster);
      } else if (item.type === 'gif') {
        // A federated GIF draws its proxied original; a native one plays as a video.
        if (/^https?:\/\//i.test(String(item.id))) into.push(feedMediaSrc(item, 'thumb'));
      } else into.push(feedImageSrc(item));
    }
  }
  for (const { document } of postLinkCards(post.content?.text, post.documents)) {
    const cover = feedLinkCover(document?.imageUrl);
    if (typeof cover === 'string') into.push(cover);
  }
  const nested = post.boost?.originalPost ?? post.quotedPost ?? post.originalPost;
  if (nested && nested !== post) postFeedImages(nested, into);
  return into;
}
