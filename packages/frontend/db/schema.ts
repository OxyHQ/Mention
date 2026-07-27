/**
 * Schema types and conversion functions.
 * 
 * Maps between SQLite row types and the HydratedPost / FeedItem types
 * used throughout the app.
 */

import type {
  HydratedBoostContext,
  HydratedPost,
} from '@mention/shared-types';
import { PostVisibility } from '@mention/shared-types/post';
import type { LinkMetadata } from '@/stores/linksStore';

// ── Table names ──────────────────────────────────────────────────

export const TABLE = {
  POSTS: 'posts',
  FEED_ITEMS: 'feed_items',
  FEED_META: 'feed_meta',
  LINK_PREVIEWS: 'link_previews',
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
  link_previews_json: string | null;
  permissions_json: string | null;
  boost_json: string | null;
  context_json: string | null;
  user_json: string;
  likes_count: number;
  downvotes_count: number;
  boosts_count: number;
  replies_count: number;
  saves_count: number;
  views_count: number;
  impressions_count: number;
  is_liked: number;
  is_downvoted: number;
  is_boosted: number;
  is_saved: number;
  is_owner: number;
  visibility: string;
  created_at: string;
  updated_at: string | null;
  fetched_at: number;
  raw_json: string | null;
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

type CachedBoostContext = Omit<HydratedBoostContext, 'originalPost'> & {
  originalPost: FeedItem | null;
};

/**
 * The canonical hydrated post plus cache-only rendering metadata. Related posts
 * keep the public `originalPost` / `quotedPost` / `boost.originalPost` names at
 * every layer; the cache never manufactures a second alias for the same object.
 */
export type FeedItem = Omit<HydratedPost, 'originalPost' | 'quotedPost' | 'boost'> & {
  originalPost?: FeedItem | null;
  quotedPost?: FeedItem | null;
  boost?: CachedBoostContext | null;
  date?: string;
  media?: string[];
  mediaIds?: string[];
  originalMediaIds?: string[];
  allMediaIds?: string[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function hasLegacyIdentityFields(value: Record<string, unknown>): boolean {
  return 'handle' in value || 'avatarUrl' in value || 'isVerified' in value;
}

/**
 * Stored rows must have originated from the canonical hydrated DTO. Schema v6
 * clears all older rows before reads, and this guard fails closed for corrupt
 * or manually injected cache entries rather than rebuilding legacy identity or
 * viewer state from partial data.
 */
function isCanonicalStoredPost(value: unknown): value is FeedItem {
  if (!isRecord(value)) return false;
  if (
    typeof value.id !== 'string' ||
    !isRecord(value.content) ||
    !isRecord(value.attachments) ||
    !isRecord(value.user) ||
    !Array.isArray(value.authors) ||
    !isRecord(value.engagement) ||
    !isRecord(value.viewerState) ||
    !isRecord(value.permissions) ||
    !isRecord(value.metadata)
  ) {
    return false;
  }

  if (
    'isLiked' in value ||
    'isDownvoted' in value ||
    'isBoosted' in value ||
    'isSaved' in value ||
    'original' in value ||
    'quoted' in value ||
    hasLegacyIdentityFields(value.user)
  ) {
    return false;
  }

  return value.authors.every(
    (author) => isRecord(author) && !hasLegacyIdentityFields(author),
  );
}

/**
 * Coerce a stored visibility string back into the {@link PostVisibility} enum,
 * defaulting to public for any unrecognized value.
 */
function toPostVisibility(value: string): PostVisibility {
  return value === PostVisibility.PRIVATE || value === PostVisibility.FOLLOWERS_ONLY
    ? value
    : PostVisibility.PUBLIC;
}

// ── Post conversions ─────────────────────────────────────────────

/**
 * Convert a HydratedPost (API response / FeedItem) to a PostRow for SQLite storage.
 */
export function postToRow(post: FeedItem): PostRow {
  return {
    id: post.id,
    user_id: post.user.id,
    type: 'text',
    parent_post_id: post.parentPostId ?? null,
    original_post_id: post.originalPost?.id ?? null,
    quoted_post_id: post.quotedPost?.id ?? null,
    content_json: safeJsonStringify(post.content) || '{"text":""}',
    attachments_json: safeJsonStringify(post.attachments),
    link_previews_json: safeJsonStringify(post.linkPreviews),
    permissions_json: safeJsonStringify(post.permissions),
    boost_json: safeJsonStringify(post.boost),
    context_json: safeJsonStringify(post.context),
    user_json: safeJsonStringify(post.user) || '{}',
    likes_count: post.engagement.likes ?? 0,
    downvotes_count: post.engagement.downvotes ?? 0,
    boosts_count: post.engagement.boosts ?? 0,
    replies_count: post.engagement.replies ?? 0,
    saves_count: post.engagement.saves ?? 0,
    views_count: post.engagement.views ?? 0,
    impressions_count: post.engagement.impressions ?? 0,
    is_liked: post.viewerState.isLiked ? 1 : 0,
    is_downvoted: post.viewerState.isDownvoted ? 1 : 0,
    is_boosted: post.viewerState.isBoosted ? 1 : 0,
    is_saved: post.viewerState.isSaved ? 1 : 0,
    is_owner: post.viewerState.isOwner ? 1 : 0,
    visibility: post.metadata.visibility,
    created_at: post.metadata.createdAt,
    updated_at: post.metadata.updatedAt,
    fetched_at: Date.now(),
    raw_json: safeJsonStringify(post),
  };
}

/**
 * Reconstruct a FeedItem from a PostRow.
 * This is the inverse of postToRow — used in render paths.
 */
export function rowToFeedItem(row: PostRow): FeedItem | null {
  const raw = safeJsonParse<unknown>(row.raw_json, null);
  if (!isCanonicalStoredPost(raw)) return null;

  const mediaIds = raw.attachments.media?.map((item) => item.id) ?? [];

  return {
    ...raw,
    id: row.id,
    engagement: {
      ...raw.engagement,
      likes: row.likes_count,
      downvotes: row.downvotes_count,
      boosts: row.boosts_count,
      replies: row.replies_count,
      saves: row.saves_count ?? null,
      views: row.views_count ?? null,
      impressions: row.impressions_count ?? null,
    },
    viewerState: {
      ...raw.viewerState,
      isOwner: Boolean(row.is_owner),
      isLiked: Boolean(row.is_liked),
      isDownvoted: Boolean(row.is_downvoted),
      isBoosted: Boolean(row.is_boosted),
      isSaved: Boolean(row.is_saved),
    },
    metadata: {
      ...raw.metadata,
      visibility: toPostVisibility(row.visibility),
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
    },
    parentPostId: row.parent_post_id || undefined,
    date: row.created_at,
    mediaIds,
    allMediaIds: mediaIds,
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
