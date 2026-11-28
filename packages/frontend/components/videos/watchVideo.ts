import type { OxyServices } from '@oxy.so/core';
import type { HydratedPost } from '@mention/shared-types';
import { proxyExternalUrl, videoPosterUrl } from '@/utils/mediaUrls';
import { isLandscapeVideo, isVideoMediaRef, readMediaDurationSec } from '@/utils/mediaTypes';

export type WatchPost = Pick<
  HydratedPost,
  'id' | 'content' | 'attachments' | 'user' | 'metadata' | 'engagement'
>;

export function watchVideo(
  post: WatchPost,
  assets: Pick<OxyServices, 'assets'> | null | undefined,
  index?: number,
) {
  const media = post.content.media ?? post.attachments.media ?? [];
  const mediaIndex =
    index ?? media.findIndex((item) => item.type === 'video' && isLandscapeVideo(item));
  const item = media[mediaIndex];
  if (!item || !isVideoMediaRef(item.id || item.url || '', { mediaType: item.type })) return null;

  const raw = item.id || '';
  const original =
    item.url || (raw.startsWith('http') ? proxyExternalUrl(raw) : assets?.assets.publicUrl(raw));
  const source = item.hlsUrl || original;
  if (!source) return null;

  return {
    post,
    mediaIndex,
    source,
    fallbackSource: original === source ? undefined : original,
    poster: item.posterUrl || item.thumbUrl || videoPosterUrl(raw || item.url || '', assets),
    duration: readMediaDurationSec(item),
  };
}
