/**
 * `PostRecord` — the ONE shape a post has once it leaves the database.
 *
 * ## Why this type exists at all
 *
 * Postgres stores a post NORMALIZED: nine tables, one row of scalars plus eight
 * child tables for what Mongo embedded as arrays. Nothing downstream wants that
 * shape — hydration, federation, the MTN chain and the feed engine all speak in
 * whole posts. So the storage layer assembles rows into this record and every
 * consumer reads the record; the join shape stops at `postRepository.ts` and no
 * second module ever has to know that `content.variants` is a table.
 *
 * ## Why it looks like the Mongo document and not like the tables
 *
 * Deliberately, and it is NOT Mongo baggage. `StoredPostContent`,
 * `PostAuthorshipEntry`, `PostMetadata` and `MediaItem` live in
 * `@mention/shared-types` — they are the CONTRACT the wire format is built from,
 * not a Mongoose artefact. Reshaping them here would change what
 * `PostHydrationService` emits, and the migration contract's hardest rule is that
 * the wire format does not change: Mention's frontend and the fediverse both
 * consume it.
 *
 * What DID get dropped is the actual Mongo baggage: `_id` (the id is `id`),
 * `__v`, `toObject()`, `markModified`, the `Document` base, and the
 * `postClassification` subdocument's ability to be partially present. Every
 * field below is either always there or explicitly optional, so a reader never
 * has to ask whether Mongoose happened to project it.
 *
 * ## The four fields that are load-bearing and easy to get wrong
 *
 * - **`isReply`** is STORED, never inferred from `parentPostId`. See
 *   `schema/posts.ts` — `ON DELETE SET NULL` clears the parent link, so a null
 *   parent stopped being evidence of a root the moment the schema landed.
 * - **`authorship`** is REQUIRED on every post and is the authority;
 *   `oxyUserId` is its denormalized projection. There is no read-time fallback
 *   from one to the other (see `AGENTS.md` § Collaborative Posts).
 * - **`content.variants[0]` is the primary rendition** and the only home of the
 *   body. `position` in the table IS that order.
 * - **`metadata.federationDelivered` / `metadata.collabFederationDeferred`**
 *   decide whether a post fans out to the fediverse. They are real columns, not
 *   loose keys on a `Mixed` bag.
 */

import type {
  GeoJSONPoint,
  PostAuthorshipEntry,
  PostClassificationScores,
  PostMetadata,
  PostPublicationStatus,
  PostStats,
  PostType,
  PostVisibility,
  ReplyPermission,
  StoredPostContent,
} from '@mention/shared-types';

/**
 * ActivityPub provenance, present only on federated posts.
 *
 * Structurally identical to the Mongoose `PostFederationData` on purpose: the
 * federation connectors read exactly these fields, and `federation == null` is
 * the predicate every "is this ours?" gate in the codebase already uses.
 */
export interface PostRecordFederation {
  /** The inbound AP activity URI. Globally unique where present. */
  activityId?: string;
  /** The verified AP actor/signing URI that authored the activity. */
  actorUri?: string;
  /** The AP URI of the parent, for a reply whose parent Mention never imported. */
  inReplyTo?: string;
  /** The canonical web URL on the remote instance. */
  url?: string;
  /** The remote instance's own sensitivity flag. */
  sensitive?: boolean;
  /** The remote content warning. Mention's own CW gate reads this. */
  spoilerText?: string;
}

/** One resolved entry of `postClassification.topicRefs`. */
export interface PostRecordTopicRef {
  name: string;
  topicId?: string;
  relevance?: number;
  type?: 'topic' | 'entity';
}

/**
 * The Stage-A/Stage-B classification subdocument.
 *
 * `status` and `attempts` are always present (the columns are `NOT NULL`), which
 * removes the "is the subdoc there at all?" branch every Mongo reader carried.
 */
export interface PostRecordClassification {
  status: 'pending' | 'baseline' | 'classified' | 'failed';
  attempts: number;
  /** Slug-only topic list (Stage A + B). */
  topics?: string[];
  /** The resolved form, when Stage B ran. */
  topicRefs?: PostRecordTopicRef[];
  /** EVERY detected/declared ISO 639-1 code, primary first. */
  languages?: string[];
  region?: string;
  hashtagsNorm?: string[];
  sensitive?: boolean;
  version?: number;
  sentiment: 'positive' | 'neutral' | 'negative' | 'mixed';
  intent:
    | 'question'
    | 'announcement'
    | 'feedback'
    | 'opinion'
    | 'complaint'
    | 'joke'
    | 'news'
    | 'personal_update'
    | 'other';
  scores: PostClassificationScores;
  confidence: number;
  classifiedAt?: Date;
}

/**
 * A post, assembled.
 *
 * Every consumer of a post row in this codebase takes one of these. It is the
 * batch-1 contract the feed, federation, MTN and engagement batches build on.
 */
export interface PostRecord {
  id: string;
  /** The denormalized owner — the `owner` entry of {@link authorship}. */
  oxyUserId: string | null;
  authorship: PostAuthorshipEntry[];

  type: PostType;
  visibility: PostVisibility;
  status: PostPublicationStatus;

  /**
   * Written as a reply. STORED, never derived — see the module docblock.
   *
   * True for a native reply AND for a federated reply whose parent Mention never
   * imported, which is the disjunction `utils/postReply.ts` had to spell out.
   */
  isReply: boolean;

  hasLinks: boolean;
  isEdited: boolean;
  /** The PRIMARY language (ISO 639-1) — the AP protocol field. */
  language?: string;
  curated?: boolean;
  tags?: string[];
  hashtags: string[];
  editHistory: string[];
  replyPermission: ReplyPermission[];
  reviewReplies: boolean;
  quotesDisabled: boolean;

  boostOf: string | null;
  quoteOf: string | null;
  parentPostId: string | null;
  threadId: string | null;
  scheduledFor: Date | null;

  /** The stored renditions plus the shared media/article/poll/location. */
  content: StoredPostContent;
  /** The resolved @mention allowlist (Oxy user ids). */
  mentions: string[];

  stats: PostStats;
  metadata: PostMetadata;
  /** Absent on native posts. `federation == null` is the "is this ours?" test. */
  federation?: PostRecordFederation;
  postClassification: PostRecordClassification;

  /** Capture-time location metadata (distinct from `content.location`). */
  location?: GeoJSONPoint;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * What a WRITER supplies. Everything the database defaults is optional here, so
 * a caller states only the facts it actually knows.
 *
 * `isReply` is deliberately NOT part of it: it is derived once, in
 * `postRepository.insertPost`, from the parent links the caller passed. Letting a
 * writer set it independently would reintroduce exactly the disagreement the
 * CHECK constraints exist to make unrepresentable.
 */
export interface PostRecordInput {
  /** Supply to preserve a pre-cutover id; otherwise a uuid v7 is generated. */
  id?: string;
  oxyUserId: string | null;
  authorship: PostAuthorshipEntry[];
  type: PostType;
  visibility: PostVisibility;
  status: PostPublicationStatus;
  hasLinks?: boolean;
  language?: string;
  tags?: string[];
  hashtags?: string[];
  replyPermission?: ReplyPermission[];
  reviewReplies?: boolean;
  quotesDisabled?: boolean;
  boostOf?: string | null;
  quoteOf?: string | null;
  parentPostId?: string | null;
  threadId?: string | null;
  scheduledFor?: Date | null;
  content: StoredPostContent;
  mentions?: string[];
  metadata?: PostMetadata;
  federation?: PostRecordFederation;
  postClassification?: Partial<PostRecordClassification>;
  location?: GeoJSONPoint;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Whether the post carries a parent link in EITHER encoding.
 *
 * The single place the reply intent is derived, so the writer and the CHECK
 * constraints cannot disagree about what "has a parent" means. Consumers read
 * the stored {@link PostRecord.isReply} instead of calling this.
 */
export function derivesReplyIntent(input: {
  parentPostId?: string | null;
  federation?: { inReplyTo?: string };
}): boolean {
  if (input.parentPostId != null && input.parentPostId !== '') return true;
  const inReplyTo = input.federation?.inReplyTo;
  return typeof inReplyTo === 'string' && inReplyTo.length > 0;
}
