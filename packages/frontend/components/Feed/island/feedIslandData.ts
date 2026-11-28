/**
 * The feed's rows as the `FeedIsland` Compose island takes them (Bloom ADR 0003, M1): each post
 * row flattened to what the island's `FeedRow` draws (`Sources/FeedIsland/FeedData.bloom`
 * declares the same shapes, decoded by their derived `Codable`). The URLs are the ones the React
 * Native row asks for (`feedImageSrc`, `feedVideoPoster`, the avatar's `w96`), so both draw the
 * same pictures from the same cache keys; the time is Mention's own clock's.
 */
import type { HydratedPost, HydratedPostSummary, MediaItem, PostUser } from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types';
import { oxyServices } from '@/lib/oxyServices';
import { formatTimeAgo } from '@/utils/dateUtils';
import { feedImageSrc, feedVideoPoster, FALLBACK_MEDIA_ASPECT_RATIO } from '@/utils/feedImages';
import { readMediaAspectRatio } from '@/utils/mediaTypes';
import type { FeedRow } from '../feedRows';

export interface FeedIslandAuthor {
  id: string;
  name: string;
  handle: string;
  avatar?: string;
  isVerified: boolean;
}

export interface FeedIslandMedia {
  kind: 'image' | 'gif' | 'video';
  url: string;
  aspect: number;
}

export interface FeedIslandQuote {
  id: string;
  author: FeedIslandAuthor;
  text: string;
  time: string;
  media: FeedIslandMedia[];
}

export interface FeedIslandPost {
  id: string;
  author: FeedIslandAuthor;
  text: string;
  time: string;
  media: FeedIslandMedia[];
  quote?: FeedIslandQuote;
  repostedBy?: string;
  replies: number;
  reposts: number;
  likes: number;
  saves: number;
  isLiked: boolean;
  isReposted: boolean;
  isSaved: boolean;
  canReply: boolean;
}

/** What the island sends back (`FeedIntent`). */
export interface FeedIslandIntent {
  kind: string;
  postId: string;
  index: number;
}

/** Mention's body cut (`PostContentText`'s default): the first 280 characters. */
const BODY_LIMIT = 280;

function avatarUrl(avatar: string | null | undefined): string | undefined {
  if (!avatar) return undefined;
  if (/^https?:\/\//i.test(avatar)) return avatar;
  try {
    return oxyServices.assets.renderUrl(avatar, MEDIA_VARIANT_AVATAR);
  } catch {
    return undefined;
  }
}

function displayName(user: PostUser | undefined): string {
  const name = user?.name as
    | { displayName?: string; full?: string; first?: string }
    | string
    | undefined;
  const text =
    typeof name === 'string' ? name : (name?.displayName ?? name?.full ?? name?.first ?? undefined);
  return text?.trim() || user?.username || '';
}

function author(user: PostUser | undefined): FeedIslandAuthor {
  return {
    id: user?.id ?? '',
    name: displayName(user),
    handle: user?.username ?? '',
    avatar: avatarUrl(user?.avatar),
    isVerified: Boolean(user?.verified),
  };
}

function media(post: HydratedPostSummary): FeedIslandMedia[] {
  const items = (post.attachments?.media ?? post.content?.media ?? []) as MediaItem[];
  const out: FeedIslandMedia[] = [];
  for (const item of items) {
    const aspect = readMediaAspectRatio(item) || FALLBACK_MEDIA_ASPECT_RATIO;
    if (item.type === 'video') {
      const poster = feedVideoPoster(item);
      if (poster) out.push({ kind: 'video', url: poster, aspect });
    } else {
      const url = feedImageSrc(item);
      if (url) out.push({ kind: item.type === 'gif' ? 'gif' : 'image', url, aspect });
    }
  }
  return out;
}

function body(post: HydratedPostSummary): string {
  const text = post.content?.text ?? '';
  return text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT).trimEnd()}…` : text;
}

function time(post: HydratedPostSummary): string {
  const at = post.metadata?.createdAt;
  return at ? formatTimeAgo(at) : '';
}

/** The island's posts: the feed's post rows, a repost drawn as its original. */
export function feedIslandPosts(rows: readonly FeedRow[]): FeedIslandPost[] {
  const posts: FeedIslandPost[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'post' || !row.item?.id) continue;
    const item = row.item as HydratedPost;
    const boost = item.boost;
    const shown = (boost?.originalPost ?? item) as HydratedPost;
    if (seen.has(shown.id)) continue;
    seen.add(shown.id);
    const reposter = row.headReposter ?? (boost?.originalPost ? boost.actor : undefined);
    const quoted = shown.quotedPost;
    const engagement = shown.engagement;
    const viewer = shown.viewerState;
    posts.push({
      id: shown.id,
      author: author(shown.user),
      text: body(shown),
      time: time(shown),
      media: media(shown),
      quote: quoted
        ? {
            id: quoted.id,
            author: author(quoted.user),
            text: body(quoted),
            time: time(quoted),
            media: media(quoted),
          }
        : undefined,
      repostedBy: reposter ? displayName(reposter) : undefined,
      replies: engagement?.replies ?? 0,
      reposts: engagement?.boosts ?? 0,
      likes: engagement?.likes ?? 0,
      saves: engagement?.saves ?? 0,
      isLiked: Boolean(viewer?.isLiked),
      isReposted: Boolean(viewer?.isBoosted),
      isSaved: Boolean(viewer?.isSaved),
      canReply: shown.permissions?.canReply !== false,
    });
  }
  return posts;
}

/** The post a row drew, by id, for an intent to act on. */
export function feedIslandPostById(rows: readonly FeedRow[], id: string): HydratedPost | undefined {
  for (const row of rows) {
    if (row.kind !== 'post') continue;
    const item = row.item as HydratedPost;
    const shown = (item.boost?.originalPost ?? item) as HydratedPost;
    if (shown.id === id) return shown;
    if (shown.quotedPost?.id === id) return shown.quotedPost as HydratedPost;
  }
  return undefined;
}
