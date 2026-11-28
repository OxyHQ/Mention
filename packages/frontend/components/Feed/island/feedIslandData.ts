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
import { getNormalizedUserHandle } from '@oxy.so/core';
import { toOpenableUrl, trimUrlTrailingPunctuation } from '@mention/shared-types/textEntities';
import { scanLinkifyEntities } from '@/utils/linkifyPattern';
import { documentByline, postLinkCards, withoutCardLinks } from '@/utils/postLinkCards';
import type { FeedRow } from '../feedRows';

export interface FeedIslandAuthor {
  id: string;
  name: string;
  handle: string;
  avatar?: string;
  isVerified: boolean;
  /** A fediverse account (its mark after the handle). */
  isFederated: boolean;
  /** A local channel (its megaphone after the handle). */
  isChannel: boolean;
}

/**
 * A run of a post's body, as `LinkifiedText` draws it: plain (`kind` empty), an address opened
 * outside the app (`url`), or a route of the app (`route`: a mention, a tag, a cashtag).
 */
export interface FeedIslandRun {
  text: string;
  kind: '' | 'url' | 'route' | 'more';
  href: string;
}

/** A link's preview card (Bloom's `LinkPreviewCard`, from the post's Clarity document). */
export interface FeedIslandLink {
  url: string;
  title: string;
  site: string;
  description?: string;
  image?: string;
  byline?: string;
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
  /** The body as runs: its links, mentions and tags in the primary ink. */
  runs: FeedIslandRun[];
  link?: FeedIslandLink;
  isEdited: boolean;
  /** The row is a repost (the repost glyph after the time). */
  isBoost: boolean;
  /** The reposter's avatar when the row draws author and reposter as a cluster. */
  boosterAvatar?: string;
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
  href: string;
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
    isFederated: Boolean(user?.isFederated),
    isChannel: (user as { kind?: string } | undefined)?.kind === 'channel' && !user?.isFederated,
  };
}

/** The body's runs (`LinkifiedText`'s segmentation): its links, mentions, tags and cashtags. */
function runs(text: string, more: boolean): FeedIslandRun[] {
  const out: FeedIslandRun[] = [];
  const plain = (t: string) => {
    if (t) out.push({ text: t, kind: '', href: '' });
  };
  let last = 0;
  for (const entity of scanLinkifyEntities(text)) {
    plain(text.slice(last, entity.start));
    last = entity.end;
    if (entity.kind === 'url') {
      const { url, trailing } = trimUrlTrailingPunctuation(entity.value);
      out.push({ text: url, kind: 'url', href: toOpenableUrl(url) });
      plain(trailing);
    } else if (entity.kind === 'mentionDisplay') {
      const source = /^https?:\/\//i.test(entity.value);
      const handle = source ? undefined : getNormalizedUserHandle({ username: entity.value });
      const href = source
        ? `/mention?uri=${encodeURIComponent(entity.value)}`
        : handle
          ? `/@${handle}`
          : '';
      out.push({ text: String(entity.label ?? entity.raw), kind: href ? 'route' : '', href });
    } else if (entity.kind === 'federatedHandle') {
      out.push({ text: entity.raw, kind: 'route', href: `/@${entity.value}` });
    } else if (entity.kind === 'hashtag') {
      out.push({
        text: entity.raw,
        kind: 'route',
        href: `/hashtag/${encodeURIComponent(entity.value)}`,
      });
    } else if (entity.kind === 'cashtag') {
      out.push({
        text: entity.raw,
        kind: 'route',
        href: `/search/${encodeURIComponent(`$${entity.value}`)}`,
      });
    } else {
      plain(entity.raw);
    }
  }
  plain(text.slice(last));
  if (more) out.push({ text: ' Read more', kind: 'more', href: '' });
  return out;
}

/** The post's first link card, when the row draws one (no media: `PostAttachmentsRow` alone). */
function linkCard(post: HydratedPostSummary): FeedIslandLink | undefined {
  const card = postLinkCards(post.content?.text, (post as { documents?: never }).documents)[0];
  if (!card) return undefined;
  const doc = card.document;
  let host = '';
  try {
    host = new URL(card.url).hostname.replace(/^www\./, '');
  } catch {}
  const site = (doc?.publisher ?? host).toUpperCase();
  const title =
    doc?.title ||
    host +
      (() => {
        try {
          const u = new URL(card.url);
          return u.pathname.replace(/\/$/, '');
        } catch {
          return '';
        }
      })();
  return {
    url: card.url,
    title,
    site: site === title.toUpperCase() ? '' : site,
    description: doc?.description ?? undefined,
    image: doc?.imageUrl ?? undefined,
    byline: documentByline(doc),
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

/** The body without the links its card shows, cut as `PostContentText` cuts it, as runs. */
function bodyRuns(post: HydratedPostSummary, cards: boolean): FeedIslandRun[] {
  let text = post.content?.text ?? '';
  if (cards)
    text = withoutCardLinks(text, postLinkCards(text, (post as { documents?: never }).documents));
  const more = text.length > BODY_LIMIT;
  return runs(more ? `${text.slice(0, BODY_LIMIT).trimEnd()}…` : text, more);
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
    // PostItem's cluster: a pure boost of a one-author post draws the author and the booster
    // (not the thread head's reposter, nor a self-boost).
    const booster = !row.headReposter && boost?.originalPost ? boost.actor : undefined;
    const pair = booster && booster.id !== shown.user?.id ? booster : undefined;
    const shownMedia = media(shown);
    const link = shownMedia.length === 0 && !shown.quotedPost ? linkCard(shown) : undefined;
    const quoted = shown.quotedPost;
    const engagement = shown.engagement;
    const viewer = shown.viewerState;
    posts.push({
      id: shown.id,
      author: author(shown.user),
      text: body(shown),
      runs: bodyRuns(shown, link !== undefined),
      link,
      isEdited: Boolean((shown.metadata as { isEdited?: boolean } | undefined)?.isEdited),
      isBoost: Boolean(boost?.originalPost),
      boosterAvatar: pair ? (avatarUrl(pair.avatar) ?? '') : undefined,
      time: time(shown),
      media: shownMedia,
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
