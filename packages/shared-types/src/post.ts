/**
 * Post-related types for Mention social network
 */

import { GeoJSONPoint } from './common';

export enum PostType {
  TEXT = 'text',
  IMAGE = 'image',
  VIDEO = 'video',
  POLL = 'poll',
  BOOST = 'boost',
  QUOTE = 'quote'
}

export enum PostVisibility {
  PUBLIC = 'public',
  FOLLOWERS_ONLY = 'followers_only',
  PRIVATE = 'private'
}

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
  /**
   * Final, ready-to-render media URL resolved server-side (CDN or our media
   * proxy). Optional for backward compatibility: v1 clients keep reading `id`.
   * v2+ backends populate this so the frontend never computes URLs.
   */
  url?: string;
  /** Final, ready-to-render thumbnail URL (smaller variant) when available. */
  thumbUrl?: string;
  /**
   * Final, ready-to-render poster/still-frame URL for videos. For images this
   * mirrors `thumbUrl`.
   */
  posterUrl?: string;
}

export type PostAttachmentType = 'media' | 'poll' | 'article' | 'location' | 'sources' | 'event' | 'room' | 'space';

export interface PostAttachmentDescriptor {
  type: PostAttachmentType;
  id?: string; // For media attachments and other id-referenced attachments
  mediaType?: 'image' | 'video' | 'gif';
}

export interface PostSourceLink {
  url: string;
  title?: string;
}

export interface PostArticleContent {
  articleId?: string;
  title?: string;
  body?: string;
  excerpt?: string;
}

export interface PostEventContent {
  eventId?: string;
  name: string;
  date: string; // ISO date string
  location?: string;
  description?: string;
}

export interface PostRoomContent {
  roomId: string;
  title: string;
  status?: 'scheduled' | 'live' | 'ended';
  topic?: string;
  host?: string;
}

/** @deprecated Use PostRoomContent instead */
export type PostSpaceContent = PostRoomContent;

export interface PostContent {
  text?: string;
  media?: MediaItem[]; // Media items for images and videos
  poll?: PollData; // Populated poll data for display
  pollId?: string; // Reference to poll document
  location?: GeoJSONPoint; // Location shared by user as part of post content
  sources?: PostSourceLink[]; // External sources cited within the post content
  article?: PostArticleContent; // Optional article content authored with the post
  event?: PostEventContent; // Optional event content
  room?: PostRoomContent; // Optional room content
  /** @deprecated Use room instead */
  space?: PostRoomContent;
  attachments?: PostAttachmentDescriptor[]; // Ordered attachments for rendering (media, poll, article, event, etc.)
}

export interface PollData {
  question: string;
  options: string[];
  endTime: string;
  votes: Record<string, number>; // option index -> vote count
  userVotes: Record<string, string>; // userId -> option index
}

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

/**
 * Sentiment inferred from a post's content. `mixed` covers posts that are
 * simultaneously positive and negative (e.g. constructive criticism).
 */
export type PostSentiment = 'positive' | 'neutral' | 'negative' | 'mixed';

/**
 * High-level communicative intent inferred from a post's content. `other` is the
 * catch-all when no specific intent applies.
 */
export type PostIntent =
  | 'question'
  | 'announcement'
  | 'feedback'
  | 'opinion'
  | 'complaint'
  | 'joke'
  | 'news'
  | 'personal_update'
  | 'other';

/**
 * Quality / safety / ranking signals inferred from a post's content. Every score
 * is a normalized probability in the inclusive range 0..1.
 *
 * These are deliberately orthogonal so ranking can combine them without
 * re-parsing content — e.g. negative-but-constructive posts (high
 * `constructiveness`, low `toxicity`) stay eligible while toxic/ragebait posts
 * (high `toxicity`, low `constructiveness`) become downrank candidates.
 */
export interface PostClassificationScores {
  /** Likelihood the content is toxic, harassing, or abusive. */
  toxicity: number;
  /** Degree to which the content is constructive / adds value. */
  constructiveness: number;
  /** Likelihood the content is spam or low-effort promotion. */
  spam: number;
  /** Overall content quality (clarity, substance, effort). */
  quality: number;
  /** Degree to which the content is divisive / controversial. */
  controversy: number;
  /** Strength of negative emotional tone, independent of toxicity. */
  negativity: number;
}

/**
 * Status of a post's AI classification lifecycle:
 * - `pending`: not yet classified (default on creation, awaiting the batch job).
 * - `classified`: successfully classified; `classifiedAt` is set.
 * - `failed`: classification failed after the retry budget was exhausted.
 */
export type PostClassificationStatus = 'pending' | 'classified' | 'failed';

/**
 * Internal, AI-inferred classification metadata for a post. This is intelligence
 * derived from the post's content (topics, sentiment, intent, quality/safety
 * signals) used for ranking, search, recommendations, and moderation.
 *
 * It is intentionally SEPARATE from user-written {@link Post.hashtags}: hashtags
 * are explicit user tokens; `topics` here are inferred. The AI provider/model is
 * an infrastructure concern and is deliberately NOT stored on the post.
 */
export interface PostClassification {
  /** Inferred topics/tags (lowercase, normalized). Distinct from hashtags. */
  topics: string[];
  sentiment: PostSentiment;
  intent: PostIntent;
  scores: PostClassificationScores;
  /** Overall confidence in this classification, 0..1. */
  confidence: number;
  status: PostClassificationStatus;
  /** When the post was successfully classified. Absent until `classified`. */
  classifiedAt?: Date;
}

export interface Post {
  id: string;
  _id?: string;
  oxyUserId: string; // Links to Oxy user
  type: PostType;
  content: PostContent;
  visibility: PostVisibility;
  isEdited: boolean;
  editHistory?: string[];
  language?: string;
  tags?: string[];
  mentions?: string[]; // oxyUserIds
  /**
   * Every hashtag detected for this post, in canonical form: lowercase, without
   * the leading `#`, deduplicated, first-seen order preserved. Populated by the
   * centralized backend normalizer immediately before persistence. Holds ALL
   * detected tags — including ones the normalizer removed from the visible
   * `content.text` when it cleaned a spammy block of 4+ consecutive hashtags.
   * This is the single source of truth for discovery, search, and trending.
   */
  hashtags?: string[];
  boostOf?: string; // original post id
  quoteOf?: string; // quoted post id
  parentPostId?: string; // for replies
  threadId?: string; // for thread posts
  replyPermission?: ReplyPermission[]; // Who can reply and quote this post
  reviewReplies?: boolean; // Whether to review and approve replies before they're visible
  quotesDisabled?: boolean; // Whether quote posts are disabled
  stats: PostStats;
  metadata: PostMetadata;
  location?: GeoJSONPoint; // Post creation location metadata
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: string;
  /**
   * Internal AI-inferred classification metadata (topics, sentiment, intent,
   * quality/safety scores). Separate from user {@link Post.hashtags}. Populated
   * asynchronously by the classification batch job; defaults to a `pending`
   * status on creation. The AI provider/model is never stored here.
   */
  postClassification?: PostClassification;
  createdAt: string;
  updatedAt: string;
}

export interface PostStats {
  likesCount: number;
  downvotesCount: number;
  boostsCount: number;
  commentsCount: number;
  viewsCount: number;
  sharesCount: number;
}

export interface PostMetadata {
  isSensitive?: boolean;
  isPinned?: boolean;
  isBookmarked?: boolean;
  isLiked?: boolean;
  isBoosted?: boolean;
  isCommented?: boolean;
  isFollowingAuthor?: boolean;
  authorBlocked?: boolean;
  authorMuted?: boolean;
  hideEngagementCounts?: boolean;
  // Track user interactions
  likedBy?: string[]; // Array of user IDs who liked this post
  savedBy?: string[]; // Array of user IDs who saved this post
}

/**
 * Subset of {@link PostMetadataState} that callers may set when creating a
 * post. Server-managed fields (timestamps, visibility, etc.) live elsewhere.
 */
export interface CreatePostMetadata {
  isSensitive?: boolean;
  hideEngagementCounts?: boolean;
  language?: string;
}

export interface CreatePostRequest {
  content: PostContent;
  visibility?: PostVisibility;
  parentPostId?: string;
  threadId?: string;
  /**
   * Source post for a quote. The frontend uses camelCase; the HTTP wire
   * format snake-cases this to `quoted_post_id` (see `feedService.createPost`).
   */
  quotedPostId?: string;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: string;
  metadata?: CreatePostMetadata;
}

export interface CreateThreadPostRequest {
  content: PostContent;
  visibility?: PostVisibility;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  metadata?: CreatePostMetadata;
}

export interface CreateThreadRequest {
  mode: 'thread' | 'beast'; // thread = linked posts, beast = separate posts
  posts: CreateThreadPostRequest[];
}

export interface UpdatePostRequest {
  content?: PostContent;
  visibility?: PostVisibility;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
}

export interface PostFeed {
  posts: Post[];
  hasMore: boolean;
  nextCursor?: string;
}

export interface PostFilters {
  authorId?: string;
  type?: PostType;
  visibility?: PostVisibility;
  hashtags?: string[];
  mentions?: string[];
  dateFrom?: string;
  dateTo?: string;
  isEdited?: boolean;
} 

/**
 * Normalized API response structures for hydrated posts
 */

export interface PostActorSummary {
  id: string;
  handle: string;
  displayName: string;
  /**
   * Final, ready-to-render avatar URL. v2+ backends populate this (and the
   * `avatar` alias) with a FINAL URL resolved server-side — NOT a raw Oxy file
   * id or relative path. v1 clients that performed their own URL resolution
   * remain compatible because the value is already an absolute URL.
   */
  avatarUrl?: string;
  /**
   * Alias of {@link PostActorSummary.avatarUrl}. v2+ backends populate this with
   * the same FINAL URL (not a raw id) so legacy readers of `avatar` keep working.
   */
  avatar?: string;
  badges?: string[];
  isVerified?: boolean;
  isFederated?: boolean;
  instance?: string;
  actorUri?: string;
  profileUrl?: string;
}

export interface PostViewerState {
  isOwner: boolean;
  isLiked: boolean;
  isDownvoted: boolean;
  isBoosted: boolean;
  isSaved: boolean;
}

export interface PostPermissions {
  canReply: boolean;
  canDelete: boolean;
  canPin: boolean;
  canViewSources: boolean;
  canEdit?: boolean;
}

export interface PostEngagementSummary {
  likes: number | null;
  downvotes: number | null;
  boosts: number | null;
  replies: number | null;
  saves?: number | null;
  views?: number | null;
  impressions?: number | null;
  recentReplierAvatars?: string[];
}

export interface PostAttachmentBundle {
  media?: MediaItem[];
  poll?: PollData;
  article?: PostArticleContent;
  sources?: PostSourceLink[];
  location?: GeoJSONPoint;
  event?: PostEventContent;
  room?: PostRoomContent;
  /** @deprecated Use room instead */
  space?: PostRoomContent;
}

export interface PostLinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
}

export interface PostFeedContext {
  reason?: string;
  position?: number;
  parentThreadId?: string;
  isThreadParent?: boolean;
}

export interface PostMetadataState {
  visibility: PostVisibility;
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  isPinned?: boolean;
  isSensitive?: boolean;
  hideEngagementCounts?: boolean;
  isThread?: boolean;
  language?: string;
  tags?: string[];
  mentions?: string[];
  hashtags?: string[];
  createdAt: string;
  updatedAt: string;
  status?: 'draft' | 'published' | 'scheduled';
}

export interface HydratedPostSummary {
  id: string;
  content: PostContent;
  attachments: PostAttachmentBundle;
  linkPreview?: PostLinkPreview | null;
  user: PostActorSummary;
  engagement: PostEngagementSummary;
  viewerState: PostViewerState;
  permissions: PostPermissions;
  metadata: PostMetadataState;
  parentPostId?: string;
}

export interface HydratedBoostContext {
  originalPost: HydratedPostSummary;
  actor: PostActorSummary;
  reason?: string;
}

export interface HydratedPost extends HydratedPostSummary {
  originalPost?: HydratedPostSummary | null;
  quotedPost?: HydratedPostSummary | null;
  boost?: HydratedBoostContext | null;
  context?: PostFeedContext;
}
