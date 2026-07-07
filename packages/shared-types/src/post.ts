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

/**
 * Oxy asset IMAGE variant names that the central asset service actually
 * generates (`packages/api/src/services/variantService.ts` `imageVariants`):
 * `thumb`(256) / `w320` / `w640` / `w1280` / `w2048`. `small`/`medium`/`large`/
 * `original` do NOT exist server-side and 404 on the CDN.
 *
 * These are the SINGLE source of truth for which variant each render context
 * requests, shared by the backend resolver (`utils/mediaResolver.ts`) and the
 * frontend (post media card / lightbox fallback) so the server-resolved and
 * client-fallback URL paths always agree.
 *
 * The in-feed post media card (~135–320px wide) and the profile media grid
 * (~190px cells) are both ≤320px, so the THUMB context maps to `w320` — large
 * enough for a retina render of those small surfaces, but far lighter than the
 * `w640`/`w1280`/`w2048` variants reserved for wider displays / the lightbox.
 */
export const MEDIA_VARIANT_THUMB = 'w320';
export const MEDIA_VARIANT_FULL = 'w2048';
export const MEDIA_VARIANT_AVATAR = 'thumb';

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
  /**
   * Accessibility description (alt text) for images, authored by the post creator
   * (Bluesky-style "ALT" feature). Optional passthrough — stored on the post and
   * returned in the DTO so the client can render the description and an "ALT"
   * badge. Not a URL; never resolved/rewritten.
   */
  alt?: string;
  /** Intrinsic pixel width when known (persisted at ingest from Oxy or AP). */
  width?: number;
  /** Intrinsic pixel height when known (persisted at ingest from Oxy or AP). */
  height?: number;
  /** Playback duration in seconds for video (and animated gif when detected). */
  durationSec?: number;
  /** Byte size when known (Oxy asset or federated cache). */
  sizeBytes?: number;
  /** Derived at ingest from width/height (Oxy canonical; AP pre-cache until Oxy wins). */
  orientation?: 'portrait' | 'landscape' | 'square';
  /** width / height, set at ingest together with orientation. */
  aspectRatio?: number;
  /** MIME type when known at ingest. */
  mime?: string;
  /** Original remote URL when federated media was cached to an Oxy file id. */
  remoteUrl?: string;
  /** True when this item's id was rewritten from a remote URL to an Oxy asset. */
  cachedFromFederation?: boolean;
  /**
   * Final, ready-to-render media URL resolved server-side (CDN or our media
   * proxy). Backends populate this so the frontend never computes URLs from `id`.
   */
  url?: string;
  /** Final, ready-to-render thumbnail URL (smaller variant) when available. */
  thumbUrl?: string;
  /**
   * Final, ready-to-render poster/still-frame URL for videos. For images this
   * mirrors `thumbUrl`.
   */
  posterUrl?: string;
  /**
   * Final, ready-to-render LARGE display URL for the fullscreen image viewer
   * (lightbox), when a large variant can be derived. Sized for the on-open
   * upgrade, not the raw original. Only present for native Oxy images;
   * federated/proxied media has no variant system, so this is omitted and the
   * viewer falls back to `url`.
   */
  fullUrl?: string;
  /**
   * Adaptive-bitrate HLS master playlist URL for native (non-federated) videos,
   * when the background transcode has produced one. `expo-video` (AVPlayer on
   * iOS, ExoPlayer on Android) plays an `.m3u8` URL natively and switches
   * quality automatically based on network conditions — no extra client code
   * needed beyond preferring this URL over `url`.
   *
   * NOT guaranteed to be ready: variant generation is fire-and-forget on
   * upload (see `OxyHQServices/packages/api/src/services/assetService.ts`
   * `queueVariantGeneration`), so a just-uploaded video's HLS ladder may not
   * exist yet — requesting it can 404/500. Consumers MUST fall back to `url`
   * (the raw original, always playable) on a playback error; never treat
   * `hlsUrl` as authoritative on its own. Omitted for federated/proxied video
   * (no Oxy variant system exists for those).
   */
  hlsUrl?: string;
}

export type PostAttachmentType = 'media' | 'poll' | 'article' | 'location' | 'sources' | 'event' | 'room' | 'podcast';

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

/**
 * A Syra podcast SHOW attached to a post (or pinned on a profile). The metadata
 * is denormalized server-side from the Syra catalog (via @syra.fm/sdk getPodcast)
 * at write time — never trusted from the client. The card opens the show in Syra
 * via `showUrl`.
 */
export interface PostPodcastContent {
  syraPodcastId: string;
  title: string;
  author?: string;
  artworkUrl?: string;
  showUrl: string;
}

/**
 * What a CLIENT sends when attaching a podcast: only the Syra show id. The
 * server resolves + denormalizes the rest (title/author/artwork/showUrl) via
 * @syra.fm/sdk, so the client never supplies — and is never trusted for — them.
 */
export interface PostPodcastInput {
  syraPodcastId: string;
}

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
  podcast?: PostPodcastContent; // Optional Syra podcast show attached to the post
  attachments?: PostAttachmentDescriptor[]; // Ordered attachments for rendering (media, poll, article, event, etc.)
}

/**
 * Content shape a CLIENT submits when creating a post. Identical to
 * {@link PostContent} except `podcast` carries only the id ({@link PostPodcastInput});
 * the server denormalizes the full show metadata before persisting.
 */
export type PostContentInput = Omit<PostContent, 'podcast'> & {
  podcast?: PostPodcastInput;
};

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
 * Status of a post's classification lifecycle. Classification is populated in two
 * stages that share this single object:
 * - `pending`: not yet processed (default on creation, awaiting the cheap
 *   deterministic baseline and/or the async AI batch).
 * - `baseline`: the cheap, deterministic Stage-A signals (language, region,
 *   normalized hashtags, rule-based topics, sensitive) have been filled at
 *   ingest. The async AI step has not enriched it yet.
 * - `classified`: the async AI Stage-B enrichment (sentiment, intent,
 *   quality/safety scores, refined topics) has completed; `classifiedAt` is set.
 * - `failed`: AI enrichment failed after the retry budget was exhausted.
 */
export type PostClassificationStatus = 'pending' | 'baseline' | 'classified' | 'failed';

/**
 * A single canonical topic on a post, resolved into the Topic registry. This is
 * the relational form of {@link PostClassification.topics}: it carries the same
 * topic `name` (slug) plus the registry `topicId` (when the name resolved to a
 * Topic document) and the discovered `relevance`/`type`. Personalization and
 * trending consume `topicId`; hidden-topic suppression and topic-page lookups
 * consume `name`.
 *
 * `topicId` is absent when the name could not be resolved to a Topic document
 * (e.g. the registry was unreachable at write time); readers that need an id
 * simply skip those entries and treat the topic as name-only.
 */
export interface ClassificationTopicRef {
  /** Lowercase topic slug — the same value stored in {@link PostClassification.topics}. */
  name: string;
  /** Topic-registry id when the name resolved to a Topic document; absent otherwise. */
  topicId?: string;
  /** Discovered relevance 1..10 (AI-extracted); absent for rule-based baseline topics. */
  relevance?: number;
  /** Whether this is an abstract topic or a named entity; absent for baseline topics. */
  type?: 'topic' | 'entity';
}

/**
 * Internal classification metadata for a post — the single content-intelligence
 * object used for ranking, search, recommendations, and moderation. It is
 * populated in two stages that coexist on this one object:
 *
 * - Stage A (deterministic, synchronous at ingest): cheap signals derived
 *   without any network/AI — {@link PostClassification.languages},
 *   {@link PostClassification.region}, {@link PostClassification.hashtagsNorm},
 *   {@link PostClassification.sensitive}, and rule-based {@link PostClassification.topics}.
 *   Runs on EVERY post (native and federated) on the same code path.
 *   {@link PostClassification.version} tracks the deterministic ruleset so posts
 *   can be re-baselined when rules change.
 * - Stage B (AI-inferred, async batch): {@link PostClassification.sentiment},
 *   {@link PostClassification.intent}, {@link PostClassification.scores},
 *   {@link PostClassification.confidence}, and refined topics that merge into the
 *   same {@link PostClassification.topics} list.
 *
 * It is intentionally SEPARATE from user-written {@link Post.hashtags}: hashtags
 * are explicit user tokens; `topics` here are inferred/normalized. The AI
 * provider/model is an infrastructure concern and is deliberately NOT stored on
 * the post.
 */
export interface PostClassification {
  /**
   * Topics/tags (lowercase, normalized slugs). Distinct from hashtags. Seeded by
   * Stage-A rule-based classification and refined/merged by Stage-B AI. This is
   * the lightweight, multikey-indexable slug form used for candidate fetching;
   * {@link PostClassification.topicRefs} carries the same topics enriched with
   * registry linkage for ranking/trending.
   */
  topics: string[];
  /**
   * The canonical topics resolved into the Topic registry — the relational form
   * of {@link PostClassification.topics} (same names, plus `topicId` and
   * discovered `relevance`/`type`). This is the single source of truth for the
   * algorithms (personalization topic-match by `topicId`, hidden-topic
   * suppression by `name`, trending aggregation, topic-page lookups). Absent
   * until the Stage-B AI batch resolves them; readers fall back to the slug-only
   * {@link PostClassification.topics} then treat the post as topic-less.
   */
  topicRefs?: ClassificationTopicRef[];
  /**
   * Stage-A. ALL detected/declared ISO 639-1 languages on the post (e.g. a
   * bilingual ES+EN post, or a Mastodon `contentMap` declaring several), primary
   * (dominant/declared) language first, deduped. This is the SINGLE canonical
   * classification-language field — there is no separate single-value field;
   * consumers read the array (the top-level {@link Post.language} carries the
   * single primary for the ActivityPub protocol). Absent when no language could
   * be determined, and absent on posts that predate multi-language classification
   * until the version-gated backfill populates them (language-match then goes
   * neutral for those posts).
   */
  languages?: string[];
  /**
   * Stage-A. Best-effort coarse region/country code (e.g. `'DE'`) or zone.
   * Deliberately weak — derived from a federated instance domain/TLD or locale —
   * and absent (`undefined`) when unknown. Never inferred from post text.
   */
  region?: string;
  /**
   * Stage-A. Canonical hashtags for this post: lowercase, `#`-stripped, trimmed,
   * deduplicated, alias-mapped. Mirrors the same normalization used for
   * {@link Post.hashtags} so ranking/discovery read one canonical form.
   */
  hashtagsNorm?: string[];
  /** Stage-A. Whether the content is marked sensitive/NSFW (pass-through). */
  sensitive?: boolean;
  /**
   * Stage-A. Version of the deterministic classifier ruleset that produced the
   * baseline signals. Bumped when the rules/taxonomy change so posts can be
   * re-baselined. Absent on posts that only carry legacy AI fields.
   */
  version?: number;
  /** Stage-B (AI). Absent until the post reaches `classified`. */
  sentiment?: PostSentiment;
  /** Stage-B (AI). Absent until the post reaches `classified`. */
  intent?: PostIntent;
  /** Stage-B (AI). Absent until the post reaches `classified`. */
  scores?: PostClassificationScores;
  /** Stage-B (AI). Overall confidence in the AI classification, 0..1. Absent until `classified`. */
  confidence?: number;
  status: PostClassificationStatus;
  /** When the post was successfully AI-classified (Stage B). Absent until `classified`. */
  classifiedAt?: Date;
}

export type PostAuthorRole = 'owner' | 'collaborator';
export type PostAuthorStatus = 'accepted' | 'pending' | 'declined' | 'stopped';

export interface PostAuthorshipEntry {
  oxyUserId: string;
  role: PostAuthorRole;
  status: PostAuthorStatus;
  invitedAt?: string;
  respondedAt?: string;
}

export const MAX_POST_COLLABORATORS = 5;

export interface Post {
  id: string;
  _id?: string;
  oxyUserId: string; // Links to Oxy user (denormalized owner cache)
  /** Canonical multi-author list. Always includes exactly one owner with status accepted. */
  authorship?: PostAuthorshipEntry[];
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
  // Collaborative post federation lifecycle flags
  /** Set when a post with pending collab invites defers its fediverse delivery. Cleared once federation runs. */
  collabFederationDeferred?: boolean;
  /** Set after the post has been successfully delivered to the fediverse. Prevents a second delivery on invite resolution. */
  federationDelivered?: boolean;
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
  content: PostContentInput;
  visibility?: PostVisibility;
  /** Up to {@link MAX_POST_COLLABORATORS} local users to invite as co-authors. */
  collaboratorIds?: string[];
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
  content: PostContentInput;
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
  /** Invite collaborators when editing a solo post within the 30-minute window. */
  collaboratorIds?: string[];
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
  /**
   * Canonical Oxy `name.displayName`. OPTIONAL: an actor may have no display
   * name (the API may stop synthesizing one). Renderers MUST fall back to the
   * (always-present) `handle` — never show a blank name or the handle twice.
   */
  displayName?: string;
  /**
   * Final, ready-to-render avatar URL resolved server-side — NOT a raw Oxy file
   * id or relative path.
   */
  avatarUrl?: string;
  badges?: string[];
  isVerified?: boolean;
  isFederated?: boolean;
  instance?: string;
  actorUri?: string;
  profileUrl?: string;
}

export interface HydratedAuthor extends PostActorSummary {
  role: PostAuthorRole;
  status: PostAuthorStatus;
}

export interface PostViewerState {
  isOwner: boolean;
  isCollaborator: boolean;
  collabInvitePending?: boolean;
  viewerRole?: PostAuthorRole;
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
  canStopSharing?: boolean;
  canViewInsights?: boolean;
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
  podcast?: PostPodcastContent;
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
  /**
   * Top-level ActivityPub primary language (`postClassification.languages[0]`).
   * Absent when no language could be determined.
   */
  language?: string;
  /**
   * ALL detected/declared ISO 639-1 languages (primary first), from the canonical
   * `postClassification.languages` array. Consumers doing language-match (e.g. the
   * feed language tuner) read this array with any-overlap semantics; the single
   * {@link PostMetadataState.language} is the protocol-facing primary.
   */
  languages?: string[];
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
  /** Primary author (owner) — backward-compatible single-author field. */
  user: PostActorSummary;
  /** Owner + accepted collaborators for multi-author header rendering. */
  authors: HydratedAuthor[];
  /** Full authorship state when the viewer is a participant. */
  authorship?: PostAuthorshipEntry[];
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
