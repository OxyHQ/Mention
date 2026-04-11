/**
 * Schema types and conversion functions.
 * 
 * Maps between SQLite row types and the HydratedPost / FeedItem types
 * used throughout the app.
 */

import type {
  HydratedPost,
  HydratedPostSummary,
  PostActorSummary,
  PostContent,
  PostAttachmentBundle,
  PostLinkPreview,
  PostPermissions,
  PostEngagementSummary,
  PostViewerState,
  PostMetadataState,
  HydratedRepostContext,
  PostFeedContext,
  FeedPostSlice,
} from '@mention/shared-types';
import type { UserEntity } from '@/stores/usersStore';
import type { LinkMetadata } from '@/stores/linksStore';

// ── Table names ──────────────────────────────────────────────────

export const TABLE = {
  POSTS: 'posts',
  ACTORS: 'actors',
  FEED_ITEMS: 'feed_items',
  FEED_META: 'feed_meta',
  LINK_PREVIEWS: 'link_previews',
  SCHEMA_VERSION: 'schema_version',
} as const;

// ── Row types (match SQLite columns) ─────────────────────────────

export interface PostRow {
  id: string;
  user_id: string;
  type: string;
  parent_post_id: string | null;
  original_post_id: string | null;
  quoted_post_id: string | null;
  content_json: string;
  attachments_json: string | null;
  link_preview_json: string | null;
  permissions_json: string | null;
  repost_json: string | null;
  context_json: string | null;
  user_json: string;
  likes_count: number;
  downvotes_count: number;
  reposts_count: number;
  replies_count: number;
  saves_count: number;
  views_count: number;
  impressions_count: number;
  is_liked: number;
  is_downvoted: number;
  is_reposted: number;
  is_saved: number;
  is_owner: number;
  visibility: string;
  created_at: string;
  updated_at: string | null;
  fetched_at: number;
  raw_json: string | null;
}

export interface ActorRow {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  handle: string | null;
  is_verified: number;
  bio: string | null;
  badges_json: string | null;
  is_full: number;
  extra_json: string | null;
  fetched_at: number;
}

export interface FeedItemRow {
  feed_key: string;
  post_id: string;
  position: number;
  slice_json: string | null;
  inserted_at: number;
}

export interface FeedMetaRow {
  feed_key: string;
  has_more: number;
  next_cursor: string | null;
  total_count: number;
  last_updated: number;
  filters_json: string | null;
}

export interface LinkPreviewRow {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  favicon: string | null;
  error: string | null;
  fetched_at: number;
  ttl_ms: number;
}

// ── FeedItem type (matches postsStore's FeedItem) ────────────────

export type FeedItem = HydratedPost & {
  date?: string;
  isLiked?: boolean;
  isDownvoted?: boolean;
  isReposted?: boolean;
  isSaved?: boolean;
  user: HydratedPost['user'] & {
    name: string;
    avatar: string;
  };
  media?: string[];
  mediaIds?: string[];
  originalMediaIds?: string[];
  allMediaIds?: string[];
  original?: FeedItem | null;
  quoted?: FeedItem | null;
  isLocalNew?: boolean;
};

// ── JSON helpers ─────────────────────────────────────────────────

function safeJsonParse<T>(json: string | null | undefined, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

function safeJsonStringify(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// ── Post conversions ─────────────────────────────────────────────

/**
 * Convert a HydratedPost (API response / FeedItem) to a PostRow for SQLite storage.
 */
export function postToRow(post: FeedItem | HydratedPost | any): PostRow {
  const id = post.id || post._id?.toString() || '';
  const user = post.user || {};
  const userId = user.id || user._id?.toString() || '';
  const engagement = post.engagement || {};
  const viewerState = post.viewerState || {};
  const metadata = post.metadata || {};
  const content = post.content || {};

  return {
    id,
    user_id: userId,
    type: post.type || 'text',
    parent_post_id: post.parentPostId || null,
    original_post_id: post.originalPost?.id || post.original?.id || null,
    quoted_post_id: post.quotedPost?.id || post.quoted?.id || null,
    content_json: JSON.stringify(content),
    attachments_json: safeJsonStringify(post.attachments),
    link_preview_json: safeJsonStringify(post.linkPreview),
    permissions_json: safeJsonStringify(post.permissions),
    repost_json: safeJsonStringify(post.repost),
    context_json: safeJsonStringify(post.context),
    user_json: JSON.stringify(user),
    likes_count: engagement.likes ?? 0,
    downvotes_count: engagement.downvotes ?? 0,
    reposts_count: engagement.reposts ?? 0,
    replies_count: engagement.replies ?? 0,
    saves_count: engagement.saves ?? 0,
    views_count: engagement.views ?? 0,
    impressions_count: engagement.impressions ?? 0,
    is_liked: viewerState.isLiked ? 1 : 0,
    is_downvoted: viewerState.isDownvoted ? 1 : 0,
    is_reposted: viewerState.isReposted ? 1 : 0,
    is_saved: viewerState.isSaved ? 1 : 0,
    is_owner: viewerState.isOwner ? 1 : 0,
    visibility: metadata.visibility || post.visibility || 'public',
    created_at: metadata.createdAt || post.createdAt || post.date || new Date().toISOString(),
    updated_at: metadata.updatedAt || post.updatedAt || null,
    fetched_at: Date.now(),
    raw_json: safeJsonStringify(post),
  };
}

/**
 * Reconstruct a FeedItem from a PostRow.
 * This is the inverse of postToRow — used in render paths.
 */
export function rowToFeedItem(row: PostRow): FeedItem {
  const content = safeJsonParse<PostContent>(row.content_json, { text: '' });
  const attachments = safeJsonParse<PostAttachmentBundle>(row.attachments_json, {} as PostAttachmentBundle);
  const linkPreview = safeJsonParse<PostLinkPreview | null>(row.link_preview_json, null);
  const permissions = safeJsonParse<PostPermissions>(row.permissions_json, {
    canReply: true,
    canDelete: false,
    canPin: false,
    canViewSources: false,
  });
  const repost = safeJsonParse<HydratedRepostContext | null>(row.repost_json, null);
  const context = safeJsonParse<PostFeedContext | null>(row.context_json, null);
  const user = safeJsonParse<any>(row.user_json, {});

  const displayName = user.displayName || user.name || user.handle || 'User';
  const avatarUrl = user.avatarUrl || user.avatar || '';

  const engagement: PostEngagementSummary = {
    likes: row.likes_count,
    downvotes: row.downvotes_count,
    reposts: row.reposts_count,
    replies: row.replies_count,
    saves: row.saves_count || null,
    views: row.views_count || null,
    impressions: row.impressions_count || null,
  };

  const viewerState: PostViewerState = {
    isOwner: Boolean(row.is_owner),
    isLiked: Boolean(row.is_liked),
    isDownvoted: Boolean(row.is_downvoted),
    isReposted: Boolean(row.is_reposted),
    isSaved: Boolean(row.is_saved),
  };

  const metadata: PostMetadataState = {
    visibility: row.visibility as any,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at,
  } as any;

  const mediaIds = attachments.media?.map((item: any) =>
    typeof item === 'string' ? item : item?.id
  ).filter(Boolean) ?? [];

  // Reconstruct original/quoted from raw_json if available
  let original: FeedItem | null = null;
  let quoted: FeedItem | null = null;
  if (row.raw_json) {
    const raw = safeJsonParse<any>(row.raw_json, null);
    if (raw?.original) original = raw.original;
    if (raw?.quoted) quoted = raw.quoted;
  }

  const feedItem: FeedItem = {
    id: row.id,
    content,
    attachments,
    linkPreview,
    user: {
      ...user,
      displayName,
      name: displayName,
      avatarUrl,
      avatar: avatarUrl,
      handle: user.handle || '',
      badges: user.badges,
      isVerified: user.isVerified,
      id: user.id || row.user_id,
    },
    engagement,
    viewerState,
    permissions,
    metadata,
    parentPostId: row.parent_post_id || undefined,
    repost,
    context,
    date: row.created_at,
    isLiked: Boolean(row.is_liked),
    isDownvoted: Boolean(row.is_downvoted),
    isReposted: Boolean(row.is_reposted),
    isSaved: Boolean(row.is_saved),
    mediaIds,
    allMediaIds: mediaIds,
    original,
    quoted,
  } as FeedItem;

  return feedItem;
}

// ── Actor conversions ────────────────────────────────────────────

/**
 * Convert a UserEntity or PostActorSummary to an ActorRow.
 */
export function actorToRow(actor: UserEntity | PostActorSummary | any, isFull: boolean = false): ActorRow {
  const id = String(actor.id || actor._id || '');
  const username = actor.username || actor.handle || null;
  const name = typeof actor.name === 'string'
    ? actor.name
    : actor.name?.full || actor.displayName || null;
  const avatarUrl = actor.avatarUrl || actor.avatar || null;

  // Extract known fields, put the rest in extra_json
  const { id: _id, _id: __id, username: _u, handle: _h, name: _n, displayName: _dn,
    avatar: _a, avatarUrl: _au, verified: _v, isVerified: _iv, bio: _b,
    badges: _badges, createdAt: _ca, ...extra } = actor;

  return {
    id,
    username,
    display_name: name,
    avatar_url: avatarUrl,
    handle: actor.handle || username || null,
    is_verified: (actor.verified || actor.isVerified) ? 1 : 0,
    bio: actor.bio || null,
    badges_json: safeJsonStringify(actor.badges),
    is_full: isFull ? 1 : 0,
    extra_json: Object.keys(extra).length > 0 ? safeJsonStringify(extra) : null,
    fetched_at: Date.now(),
  };
}

/**
 * Reconstruct a UserEntity from an ActorRow.
 */
export function rowToUserEntity(row: ActorRow): UserEntity {
  const extra = safeJsonParse<Record<string, any>>(row.extra_json, {});
  const badges = safeJsonParse<any[]>(row.badges_json, []);

  return {
    id: row.id,
    username: row.username || undefined,
    name: row.display_name || undefined,
    handle: row.handle || row.username || undefined,
    avatar: row.avatar_url || undefined,
    verified: Boolean(row.is_verified),
    bio: row.bio || undefined,
    badges,
    displayName: row.display_name || undefined,
    avatarUrl: row.avatar_url || undefined,
    isVerified: Boolean(row.is_verified),
    ...extra,
  };
}

// ── Link preview conversions ─────────────────────────────────────

export function linkMetadataToRow(metadata: LinkMetadata): LinkPreviewRow {
  return {
    url: metadata.url,
    title: metadata.title || null,
    description: metadata.description || null,
    image: metadata.image || null,
    site_name: metadata.siteName || null,
    favicon: metadata.favicon || null,
    error: metadata.error || null,
    fetched_at: Date.now(),
    ttl_ms: 30 * 60 * 1000, // 30 min default
  };
}

export function rowToLinkMetadata(row: LinkPreviewRow): LinkMetadata {
  return {
    url: row.url,
    title: row.title || undefined,
    description: row.description || undefined,
    image: row.image || undefined,
    siteName: row.site_name || undefined,
    favicon: row.favicon || undefined,
    error: row.error || undefined,
    fetchedAt: row.fetched_at,
  };
}

// ── Feed key helpers ─────────────────────────────────────────────

/**
 * Build a stable feed key for the feed_items / feed_meta tables.
 * Examples: "for_you", "following", "user:abc123:posts", "user:abc123:media"
 */
export function buildFeedKey(type: string, userId?: string): string {
  if (userId) {
    return `user:${userId}:${type}`;
  }
  return type;
}
