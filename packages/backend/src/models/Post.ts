import mongoose, { Document, Schema } from "mongoose";
import {
  PostType,
  PostVisibility,
  StoredPostContent,
  PostStats,
  PostMetadata,
  PostClassification,
  PostAuthorshipEntry,
  PostAuthorRole,
  PostAuthorStatus,
  PostVariantSource,
} from '@mention/shared-types';
import { normalizePostHashtags } from '../utils/textProcessing';

export type ReplyPermission = 'anyone' | 'followers' | 'following' | 'mentioned' | 'nobody';

export interface PostFederationData {
  activityId?: string;   // AP activity URI
  actorUri?: string;     // Verified ActivityPub actor/signing URI that authored this activity
  inReplyTo?: string;    // AP URI of parent post
  url?: string;          // canonical web URL on remote instance
  sensitive?: boolean;   // content warning flag
  spoilerText?: string;  // content warning text
}

export interface IPost extends Document {
  oxyUserId?: string; // Denormalized owner cache — synced from authorship[]
  authorship?: PostAuthorshipEntry[];
  federation?: PostFederationData; // AP metadata (only for federated posts)
  type: PostType;
  /**
   * NORMALIZED content: `variants[]` is the ONLY home for the post's text, and
   * `variants[0]` is the primary. There is no stored `text` — what the API serves
   * as `content.text` is the primary (or the reader's language) RESOLVED at read
   * time by `resolveVariant`. Media and the article stay shared at the top; a
   * variant overrides them only when it genuinely differs.
   */
  content: StoredPostContent;
  visibility: PostVisibility;
  isEdited: boolean;
  editHistory?: string[];
  language?: string;
  tags?: string[];
  mentions?: string[]; // oxyUserIds
  // All detected hashtags in canonical form (lowercase, no `#`, deduped, order
  // preserved). Derived by the centralized `pre('validate')` normalizer; holds
  // every tag even when one was removed from a cleaned spammy block in content.
  hashtags?: string[];
  boostOf?: string; // original post id
  quoteOf?: string; // quoted post id
  parentPostId?: string; // for replies
  threadId?: string; // for thread posts
  replyPermission?: ReplyPermission[]; // Who can reply and quote this post
  reviewReplies?: boolean; // Whether to review and approve replies before they're visible
  quotesDisabled?: boolean; // Whether quote posts are disabled
  // Editorial/curation flag powering the `curated` feed source. Sparse: only set
  // on posts an admin curator explicitly promotes. The admin setter endpoint is
  // deferred (Phase 2 ships the field + the reader source; no post sets it yet).
  curated?: boolean;
  stats: PostStats;
  metadata: PostMetadata;
  location?: { // Post creation location metadata
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
    address?: string;
  };
  status?: 'draft' | 'published' | 'scheduled';
  scheduledFor?: Date;
  // Internal AI-inferred classification metadata. Separate from `hashtags`.
  // Defaults to a `pending` status on creation so the async classification batch
  // job picks it up; the AI provider/model is never stored here.
  postClassification?: PostClassification;
  createdAt: string;
  updatedAt: string;
}

/**
 * A media entry as persisted on a post: an object carrying at least `id` and a
 * media `type`, plus optional metadata resolved server-side. Shared by the post's
 * media set and by a language variant's media OVERRIDE, so both are validated
 * identically.
 */
function isValidMediaItem(item: unknown): boolean {
  if (typeof item !== 'object' || item === null) return false;
  const media = item as Record<string, unknown>;
  if (typeof media.id !== 'string') return false;
  if (media.type !== 'image' && media.type !== 'video' && media.type !== 'gif') return false;

  const numericFields = ['width', 'height', 'durationSec', 'sizeBytes', 'aspectRatio'] as const;
  for (const field of numericFields) {
    const value = media[field];
    if (value !== undefined && value !== null) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return false;
      }
    }
  }

  if (
    media.orientation !== undefined
    && media.orientation !== 'portrait'
    && media.orientation !== 'landscape'
    && media.orientation !== 'square'
  ) {
    return false;
  }

  return true;
}

const MEDIA_ITEM_MESSAGE = 'Media must be MediaItem objects with id and type fields';

/**
 * ONE localized rendition of the post — author-written or machine-translated.
 *
 * The language field is `tag`, deliberately NOT `language`: MongoDB reads a field
 * literally named `language` inside an indexed document as the text index's
 * stemmer override and REJECTS unsupported codes with error 17262 (the trap this
 * schema already dodges on the top-level `language` field via
 * `language_override: 'textSearchLanguage'`). `variants.text` is likewise kept OUT
 * of the text index — full-text search stays on the primary body.
 */
const PostContentVariantSchema = new Schema({
  // ABSENT when the post has no resolvable language — a body too short to detect
  // ("ok", "+1", a bare URL), or a federated Note that declares none. Deliberately
  // NOT required: minting a tag from a detector's best guess would stamp a wrong
  // language on the post and then federate that guess as a declaration
  // (`contentMap` / `language`). At most one variant is untagged, and it is the
  // primary.
  tag: { type: String },
  source: {
    type: String,
    enum: ['author', 'machine'] satisfies PostVariantSource[],
    required: true,
  },
  text: { type: String, default: '' },
  // Localized alt text for the SHARED media set, keyed by media id. Mutually
  // exclusive with `media` (a replaced set carries its own alt) — enforced at the
  // write boundary by `validateAuthorVariants`.
  alt: {
    type: Schema.Types.Mixed,
    default: undefined,
    validate: {
      validator: (value: unknown) => {
        if (value === undefined || value === null) return true;
        if (typeof value !== 'object' || Array.isArray(value)) return false;
        return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string');
      },
      message: 'Variant alt must map media ids to text descriptions',
    },
  },
  // Replaces the media set for this language entirely (a different infographic
  // per language). Absent → the variant shows the post's shared media.
  media: {
    type: [Schema.Types.Mixed],
    default: undefined,
    validate: {
      validator: (items: unknown[]) => items.every(isValidMediaItem),
      message: MEDIA_ITEM_MESSAGE,
    },
  },
  // Localized long-form. `articleId` is NOT duplicated — it is the same entity.
  article: {
    title: { type: String, trim: true, maxlength: 280 },
    body: { type: String },
    excerpt: { type: String, trim: true },
  },
  createdAt: { type: String },
}, { _id: false });

const AttachmentSchema = new Schema({
  type: {
    type: String,
    enum: ['media', 'poll', 'article', 'event', 'location', 'sources', 'podcast'],
    required: true
  },
  id: {
    type: String,
    required: function(this: { type?: string }) {
      return this.type === 'media';
    }
  },
  mediaType: {
    type: String,
    enum: ['image', 'video', 'gif'],
    required: function(this: { type?: string }) {
      return this.type === 'media';
    }
  }
}, { _id: false });

const PostContentSchema = new Schema({
  // Every localized rendition, author-written and machine-translated alike — the
  // ONLY home for the post's text. `variants[0]` is the PRIMARY (the hook keeps
  // the author's own renditions ahead of the machine translations, in order), and
  // it is what federates, what is signed onto the chain, and what a reader without
  // a matching language falls back to. There is deliberately no `text` mirror:
  // ActivityPub's `content`, the MTN record's `text` and the OG card are READ
  // paths that resolve the primary with one call, and a mirror would silently
  // drift on the one write path that skips Mongoose middleware (the federated
  // outbox backfill's `collection.insertMany`).
  variants: {
    type: [PostContentVariantSchema],
    default: undefined,
  },
  media: [{
    // MediaItem objects with id and type
    type: Schema.Types.Mixed,
    validate: {
      validator: isValidMediaItem,
      message: MEDIA_ITEM_MESSAGE,
    }
  }],
  attachments: {
    type: [AttachmentSchema],
    default: undefined
  },
  // Location shared by user as part of post content - visible to other users
  location: {
    type: { 
      type: String, 
      enum: ['Point'],
      required: function(this: { coordinates?: number[] }) {
        // Require type only if coordinates are provided
        return (this.coordinates?.length ?? 0) > 0;
      }
    },
    coordinates: {
      type: [Number], // [longitude, latitude] - longitude first for GeoJSON standard
      required: false,
      validate: {
        validator: function(coords: number[]) {
          // Allow empty arrays or undefined - no location data
          if (!coords || coords.length === 0) return true;
          // If coordinates provided, must be valid [lng, lat] format
          return coords.length === 2 && 
                 coords[0] >= -180 && coords[0] <= 180 && // longitude
                 coords[1] >= -90 && coords[1] <= 90;    // latitude
        },
        message: 'Coordinates must be [longitude, latitude] with valid ranges'
      }
    },
    // Optional address string for display purposes
    address: { type: String, required: false }
  },
  // Poll ID reference to separate Poll collection
  pollId: { type: String, required: false },
  // External sources cited in the post
  sources: [{
    url: {
      type: String,
      required: true,
      trim: true
    },
    title: {
      type: String,
      required: false,
      trim: true,
      maxlength: 200
    }
  }],
  article: {
    articleId: {
      type: String,
      required: false,
      index: true,
    },
    title: {
      type: String,
      required: false,
      trim: true,
      maxlength: 280
    },
    excerpt: {
      type: String,
      required: false,
      trim: true
    }
  },
  event: {
    eventId: {
      type: String,
      required: false
    },
    name: {
      type: String,
      required: false,
      trim: true,
      maxlength: 200
    },
    date: {
      type: String, // ISO date string
      required: false
    },
    location: {
      type: String,
      required: false,
      trim: true,
      maxlength: 200
    },
    description: {
      type: String,
      required: false,
      trim: true,
      maxlength: 500
    }
  },
  room: {
    roomId: {
      type: String,
      required: false
    },
    title: {
      type: String,
      required: false,
      trim: true,
      maxlength: 200
    },
    status: {
      type: String,
      enum: ['scheduled', 'live', 'ended'],
      required: false
    },
    topic: {
      type: String,
      required: false,
      trim: true,
      maxlength: 100
    },
    host: {
      type: String,
      required: false
    }
  },
  // A single Syra podcast SHOW attached to the post. The client only references
  // it by `syraPodcastId`; the canonical title/author/artwork and show URL are
  // resolved + denormalized server-side from the Syra catalog (@syra.fm/sdk) at
  // write time — never trusted from the client. Leaf paths are permissive
  // (the create path enforces presence and populates the denormalized fields),
  // mirroring the article/event/room nested objects above.
  podcast: {
    syraPodcastId: {
      type: String,
      required: false
    },
    title: {
      type: String,
      required: false,
      trim: true,
      maxlength: 300
    },
    author: {
      type: String,
      required: false,
      trim: true,
      maxlength: 200
    },
    artworkUrl: {
      type: String,
      required: false,
      trim: true
    },
    showUrl: {
      type: String,
      required: false,
      trim: true
    }
  }
});

const PostStatsSchema = new Schema({
  likesCount: { type: Number, default: 0 },
  downvotesCount: { type: Number, default: 0 },
  boostsCount: { type: Number, default: 0 },
  // Of `boostsCount`, the subset that originated as inbound ActivityPub Announces
  // (federated boosts) rather than native reposts. Maintained in lockstep with
  // `boostsCount` at the federated import/undo sites, so
  // `boostsCount - federatedBoostsCount` is the native boost count.
  federatedBoostsCount: { type: Number, default: 0 },
  commentsCount: { type: Number, default: 0 },
  viewsCount: { type: Number, default: 0 },
  sharesCount: { type: Number, default: 0 }
}, { _id: false }); // Don't create _id for subdocuments

// Ensure stats are always initialized
PostStatsSchema.pre('save', function() {
  if (!this.likesCount && this.likesCount !== 0) this.likesCount = 0;
  if (!this.downvotesCount && this.downvotesCount !== 0) this.downvotesCount = 0;
  if (!this.boostsCount && this.boostsCount !== 0) this.boostsCount = 0;
  if (!this.federatedBoostsCount && this.federatedBoostsCount !== 0) this.federatedBoostsCount = 0;
  if (!this.commentsCount && this.commentsCount !== 0) this.commentsCount = 0;
  if (!this.viewsCount && this.viewsCount !== 0) this.viewsCount = 0;
  if (!this.sharesCount && this.sharesCount !== 0) this.sharesCount = 0;
});

const PostMetadataSchema = new Schema({
  isSensitive: { type: Boolean, default: false },
  isPinned: { type: Boolean, default: false },
  isSaved: { type: Boolean, default: false },
  isLiked: { type: Boolean, default: false },
  isBoosted: { type: Boolean, default: false },
  isCommented: { type: Boolean, default: false },
  isFollowingAuthor: { type: Boolean, default: false },
  authorBlocked: { type: Boolean, default: false },
  authorMuted: { type: Boolean, default: false },
  hideEngagementCounts: { type: Boolean, default: false },
  // Track user interactions
  likedBy: [{ type: String }], // Array of user IDs who liked this post
  savedBy: [{ type: String }],  // Array of user IDs who saved this post
  // Poll reference (separate Poll model)
  pollId: { type: String }
});

const FederationSchema = new Schema({
  activityId: { type: String },
  actorUri: { type: String },
  inReplyTo: { type: String },
  url: { type: String },
  sensitive: { type: Boolean, default: false },
  spoilerText: { type: String },
}, { _id: false });

// Default status applied to every newly created post so the async classification
// batch job (PostClassificationService) picks it up. Kept as a named constant so
// the model, the service queue filter, and tests share one source of truth.
export const POST_CLASSIFICATION_PENDING = 'pending' as const;

// All score subfields share the same 0..1 normalized probability bound.
const CLASSIFICATION_SCORE_MIN = 0;
const CLASSIFICATION_SCORE_MAX = 1;

const classificationScoreField = () => ({
  type: Number,
  default: 0,
  min: CLASSIFICATION_SCORE_MIN,
  max: CLASSIFICATION_SCORE_MAX,
});

const PostClassificationScoresSchema = new Schema({
  toxicity: classificationScoreField(),
  constructiveness: classificationScoreField(),
  spam: classificationScoreField(),
  quality: classificationScoreField(),
  controversy: classificationScoreField(),
  negativity: classificationScoreField(),
}, { _id: false });

const PostClassificationSchema = new Schema({
  // Canonical topic slugs. Seeded by the Stage-A deterministic classifier and
  // refined/merged by the Stage-B AI batch — one shared list. Lightweight,
  // multikey-indexed form used for candidate fetching.
  topics: { type: [String], default: [] },

  // The same canonical topics resolved into the Topic registry: each carries the
  // slug `name`, plus `topicId` when the name resolved to a Topic document, and
  // the discovered `relevance`/`type` (AI path only). This is the relational read
  // form consumed by ranking/personalization/trending/topic-pages, alongside the
  // slug-only `topics` list above. `topicId` is stored as a string (the Topic
  // registry lives in Oxy; this is the resolved id, not a local ref).
  topicRefs: {
    type: [{
      name: { type: String, required: true },
      topicId: { type: String, required: false },
      relevance: { type: Number, required: false, min: 1, max: 10 },
      type: { type: String, enum: ['topic', 'entity'], required: false },
      _id: false,
    }],
    default: undefined,
  },

  // --- Stage-A deterministic baseline (synchronous at ingest) ---
  // Filled cheaply for EVERY post (native + federated) with no AI/network. All
  // optional: legacy/AI-only docs won't carry them until backfilled (P2).
  // ALL detected/declared ISO 639-1 languages (primary first, deduped). The ONE
  // canonical classification-language field (multikey/array) — feed
  // language-overlap queries `$in` against it. Absent on posts that predate
  // multi-language classification until the version-gated backfill populates
  // them (language-match then goes neutral). The top-level `post.language`
  // (single, AP protocol) carries the primary = `languages[0]`.
  languages: { type: [String], default: undefined },
  // Best-effort coarse region/country code; absent when unknown.
  region: { type: String },
  // Canonical hashtags (lowercase, no `#`, alias-mapped, deduped). Mirrors the
  // top-level `hashtags` normalization for one canonical read form.
  hashtagsNorm: { type: [String], default: undefined },
  // Sensitive/NSFW pass-through.
  sensitive: { type: Boolean },
  // Deterministic ruleset version that produced the baseline; enables re-baselining.
  version: { type: Number },

  // --- Stage-B AI enrichment (async batch) ---
  sentiment: {
    type: String,
    enum: ['positive', 'neutral', 'negative', 'mixed'],
    default: 'neutral',
  },
  intent: {
    type: String,
    enum: ['question', 'announcement', 'feedback', 'opinion', 'complaint', 'joke', 'news', 'personal_update', 'other'],
    default: 'other',
  },
  scores: { type: PostClassificationScoresSchema, default: () => ({}) },
  confidence: {
    type: Number,
    default: 0,
    min: CLASSIFICATION_SCORE_MIN,
    max: CLASSIFICATION_SCORE_MAX,
  },
  status: {
    type: String,
    enum: ['pending', 'baseline', 'classified', 'failed'],
    default: POST_CLASSIFICATION_PENDING,
    index: true,
  },
  // Number of classification attempts made so far. Used to cap retries before
  // flipping a persistently failing post to `failed`. Internal bookkeeping —
  // intentionally not part of the product-facing PostClassification type.
  attempts: { type: Number, default: 0 },
  classifiedAt: { type: Date },
}, { _id: false });

const PostAuthorshipSchema = new Schema({
  oxyUserId: { type: String, required: true },
  role: { type: String, enum: ['owner', 'collaborator'] satisfies PostAuthorRole[], required: true },
  status: {
    type: String,
    enum: ['accepted', 'pending', 'declined', 'stopped'] satisfies PostAuthorStatus[],
    required: true,
  },
  invitedAt: { type: Date },
  respondedAt: { type: Date },
}, { _id: false });

const PostSchema = new Schema<IPost>({
  oxyUserId: { type: String, required: false, index: true },
  authorship: { type: [PostAuthorshipSchema], default: undefined },
  federation: { type: FederationSchema, default: undefined },
  type: { type: String, enum: Object.values(PostType), default: PostType.TEXT, index: true },
  content: { type: PostContentSchema, required: true },
  visibility: { type: String, enum: Object.values(PostVisibility), default: PostVisibility.PUBLIC, index: true },
  isEdited: { type: Boolean, default: false },
  editHistory: [{ type: String }],
  language: { type: String, index: true },
  tags: [{ type: String }],
  mentions: [{ type: String, index: true }],
  hashtags: [{ type: String, index: true }],
  boostOf: { type: String, index: true },
  quoteOf: { type: String, index: true },
  parentPostId: { type: String, index: true },
  threadId: { type: String, index: true },
  replyPermission: {
    type: [String],
    enum: ['anyone', 'followers', 'following', 'mentioned', 'nobody'],
    default: ['anyone']
  },
  reviewReplies: { type: Boolean, default: false },
  quotesDisabled: { type: Boolean, default: false },
  // Editorial curation flag (sparse — only present on curated posts). Reader:
  // the `curated` feed source. No writer ships in Phase 2 (admin setter deferred).
  curated: { type: Boolean, index: { sparse: true } },
  status: {
    type: String,
    enum: ['draft', 'published', 'scheduled'],
    default: 'published',
    index: true
  },
  scheduledFor: { type: Date },
  stats: {
    type: PostStatsSchema,
    default: () => ({
      likesCount: 0,
      downvotesCount: 0,
      boostsCount: 0,
      federatedBoostsCount: 0,
      commentsCount: 0,
      viewsCount: 0,
      sharesCount: 0
    })
  },
  metadata: { type: PostMetadataSchema, default: () => ({}) },
  // Post creation location - metadata for analytics/discovery
  location: {
    type: { 
      type: String, 
      enum: ['Point'],
      required: function(this: { coordinates?: number[] }) {
        // Require type only if coordinates are provided in this location object
        return (this.coordinates?.length ?? 0) > 0;
      }
    },
    coordinates: {
      type: [Number], // [longitude, latitude] - longitude first for GeoJSON standard
      required: false,
      validate: {
        validator: function(coords: number[]) {
          // Allow empty arrays or undefined - no location data
          if (!coords || coords.length === 0) return true;
          // If coordinates provided, must be valid [lng, lat] format
          return coords.length === 2 && 
                 coords[0] >= -180 && coords[0] <= 180 && // longitude
                 coords[1] >= -90 && coords[1] <= 90;    // latitude
        },
        message: 'Coordinates must be [longitude, latitude] with valid ranges'
      }
    },
    // Optional address string for display purposes
    address: { type: String, required: false }
  },
  // Internal AI classification metadata. Defaults to a `pending` subdoc so EVERY
  // document-based creation path (composer/API via PostCreationService,
  // createThread, replies, single federated ingest, MCP) yields a post the
  // classification batch job will pick up — with zero per-path code. The raw
  // federated batch path (`Post.collection.insertMany`) bypasses Mongoose
  // defaults and sets this explicitly in the ActivityPub connector's outbox sync.
  postClassification: {
    type: PostClassificationSchema,
    default: () => ({ status: POST_CLASSIFICATION_PENDING }),
  },
}, {
  timestamps: {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt'
  },
  toObject: { virtuals: true },
  toJSON: { virtuals: true }
});

/**
 * Order the renditions so `variants[0]` is the PRIMARY: the author's own
 * renditions first (in the order the author gave them), the machine translations
 * after. Everything downstream — federation, the signed record, the reader
 * fallback — reads the primary by position, so the position has to be true no
 * matter which writer produced the array.
 */
function orderContentVariants(post: IPost): void {
  const variants = post.content?.variants;
  if (!variants || variants.length < 2) return;

  const authors = variants.filter((variant) => variant.source === 'author');
  const machines = variants.filter((variant) => variant.source === 'machine');
  if (machines.length === 0) return;

  post.content.variants = [...authors, ...machines];
}

// Centralized content normalization — the single enforcement point for every
// document-based post write (createPost, createThread, updatePost, replies,
// boosts, single federated ingest). Runs immediately before persistence so:
//   - `variants[0]` is the primary rendition (`orderContentVariants`), and
//   - EVERY author-written rendition is cleaned of spammy 4+ consecutive hashtag
//     blocks — whichever language a reader gets served — while `hashtags` holds
//     the full, canonical (lowercase, no `#`, deduped, order-preserved) set of
//     tags detected in the PRIMARY body.
//
// Caller-supplied tags are already present on `this.hashtags` (callers merge
// them via `mergeHashtags`), so they are passed back through as `userProvided`
// to preserve tags that have no `#` token in the text. The raw federated batch
// insert (`Post.collection.insertMany`) bypasses Mongoose middleware and calls
// `normalizePostHashtags` directly instead.
//
// Idempotent: re-running over already-cleaned text and canonical hashtags is a
// no-op, so repeated saves of the same document never strip more content.
PostSchema.pre('validate', function() {
  const touchesContent = this.isNew
    || this.isModified('content.variants')
    || this.isModified('hashtags');
  if (!touchesContent) {
    return;
  }

  orderContentVariants(this);

  const variants = this.content?.variants ?? [];
  const primary = variants[0];

  const { content, hashtags } = normalizePostHashtags(primary?.text, this.hashtags);
  if (primary) {
    primary.text = content;
  }
  this.hashtags = hashtags;

  // A machine translation is produced FROM the already-cleaned primary body, so
  // only the author's own renditions can carry a spammy block of their own.
  for (const variant of variants.slice(1)) {
    if (variant.source !== 'author') continue;
    variant.text = normalizePostHashtags(variant.text).content;
  }
});

// Pre-save hook to clean up empty location objects and sync authorship → oxyUserId
PostSchema.pre('save', function() {
  // Sync denormalized owner id from authorship[]
  if (this.authorship && this.authorship.length > 0) {
    const owner = this.authorship.find((entry) => entry.role === 'owner');
    if (owner?.oxyUserId) {
      this.oxyUserId = owner.oxyUserId;
    }
  }

  // Clean up content.location if it has empty coordinates
  if (this.content?.location && (!this.content.location.coordinates || this.content.location.coordinates.length !== 2)) {
    this.content.location = undefined;
  }
  
  // Clean up post.location if it has empty coordinates
  if (this.location && (!this.location.coordinates || this.location.coordinates.length !== 2)) {
    this.location = undefined;
  }
});

// Indexes for optimal query performance
PostSchema.index({ oxyUserId: 1, createdAt: -1 });
PostSchema.index({ 'authorship.oxyUserId': 1, 'authorship.status': 1, createdAt: -1 });
PostSchema.index({ type: 1, createdAt: -1 });
PostSchema.index({ visibility: 1, createdAt: -1 });
PostSchema.index({ hashtags: 1, createdAt: -1 });
PostSchema.index({ mentions: 1, createdAt: -1 });
PostSchema.index({ parentPostId: 1, createdAt: -1 });
PostSchema.index({ threadId: 1, createdAt: -1 });
PostSchema.index({ boostOf: 1, createdAt: -1 });
PostSchema.index({ quoteOf: 1, createdAt: -1 });
PostSchema.index({ 'content.media': 1, createdAt: -1 });
PostSchema.index({
  'content.media.type': 1,
  'content.media.orientation': 1,
  'content.media.durationSec': 1,
  createdAt: -1,
});
PostSchema.index({ createdAt: -1 }); // Default sort order
// Canonical topic-page lookup: getPostsByTopic matches the canonical
// postClassification.topicRefs.name (with the slug-only postClassification.topics
// compound index below as the fallback branch).
PostSchema.index({ 'postClassification.topicRefs.name': 1, createdAt: -1 });
PostSchema.index({ 'postClassification.status': 1, createdAt: 1 }); // Classification batch queue
// Stage-A baseline signal lookups (used by For You candidate filtering, P3).
// `languages` is the multikey (array) field backing the multi-language overlap
// `$in` queries; it is the only classification-language field.
PostSchema.index({ 'postClassification.languages': 1, createdAt: -1 });
PostSchema.index({ 'postClassification.region': 1, createdAt: -1 });

// Geospatial indexes for both location fields
PostSchema.index({ 'content.location': '2dsphere' }); // User's shared location
PostSchema.index({ 'location': '2dsphere' }); // Post creation location

// Compound indexes for common query patterns
PostSchema.index({ oxyUserId: 1, visibility: 1, status: 1, createdAt: -1 });
// Additional compound index for following feeds (visibility first, then user, then time)
PostSchema.index({ visibility: 1, status: 1, oxyUserId: 1, createdAt: -1 });
PostSchema.index({ type: 1, visibility: 1, status: 1, createdAt: -1 });
PostSchema.index({ hashtags: 1, visibility: 1, status: 1, createdAt: -1 });
// Geospatial compound indexes for location + time queries
PostSchema.index({ 'content.location': '2dsphere', createdAt: -1 });
PostSchema.index({ 'location': '2dsphere', createdAt: -1 });
// Critical compound index for cursor-based pagination (optimizes feed queries)
PostSchema.index({ visibility: 1, status: 1, createdAt: -1, _id: 1 });
// Cursor + author for author feeds
PostSchema.index({ oxyUserId: 1, visibility: 1, status: 1, createdAt: -1, _id: 1 });
// Index for saved posts queries
PostSchema.index({ _id: 1, createdAt: -1 });

// Enterprise-grade compound indexes for feed queries
// For You feed: optimizes queries with visibility + parentPostId + boostOf filters
// Note: MongoDB can use this index efficiently even with $or null checks
PostSchema.index(
  { visibility: 1, parentPostId: 1, boostOf: 1, createdAt: -1 },
  { name: 'for_you_feed_idx' }
);

// For You topic-candidate source (P3): fetch recent visible/published posts for a
// set of topic slugs. `postClassification.topics` is multikey (array) so it leads
// the index; visibility+status narrow, createdAt orders the candidate window.
PostSchema.index(
  { 'postClassification.topics': 1, visibility: 1, status: 1, createdAt: -1 },
  { name: 'for_you_topics_idx' }
);
// For You language-candidate source (P3): recent visible/published posts in a
// viewer's language(s). Leads with the MULTIKEY `postClassification.languages`
// array so the discovery source's `$in` against the viewer's preferred languages
// matches a post in ANY of its declared/detected languages (a bilingual post is
// surfaced for either language).
PostSchema.index(
  { 'postClassification.languages': 1, visibility: 1, status: 1, createdAt: -1 },
  { name: 'for_you_language_idx' }
);

// Saved posts with text search: optimizes saved posts queries with a regex over
// the post's bodies. Compound index helps when filtering by _id (from
// savedPostIds) and searching the (multikey) variant bodies.
PostSchema.index(
  { _id: 1, 'content.variants.text': 1 },
  { name: 'saved_posts_text_idx' }
);

// Explore feed: optimizes trending score aggregation queries
// This index helps with the base query before aggregation (visibility + time sorting)
// Stats fields are used in aggregation $addFields, so index on them helps less, but createdAt is critical
PostSchema.index(
  { visibility: 1, createdAt: -1 },
  { name: 'explore_feed_base_idx' }
);

// Following feed: optimizes queries for posts from followed users
// Compound index for oxyUserId + visibility + status + filters + time sorting
PostSchema.index(
  { oxyUserId: 1, visibility: 1, status: 1, parentPostId: 1, boostOf: 1, createdAt: -1 },
  { name: 'following_feed_idx' }
);

// Thread slicing: enables efficient grouping of self-threads and reply context
PostSchema.index(
  { threadId: 1, oxyUserId: 1, parentPostId: 1, createdAt: 1 },
  { name: 'thread_slicing_idx' }
);

// Full-text search index over post content — now over the MULTIKEY variant
// bodies, so a bilingual post is findable by ANY language the author wrote it in
// (the old index covered only the single stored body).
//
// The variant's language field is named `tag`, NOT `language`, and that is
// load-bearing here: MongoDB treats a field literally named `language` INSIDE an
// indexed document as the per-document stemmer override, and REJECTS the write
// with error 17262 ("language override unsupported") for any code outside its
// fixed stemmer set (ar/no/pl/…) — which is exactly the set of codes a content
// language holds. `language_override` additionally points at `textSearchLanguage`,
// a field NO document has, so MongoDB always falls back to
// `default_language: english` for stemming.
//
// Replaces the retired `content.text_text` index; the old one must be dropped in
// prod (the content migration does it) or both will be built.
PostSchema.index(
  { 'content.variants.text': 'text' },
  {
    default_language: 'english',
    language_override: 'textSearchLanguage',
    name: 'content.variants.text_text',
    weights: { 'content.variants.text': 1 },
  }
);

// Federation indexes (sparse — zero overhead for local posts)
PostSchema.index(
  { 'federation.activityId': 1 },
  { unique: true, sparse: true, name: 'federation_activity_id_idx' }
);
export const Post = mongoose.model<IPost>('Post', PostSchema);
export default Post;
