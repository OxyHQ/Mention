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

/** The Stage-A → Stage-B lifecycle of `postClassification`. */
export type PostClassificationStatus = 'pending' | 'baseline' | 'classified' | 'failed';

/**
 * The status every ingest chokepoint stamps: Stage A ran, Stage B has not.
 *
 * Named rather than inlined because the AI batch's "not yet enriched" queue
 * SELECTS on it — a writer and a reader spelling the same literal independently
 * is how a post silently stops being picked up for enrichment.
 */
export const POST_CLASSIFICATION_PENDING: PostClassificationStatus = 'pending';

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
  status: PostClassificationStatus;
  attempts: number;
  /** Slug-only topic list (Stage A + B). */
  topics?: string[];
  /** The resolved form, when Stage B ran. */
  topicRefs?: PostRecordTopicRef[];
  /** EVERY detected/declared ISO 639-1 code, primary first. */
  languages?: string[];
  region?: string;
  hashtagsNorm?: string[];
  /** The term space trend detection measures over. Stage A only. */
  trendTerms?: string[];
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

  /**
   * The author's own lane for this post — a LENS. Purely local curation: it
   * never changes distribution, visibility, replies or federation.
   */
  laneId: string | null;
  /**
   * The channel this post was published TO — a DESTINATION, and the opposite of
   * a lane in every way that matters. A post carrying one belongs to the
   * channel and only to the channel: `authorFeedSql` excludes it from its
   * author's profile and from their followers' timelines unconditionally, and
   * neither federation nor the MTN chain ever sees it.
   */
  channelId: string | null;

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
 * CHECK constraints exist to make unrepresentable. {@link declaredReply} is not
 * that — see its own note.
 *
 * ## A COLUMN MISSING FROM THIS TYPE IS SILENTLY NEVER WRITTEN
 *
 * The typed literal catches a STRAY key — an unknown one is a `tsc` error rather
 * than a column that never gets written. It does not catch the opposite, and the
 * opposite is what actually happened: `lane_id` and `channel_id` were added to
 * the table by a merge, `PostCreationService` passed them, and neither existed
 * here — so `toPostInsert` never mapped them, every write stored NULL, and
 * nothing anywhere raised. There is no error and no partial symptom, because
 * "the writer set nothing" and "the writer set it and we dropped it" are the same
 * stored value. It would have surfaced weeks later as "lanes don't work".
 *
 * So adding a column is THREE edits, not one: the table, this type (plus
 * {@link PostRecord} for the read side), and `toPostInsert`. The round-trip cases
 * in `__tests__/laneHydration.test.ts` and `__tests__/channelHydration.test.ts`
 * are the gate — they assert a written value comes back, which is the only
 * assertion shape that can tell the two states apart.
 */
export interface PostRecordInput {
  /**
   * The post SAYS it is a reply in an encoding this table stores no link for.
   *
   * The MTN chain is the case that needs it: a signed
   * `app.mention.feed.post` record carries `reply.parent` as an `mtn://` URI, and
   * when that parent is not materialized here `parent_post_id` must stay NULL
   * (it is a real foreign key). Neither of the two link columns then holds
   * anything, so `derivesReplyIntent` alone would classify a reply as a root and
   * put it in For You / Following / Explore — the exact promotion `is_reply`
   * exists to prevent, arriving through a third door.
   *
   * This is NOT a second discriminator and NOT a writer-settable `isReply`:
   * `derivesReplyIntent` still owns the derivation, and this only ever ORs
   * `true` into it. It cannot produce the state the CHECKs forbid (a parent link
   * present while `is_reply` is false), and `is_reply` with no link is already
   * legal — it is precisely the orphan state the column was designed to hold.
   */
  declaredReply?: boolean;
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
  laneId?: string | null;
  channelId?: string | null;
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
 * Whether the post was written as a reply — in any encoding.
 *
 * The single place the reply intent is derived, so the writer and the CHECK
 * constraints cannot disagree about what "has a parent" means. Consumers read
 * the stored {@link PostRecord.isReply} instead of calling this.
 *
 * Three inputs, one answer: a stored parent link, a federated `inReplyTo` whose
 * parent was never imported, and {@link PostRecordInput.declaredReply} for a
 * chain record whose parent is not materialized here. All three are the same
 * fact; the column is still the only discriminator anything READS.
 */
export function derivesReplyIntent(input: {
  parentPostId?: string | null;
  federation?: { inReplyTo?: string };
  declaredReply?: boolean;
}): boolean {
  if (input.parentPostId != null && input.parentPostId !== '') return true;
  const inReplyTo = input.federation?.inReplyTo;
  if (typeof inReplyTo === 'string' && inReplyTo.length > 0) return true;
  return input.declaredReply === true;
}
