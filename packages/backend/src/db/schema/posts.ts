/**
 * `posts` — the central table. Ported from `models/Post.ts`.
 *
 * Mongo held one enormous document with five nested subdocuments
 * (`content`, `stats`, `metadata`, `federation`, `postClassification`) and four
 * embedded arrays. Here the SCALAR subdocuments become prefixed columns on this
 * table and every ARRAY becomes a child table in `postContent.ts` — a jsonb blob
 * would be unqueryable by exactly the predicates the feed engine runs against it
 * every request.
 *
 * ## No `users` table exists, by design
 *
 * Oxy owns identity. Every `oxy_user_id` in this schema is a FOREIGN SERVICE's
 * primary key reached over HTTP, so it can carry no foreign key — see
 * `ID_COLUMNS_WITHOUT_FOREIGN_KEY` in `deferredForeignKeys.ts`, where every one
 * of them is enumerated with that reason. This is the single biggest structural
 * difference from the sibling oxy-api port, which does have a `users` table.
 *
 * ## `stats.*` is kept, and that is a decision
 *
 * The migration contract forbids "denormalized counters inherited only because
 * Mongo could not JOIN". These are not that: `stats_likes_count` and friends are
 * read INSIDE the ranking expression of every feed aggregation
 * (`engagementScoreExpr`), so they are ranking inputs on the hot path, not a
 * cache of a COUNT. `PostEngagementCommandService` already maintains them
 * transactionally with the `likes`/`bookmarks` rows and
 * `EngagementProjectionReconciliationService` re-derives them, so the
 * relationship rows stay the authority and these stay the projection.
 *
 * ## ON DELETE, and the one open question
 *
 * `deletePost` (`controllers/posts.controller.ts:1687`) deletes the post and
 * then, best-effort, its article, poll, likes, bookmarks and notifications. It
 * does NOT touch replies, boosts or quotes — Mongo simply leaves those pointing
 * at an id that no longer resolves. Postgres has to choose, so each self-
 * reference below states its choice and why. `parent_post_id` is the one that
 * genuinely changes behaviour and is escalated rather than settled here.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  createdAt,
  generatedId,
  geography,
  inList,
  timestamptz,
  updatedAt,
} from './columns';

/**
 * `PostType` (`@mention/shared-types`). Declared as a local tuple so the column
 * type and the CHECK derive from ONE list; the enum in shared-types stays the
 * product-level source and this is asserted equal to it by test.
 */
export const POST_TYPES = ['text', 'image', 'video', 'poll', 'boost', 'quote'] as const;

/** `PostVisibility` (`@mention/shared-types`). */
export const POST_VISIBILITIES = ['public', 'followers_only', 'private'] as const;

/**
 * `PostPublicationStatus` — and the reason it is FOUR values, not the three the
 * Mongoose enum declares.
 *
 * `models/Post.ts` declares `enum: ['draft', 'published', 'scheduled']`, but
 * `ModerationEnforcementService.ts:122` writes `{ $set: { status: 'restricted' } }`
 * through `Post.updateOne`, which does not run validators. So the live
 * collection contains a fourth value the Mongoose schema forbids, and
 * `@mention/shared-types` `PostPublicationStatus` documents it as real. A CHECK
 * built from the Mongoose enum verbatim would start REJECTING rows Mongo has
 * been storing happily — the exact failure the migration contract warns about.
 *
 * A production `db.posts.distinct('status')` is still required before the
 * backfill: this list is derived from the code, and only the data can confirm
 * nothing else is in there.
 */
export const POST_STATUSES = ['draft', 'published', 'scheduled', 'restricted'] as const;

/** `ReplyPermission` (`models/Post.ts`). Stored as a set, so it is a `text[]`. */
export const REPLY_PERMISSIONS = [
  'anyone',
  'followers',
  'following',
  'mentioned',
  'nobody',
] as const;

/** `PostClassification.status` (Stage A → Stage B lifecycle). */
export const POST_CLASSIFICATION_STATUSES = [
  'pending',
  'baseline',
  'classified',
  'failed',
] as const;

/** `PostClassification.sentiment` (Stage B, AI). */
export const POST_SENTIMENTS = ['positive', 'neutral', 'negative', 'mixed'] as const;

/** `PostClassification.intent` (Stage B, AI). */
export const POST_INTENTS = [
  'question',
  'announcement',
  'feedback',
  'opinion',
  'complaint',
  'joke',
  'news',
  'personal_update',
  'other',
] as const;

/** `content.room.status`. */
export const POST_ROOM_STATUSES = ['scheduled', 'live', 'ended'] as const;

/** All classification score subfields share this 0..1 normalized bound. */
const SCORE_MIN = 0;
const SCORE_MAX = 1;

/** A 0..1 probability column with its bound expressed as a CHECK, not a comment. */
const scoreColumn = () => doublePrecision().notNull().default(0);

export const posts = pgTable(
  'posts',
  {
    id: generatedId(),

    /**
     * Denormalized owner, synced FROM the `owner` row of `post_authorships` by
     * the Mongoose `pre('save')` hook. Nullable because the Mongoose field is
     * `required: false` and the raw federated `insertMany` path can omit it.
     * No foreign key: this is an Oxy account id (see the module docblock).
     */
    oxyUserId: text(),

    type: text({ enum: POST_TYPES }).notNull().default('text'),
    visibility: text({ enum: POST_VISIBILITIES }).notNull().default('public'),
    status: text({ enum: POST_STATUSES }).notNull().default('published'),

    /** Write-time projection backing the indexable `has:links` search filter. */
    hasLinks: boolean().notNull().default(false),
    isEdited: boolean().notNull().default(false),

    /**
     * The PRIMARY language (ISO 639-1), i.e. `post_content_variants[0].tag`.
     * This is the ActivityPub protocol field; the full detected set lives in
     * `classification_languages`.
     */
    language: text(),

    /**
     * Editorial curation flag. Mongo indexed this SPARSE — only curated posts
     * carry it — so it stays nullable with a partial index rather than becoming
     * `NOT NULL DEFAULT false`, which would index every row in the table.
     */
    curated: boolean(),

    /** Free-form author tags (distinct from `hashtags`). Scalar set → `text[]`. */
    tags: text().array(),
    /**
     * Canonical hashtags: lowercase, `#`-stripped, deduped, first-seen order
     * preserved. Multikey in Mongo; a `text[]` with a GIN index answers the same
     * `$in` predicate natively.
     */
    hashtags: text().array(),
    /** Prior body revisions, oldest first. Opaque strings. */
    editHistory: text().array(),
    /**
     * Who may reply/quote. Mongo stored an enum ARRAY with `default: ['anyone']`;
     * the CHECK below constrains the ELEMENTS, which a scalar enum column could
     * not express.
     */
    replyPermission: text().array().notNull().default(sql`array['anyone']::text[]`),

    reviewReplies: boolean().notNull().default(false),
    quotesDisabled: boolean().notNull().default(false),

    /**
     * The boosted original. CASCADE: a `type:'boost'` row carries an
     * intentionally EMPTY body and exists only to point here, so with the
     * original gone it can never render anything. Mongo leaves these behind as
     * permanently blank cards; deleting them is the fix, and it is a BEHAVIOUR
     * CHANGE worth knowing about.
     */
    boostOf: text().references((): AnyPgColumn => posts.id, { onDelete: 'cascade' }),

    /**
     * The quoted post. SET NULL: a quote has a body of its own and must survive
     * its subject. NULL is exactly "the quoted post is gone", which the client
     * already renders as an unavailable card.
     */
    quoteOf: text().references((): AnyPgColumn => posts.id, { onDelete: 'set null' }),

    /**
     * The post this one replies to.
     *
     * `ON DELETE SET NULL`, and that is now SAFE because it is no longer the
     * thing root-feed membership is read from — see {@link isReply} directly
     * below, which is the discriminator this column's escalation asked for.
     *
     * The escalation, for the record: `SET NULL` PROMOTES an orphaned reply into
     * a root post wherever "is this a root?" is answered by
     * `parent_post_id IS NULL`, and `CASCADE` instead deletes reply subtrees that
     * survive today. `SET NULL` is kept because it loses no rows and is
     * repairable while CASCADE destroys user content irreversibly; the promotion
     * is closed by storing the answer instead of inferring it.
     */
    parentPostId: text().references((): AnyPgColumn => posts.id, { onDelete: 'set null' }),

    /**
     * Whether this post was WRITTEN as a reply. The root-vs-reply
     * discriminator — stored, never inferred.
     *
     * Set once by the writer from the post's own intent and never updated, so
     * `ON DELETE SET NULL` clearing `parent_post_id` cannot change it: an
     * orphaned reply stays a reply and stays out of For You / Following /
     * Explore, which is the behaviour Mongo had and the condition the schema's
     * `SET NULL` choice was accepted under.
     *
     * It also SUBSUMES the second encoding of the same fact. `utils/postReply.ts`
     * already had to ask this question as a disjunction — `parentPostId` for a
     * native reply, `federation.inReplyTo` for a federated reply whose parent
     * Mention never imported — because either alone misclassifies posts in both
     * directions. One column answers for both, so the query layer stops
     * re-deriving the concept per call site.
     *
     * The CHECKs below make the storage direction unrepresentable rather than
     * conventional: a row that HAS a parent (in either encoding) and claims not
     * to be a reply fails the insert. The converse — `is_reply` with no parent
     * link — is legal and is exactly the two orphan states.
     */
    isReply: boolean().notNull().default(false),

    /**
     * The root of a self-thread. SET NULL for the same reason as `quote_of`: the
     * continuations are real posts with real bodies and must outlive the root.
     */
    threadId: text().references((): AnyPgColumn => posts.id, { onDelete: 'set null' }),

    scheduledFor: timestamptz(),

    // ── `stats` subdocument (see the module docblock for why it is kept) ──
    statsLikesCount: integer().notNull().default(0),
    statsDownvotesCount: integer().notNull().default(0),
    statsBoostsCount: integer().notNull().default(0),
    /**
     * Of `statsBoostsCount`, the subset that arrived as inbound ActivityPub
     * Announces. `boosts - federatedBoosts` is the native count, and the
     * discovery ranking expression weights the two differently.
     */
    statsFederatedBoostsCount: integer().notNull().default(0),
    statsCommentsCount: integer().notNull().default(0),
    statsViewsCount: integer().notNull().default(0),
    statsSharesCount: integer().notNull().default(0),
    statsSavesCount: integer().notNull().default(0),

    // ── `metadata` subdocument ──
    metadataIsSensitive: boolean().notNull().default(false),
    metadataIsPinned: boolean().notNull().default(false),
    metadataIsBoosted: boolean().notNull().default(false),
    metadataIsCommented: boolean().notNull().default(false),
    metadataIsFollowingAuthor: boolean().notNull().default(false),
    metadataAuthorBlocked: boolean().notNull().default(false),
    metadataAuthorMuted: boolean().notNull().default(false),
    metadataHideEngagementCounts: boolean().notNull().default(false),

    /**
     * The collaborative-post federation lifecycle, and a REAL gap in the first
     * schema pass rather than a new feature.
     *
     * `PostMetadata` declares both, `PostCollaborationService` writes both, and
     * `maybeFederateOnResolve` READS both to decide whether a post fans out to
     * the fediverse — so dropping them silently breaks the two guarantees that
     * path exists for: an invitee must never be leaked to the fediverse before
     * consenting (`collab_federation_deferred`), and a solo post that already
     * federated at creation must not federate a second time when a later invite
     * resolves (`federation_delivered`).
     *
     * `NOT NULL DEFAULT false` is the faithful port: Mongo stored them as ABSENT
     * or `true`, and every reader tests truthiness.
     */
    metadataCollabFederationDeferred: boolean().notNull().default(false),
    metadataFederationDelivered: boolean().notNull().default(false),

    // ── `federation` subdocument (federated posts only) ──
    /** The inbound AP activity URI. Globally unique where present. */
    federationActivityId: text(),
    /** The verified AP actor/signing URI that authored the activity. */
    federationActorUri: text(),
    /** The AP URI of the parent, for a reply whose parent Mention never imported. */
    federationInReplyTo: text(),
    /** The canonical web URL on the remote instance. */
    federationUrl: text(),
    federationSensitive: boolean(),
    /** The remote content warning. Mention's own CW gate reads this. */
    federationSpoilerText: text(),

    // ── `content` scalar leaves (the arrays live in `postContent.ts`) ──
    /**
     * The attached poll. No foreign key in this direction: `polls.post_id` is the
     * owning side and carries the constraint, and Mongo's `content.pollId` /
     * `metadata.pollId` were two mirrors of it that could disagree. One column,
     * one direction — the mirror is dropped.
     */
    contentPollId: text(),
    /** The long-form body. `articles.post_id` is the owning side, as with polls. */
    contentArticleId: text(),
    contentArticleTitle: text(),
    contentArticleExcerpt: text(),

    contentEventId: text(),
    contentEventName: text(),
    /** ISO date STRING in Mongo, kept as an instant here. */
    contentEventDate: timestamptz(),
    contentEventLocation: text(),
    contentEventDescription: text(),

    /** A Syra live room. Cross-service id (Syra owns rooms) — no foreign key. */
    contentRoomId: text(),
    contentRoomTitle: text(),
    contentRoomStatus: text({ enum: POST_ROOM_STATUSES }),
    contentRoomTopic: text(),
    contentRoomHost: text(),

    /** A Syra podcast show. Cross-service id — no foreign key. */
    contentPodcastSyraId: text(),
    contentPodcastTitle: text(),
    contentPodcastAuthor: text(),
    contentPodcastArtworkUrl: text(),
    contentPodcastShowUrl: text(),

    // ── Locations ──
    //
    // Mongo stored `{ type: 'Point', coordinates: [lng, lat] }` twice: once as
    // `content.location` (shared BY the author, visible) and once as `location`
    // (capture metadata). Both are ported as NAMED coordinate columns plus a
    // GENERATED geography point, so the `(longitude, latitude)` ordering is
    // stated in exactly one place and a lat/lon swap becomes unrepresentable —
    // a write to the generated column fails with SQLSTATE 428C9 rather than
    // silently plotting the post in the wrong hemisphere.
    contentLocationLatitude: doublePrecision(),
    contentLocationLongitude: doublePrecision(),
    contentLocationAddress: text(),
    contentGeo: geography().generatedAlwaysAs(
      sql`ST_MakePoint(content_location_longitude, content_location_latitude)::geography`
    ),

    locationLatitude: doublePrecision(),
    locationLongitude: doublePrecision(),
    locationAddress: text(),
    geo: geography().generatedAlwaysAs(
      sql`ST_MakePoint(location_longitude, location_latitude)::geography`
    ),

    // ── `postClassification` subdocument ──
    /** Slug-only topic list (Stage A + B). The resolved form is a child table. */
    classificationTopics: text().array(),
    /**
     * EVERY detected/declared ISO 639-1 language, primary first. Multikey in
     * Mongo; the feed engine's language-overlap test is an `$in`, which a
     * `text[]` + GIN answers directly.
     */
    classificationLanguages: text().array(),
    /** Coarse region/country code. Best-effort, frequently absent. */
    classificationRegion: text(),
    /** Canonical hashtags in the classification's own normalization. */
    classificationHashtagsNorm: text().array(),
    classificationSensitive: boolean(),
    /**
     * The deterministic ruleset version that produced the Stage-A baseline.
     * Ranking refuses to honour scores stamped below `BASELINE_CLASSIFIER_VERSION`.
     */
    classificationVersion: integer(),
    classificationSentiment: text({ enum: POST_SENTIMENTS }).notNull().default('neutral'),
    classificationIntent: text({ enum: POST_INTENTS }).notNull().default('other'),
    classificationScoreToxicity: scoreColumn(),
    classificationScoreConstructiveness: scoreColumn(),
    classificationScoreSpam: scoreColumn(),
    classificationScoreQuality: scoreColumn(),
    classificationScoreControversy: scoreColumn(),
    classificationScoreNegativity: scoreColumn(),
    classificationConfidence: scoreColumn(),
    classificationStatus: text({ enum: POST_CLASSIFICATION_STATUSES })
      .notNull()
      .default('pending'),
    /** Attempts so far, so a persistently failing post can be given up on. */
    classificationAttempts: integer().notNull().default(0),
    classificationClassifiedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /**
     * `created_at` never carries precision a JavaScript `Date` cannot hold.
     *
     * This is the KEYSET axis — thirteen indexes below lead with it, and every
     * chronological cursor in the codebase is built by reading this column into
     * a `Date` and comparing against the result. `timestamptz` stores
     * microseconds and a `Date` holds milliseconds, so a value with microseconds
     * compares SMALLER than the row it came from: an ASC keyset then matches its
     * own anchor and pages forever (`backfill-mtn-records` did), and a DESC one
     * silently skips rows sharing the anchor's millisecond.
     *
     * `columns.ts` removes the precision at the source, in the DEFAULT. This
     * constraint is what stops it coming back: a future writer reaching for raw
     * `now()` fails loudly here instead of arming the same trap for whichever
     * keyset is written next. Every current writer is either that default or an
     * explicit JS `Date`, so nothing legitimate is rejected.
     */
    check(
      'posts_created_at_ms_precision_check',
      sql`${t.createdAt} = date_trunc('milliseconds', ${t.createdAt})`
    ),
    check('posts_type_check', sql`${t.type} in (${sql.raw(inList(POST_TYPES))})`),
    check(
      'posts_visibility_check',
      sql`${t.visibility} in (${sql.raw(inList(POST_VISIBILITIES))})`
    ),
    check('posts_status_check', sql`${t.status} in (${sql.raw(inList(POST_STATUSES))})`),
    check(
      'posts_room_status_check',
      sql`${t.contentRoomStatus} is null or ${t.contentRoomStatus} in (${sql.raw(inList(POST_ROOM_STATUSES))})`
    ),
    check(
      'posts_classification_status_check',
      sql`${t.classificationStatus} in (${sql.raw(inList(POST_CLASSIFICATION_STATUSES))})`
    ),
    check(
      'posts_classification_sentiment_check',
      sql`${t.classificationSentiment} in (${sql.raw(inList(POST_SENTIMENTS))})`
    ),
    check(
      'posts_classification_intent_check',
      sql`${t.classificationIntent} in (${sql.raw(inList(POST_INTENTS))})`
    ),
    // The ELEMENTS of the array, which is what Mongo's array-enum meant. `<@`
    // is true for an empty array too, matching Mongo (an empty list forbids
    // replies from nobody in particular — the application, not the schema,
    // decides that an empty list means "anyone").
    check(
      'posts_reply_permission_check',
      sql`${t.replyPermission} <@ array[${sql.raw(inList(REPLY_PERMISSIONS))}]::text[]`
    ),
    // Every classification score is a probability. Mongo declared `min`/`max` on
    // each; Mongoose only enforced them on document saves, so the same
    // production audit the `status` CHECK needs applies here.
    check(
      'posts_classification_scores_check',
      sql`${t.classificationScoreToxicity} between ${sql.raw(String(SCORE_MIN))} and ${sql.raw(String(SCORE_MAX))}
        and ${t.classificationScoreConstructiveness} between ${sql.raw(String(SCORE_MIN))} and ${sql.raw(String(SCORE_MAX))}
        and ${t.classificationScoreSpam} between ${sql.raw(String(SCORE_MIN))} and ${sql.raw(String(SCORE_MAX))}
        and ${t.classificationScoreQuality} between ${sql.raw(String(SCORE_MIN))} and ${sql.raw(String(SCORE_MAX))}
        and ${t.classificationScoreControversy} between ${sql.raw(String(SCORE_MIN))} and ${sql.raw(String(SCORE_MAX))}
        and ${t.classificationScoreNegativity} between ${sql.raw(String(SCORE_MIN))} and ${sql.raw(String(SCORE_MAX))}
        and ${t.classificationConfidence} between ${sql.raw(String(SCORE_MIN))} and ${sql.raw(String(SCORE_MAX))}`
    ),
    // A coordinate pair is all-or-nothing. Mongo's validator allowed an empty
    // array and the federated insert path had to strip half-written pairs by
    // hand (`outbox.service.ts:904`); here the state is simply unrepresentable.
    check(
      'posts_content_location_pair_check',
      sql`(${t.contentLocationLatitude} is null) = (${t.contentLocationLongitude} is null)`
    ),
    check(
      'posts_location_pair_check',
      sql`(${t.locationLatitude} is null) = (${t.locationLongitude} is null)`
    ),
    check(
      'posts_content_location_range_check',
      sql`${t.contentLocationLatitude} is null or (
        ${t.contentLocationLatitude} between -90 and 90
        and ${t.contentLocationLongitude} between -180 and 180)`
    ),
    check(
      'posts_location_range_check',
      sql`${t.locationLatitude} is null or (
        ${t.locationLatitude} between -90 and 90
        and ${t.locationLongitude} between -180 and 180)`
    ),

    // The reply discriminator can never DISAGREE with a parent link that is
    // actually present. Written as two implications rather than an equivalence
    // because the reverse is legitimate: `is_reply` with neither link is an
    // orphan — a native reply whose parent was deleted (`ON DELETE SET NULL`
    // fired) or a federated reply whose parent Mention never imported — and both
    // must remain storable.
    check(
      'posts_reply_discriminator_check',
      sql`${t.parentPostId} is null or ${t.isReply}`
    ),
    check(
      'posts_federated_reply_discriminator_check',
      sql`${t.federationInReplyTo} is null or ${t.isReply}`
    ),

    // Federation dedup. Mongo's `{unique: true, sparse: true}`; a Postgres
    // partial unique index is the exact analogue, and NULLs are distinct here
    // anyway so local posts are unaffected.
    uniqueIndex('posts_federation_activity_id_key')
      .on(t.federationActivityId)
      .where(sql`${t.federationActivityId} is not null`),

    // ── Hot paths, ported from `indexes/manifest.ts` + the model's own list ──
    // Named after the manifest entries so a DBA reading `pg_indexes` and a
    // developer reading the migration see the same names.
    index('post_public_chrono_v1').on(t.visibility, t.status, t.createdAt.desc(), t.id.desc()),
    // The root-feed predicate, which is now a column test rather than the
    // `parent_post_id IS NULL` + `federation.inReplyTo` disjunction it used to
    // be. Partial rather than a fourth key column: every root feed fixes
    // `is_reply = false`, so the index is the size of the root set and the
    // manifest-named index above keeps serving the queries it was named for.
    index('posts_roots_chrono_idx')
      .on(t.visibility, t.status, t.createdAt.desc(), t.id.desc())
      .where(sql`${t.isReply} = false`),
    index('post_replies_chrono_v1').on(
      t.parentPostId,
      t.visibility,
      t.status,
      t.createdAt.desc(),
      t.id.desc()
    ),
    index('post_links_chrono_v1').on(
      t.hasLinks,
      t.visibility,
      t.status,
      t.createdAt.desc(),
      t.id.desc()
    ),
    index('posts_owner_chrono_idx').on(t.oxyUserId, t.visibility, t.status, t.createdAt.desc(), t.id.desc()),
    index('posts_type_chrono_idx').on(t.type, t.visibility, t.status, t.createdAt.desc()),
    index('posts_created_at_idx').on(t.createdAt.desc()),
    index('posts_thread_idx').on(t.threadId, t.oxyUserId, t.parentPostId, t.createdAt),
    index('posts_boost_of_idx').on(t.boostOf, t.createdAt.desc()),
    index('posts_quote_of_idx').on(t.quoteOf, t.createdAt.desc()),
    index('posts_scheduled_idx')
      .on(t.scheduledFor)
      .where(sql`${t.status} = 'scheduled'`),

    // Multikey → GIN. These are the array predicates the feed engine actually
    // runs (`hashtags: {$in}`, `postClassification.languages: {$in}`,
    // `postClassification.topics: {$in}`), and a btree cannot serve any of them.
    index('posts_hashtags_gin').using('gin', t.hashtags),
    index('posts_classification_topics_gin').using('gin', t.classificationTopics),
    index('posts_classification_languages_gin').using('gin', t.classificationLanguages),
    index('posts_classification_region_idx').on(t.classificationRegion, t.createdAt.desc()),
    // The classification batch queue drains oldest-first within one status.
    index('posts_classification_queue_idx').on(t.classificationStatus, t.createdAt),

    // Mongo indexed `curated` SPARSE. A partial index is the analogue and keeps
    // the index the size of the curated set rather than the whole table.
    index('posts_curated_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.curated} is true`),

    // The two spatial indexes, replacing the `2dsphere` pair. GiST over the
    // GENERATED point, so there is nothing to keep in sync.
    index('posts_geo_gist').using('gist', t.geo),
    index('posts_content_geo_gist').using('gist', t.contentGeo),
  ]
);
