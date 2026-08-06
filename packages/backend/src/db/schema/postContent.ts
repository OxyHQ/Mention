/**
 * The child tables of `posts` — every array Mongo embedded in the post document.
 *
 * Each was an array of subdocuments (`content.variants`, `content.media`,
 * `content.attachments`, `content.sources`, `authorship`,
 * `postClassification.topicRefs`) or an array of ids (`mentions`). The
 * migration contract forbids both a jsonb array of objects with a known shape
 * and a jsonb id array, and every one of these is queried by element today —
 * the author feed matches `authorship` with `$elemMatch`, the videos feed
 * matches `content.media` with `$elemMatch`, the topic page matches
 * `postClassification.topicRefs.name`, and search runs a text index over
 * `content.variants.text`.
 *
 * `position` preserves the array ORDER, which is load-bearing in two places:
 * `post_content_variants.position = 0` is the PRIMARY rendition (what
 * federates, what is signed onto the MTN chain, what a reader with no matching
 * language falls back to), and `post_media` order is the order the client
 * renders the gallery in.
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
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, tsvector, updatedAt } from './columns';
import { posts } from './posts';

/** `PostAuthorRole` — exactly one `owner` per post, plus up to 5 collaborators. */
export const POST_AUTHOR_ROLES = ['owner', 'collaborator'] as const;

/** `PostAuthorStatus`. */
export const POST_AUTHOR_STATUSES = ['accepted', 'pending', 'declined', 'stopped'] as const;

/** `PostVariantSource` — author-written vs machine-translated. */
export const POST_VARIANT_SOURCES = ['author', 'machine'] as const;

/** `MediaItem.type`. */
export const MEDIA_TYPES = ['image', 'video', 'gif'] as const;

/** `MediaItem.orientation`, derived at ingest from width/height. */
export const MEDIA_ORIENTATIONS = ['portrait', 'landscape', 'square'] as const;

/**
 * `PostAttachmentType`.
 *
 * EIGHT values, not the seven the Mongoose enum declares: `models/Post.ts`
 * `AttachmentSchema` omits `'room'` while `@mention/shared-types`
 * `PostAttachmentType` includes it. Same class as `posts.status` — the narrower
 * list is the one that was never enforced, so the CHECK takes the union and a
 * production `distinct` is required before the backfill.
 */
export const POST_ATTACHMENT_TYPES = [
  'media',
  'poll',
  'article',
  'event',
  'location',
  'sources',
  'room',
  'podcast',
] as const;

/** `ClassificationTopicRef.type`. */
export const CLASSIFICATION_TOPIC_REF_TYPES = ['topic', 'entity'] as const;

/** `ClassificationTopicRef.relevance` is AI-discovered on a 1..10 scale. */
const TOPIC_RELEVANCE_MIN = 1;
const TOPIC_RELEVANCE_MAX = 10;

/**
 * `post_authorships` — the canonical multi-author list.
 *
 * Always exactly one `owner` with status `accepted`; `posts.oxy_user_id` is the
 * denormalized copy of that row's user. `AGENTS.md` states the array is REQUIRED
 * on every post and that there is no read-time legacy fallback, so this table is
 * the authority and the denormalized column is the projection.
 */
export const postAuthorships = pgTable(
  'post_authorships',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key (see `posts.ts`). */
    oxyUserId: text().notNull(),
    role: text({ enum: POST_AUTHOR_ROLES }).notNull(),
    status: text({ enum: POST_AUTHOR_STATUSES }).notNull(),
    invitedAt: timestamptz(),
    respondedAt: timestamptz(),

    /**
     * A copy of `posts.created_at`, and the ONLY reason it exists is that an
     * index cannot span two tables.
     *
     * The profile feed asks "this author's posts, newest first". The author lives
     * here and the timestamp lives on `posts`, so with no shared column the
     * planner has two bad choices and picks whichever the statistics favour:
     * walk a chronological index over the WHOLE table probing this one per
     * candidate row (measured 84–99 ms for an ordinary account, 42,394 probes to
     * return 21 rows), or gather every one of the author's posts and sort them
     * (cost proportional to their lifetime output, 243 ms at 20,000 posts).
     * Neither is bounded by the page. Carrying the timestamp HERE lets
     * `post_authorships_author_chrono_idx` answer the whole question — author,
     * status, order — and the join to `posts` becomes 21 primary-key lookups.
     *
     * Measured on 624k posts, page of 21, flat where the alternatives were not:
     *
     *   ordinary account (2,003 posts)    5.0 ms  →  0.81–0.95 ms
     *   prolific account (20,000 posts)   5.8 ms  →  0.93–1.00 ms
     *
     * ## Keeping it true
     *
     * `posts.created_at` is written once and never updated (`columns.ts`: "set by
     * the database on insert, never updated"), which is what makes a copy safe at
     * all — there is no update path to miss. It is written by the two functions
     * that write authorship rows, `insertChildRows` and `replacePostAuthorship`,
     * both inside the same transaction as the row they describe.
     *
     * Nullable, and deliberately not `NOT NULL`: the backfill fills it for
     * existing rows, and a `NOT NULL` column with no default cannot be added to a
     * populated table without rewriting it under an ACCESS EXCLUSIVE lock. A NULL
     * sorts last under `DESC NULLS LAST` rather than corrupting an order, and
     * `__tests__/authorshipChronoSync.test.ts` is what stops one being written.
     */
    postCreatedAt: timestamptz(),
  },
  (t) => [
    check('post_authorships_role_check', sql`${t.role} in (${sql.raw(inList(POST_AUTHOR_ROLES))})`),
    check(
      'post_authorships_status_check',
      sql`${t.status} in (${sql.raw(inList(POST_AUTHOR_STATUSES))})`
    ),
    // One entry per (post, user). Mongo could hold a duplicate; nothing wants one.
    unique('post_authorships_post_id_oxy_user_id_key').on(t.postId, t.oxyUserId),
    // Exactly one owner per post — the invariant `getOwnerId` assumes and Mongo
    // could not state. A second `owner` row now fails the insert.
    uniqueIndex('post_authorships_one_owner_per_post')
      .on(t.postId)
      .where(sql`${t.role} = 'owner'`),
    // The author feed's `$elemMatch` on (oxyUserId, status) becomes this.
    index('post_authorships_author_idx').on(t.oxyUserId, t.status),
    /**
     * The profile feed's whole question in one index: this author, accepted,
     * newest first. See {@link postAuthorships.postCreatedAt} for why the
     * timestamp is here at all.
     *
     * `desc()` emits `DESC NULLS LAST`, so the query that reads it must be
     * spelled `desc nulls last` too — a bare `desc()` means `DESC NULLS FIRST`
     * and matches nothing, which is the same trap `CursorBuilder.chronoOrderBy`
     * exists for. `post_id` is the tiebreak that makes the order total, and
     * carrying it here rather than joining for it is what keeps the scan
     * index-only until the page is chosen.
     */
    index('post_authorships_author_chrono_idx').on(
      t.oxyUserId,
      t.status,
      t.postCreatedAt.desc(),
      t.postId.desc()
    ),
  ]
);

/**
 * `post_content_variants` — one localized rendition of the body.
 *
 * `position = 0` is the PRIMARY. The Mongoose `pre('validate')` hook reorders
 * the array so author renditions precede machine translations; that ordering is
 * now a stored `position` the writer sets, because Postgres has no array to
 * reorder and the primary must be addressable by a predicate rather than by
 * `[0]`.
 *
 * The language column is `tag`, deliberately not `language` — carried over from
 * Mongo, where a field literally named `language` inside an indexed document is
 * read as the text index's per-document stemmer override and rejects any code
 * outside Mongo's stemmer set with error 17262. Postgres has no such trap, but
 * renaming the column would gratuitously diverge from the wire contract that
 * still calls it `tag`.
 */
export const postContentVariants = pgTable(
  'post_content_variants',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** 0 is the primary rendition. */
    position: integer().notNull(),
    /**
     * ISO 639-1 / BCP-47 tag. ABSENT when the post has no resolvable language —
     * a body too short to detect, or a federated Note that declares none. At
     * most one variant is untagged and it is the primary.
     */
    tag: text(),
    source: text({ enum: POST_VARIANT_SOURCES }).notNull(),
    body: text().notNull().default(''),
    /** Localized long-form. `articles` is the same entity, never duplicated. */
    articleTitle: text(),
    articleBody: text(),
    articleExcerpt: text(),
    /**
     * The rendition's own timestamp. Mongo stored this as a STRING; it is an
     * instant here. The backfill must parse it and write NULL when it cannot —
     * a value that is not a date is not a date in either store.
     */
    variantCreatedAt: timestamptz(),
    /**
     * The replacement for Mongo's `content.variants.text_text` index.
     *
     * GENERATED, so no write path can produce a row whose search vector
     * disagrees with its body. The configuration is the LITERAL `'english'`
     * (Mongo's `default_language`): the one-argument `to_tsvector` reads
     * `default_text_search_config` at runtime and is therefore STABLE, which
     * Postgres refuses in a generated column.
     */
    searchVector: tsvector().generatedAlwaysAs(sql`to_tsvector('english', coalesce(body, ''))`),
  },
  (t) => [
    check(
      'post_content_variants_source_check',
      sql`${t.source} in (${sql.raw(inList(POST_VARIANT_SOURCES))})`
    ),
    check('post_content_variants_position_check', sql`${t.position} >= 0`),
    unique('post_content_variants_post_id_position_key').on(t.postId, t.position),
    // At most one rendition per language per post. A tagless primary is exempt
    // (NULLs are distinct), which is exactly Mongo's behaviour.
    uniqueIndex('post_content_variants_post_id_tag_key')
      .on(t.postId, t.tag)
      .where(sql`${t.tag} is not null`),
    index('post_content_variants_search_gin').using('gin', t.searchVector),
    // "Give me the primary body for these posts" — the hydration hot path.
    index('post_content_variants_primary_idx')
      .on(t.postId)
      .where(sql`${t.position} = 0`),
  ]
);

/**
 * `post_media` — the post's SHARED media set, in render order.
 *
 * Mongo typed each entry `Schema.Types.Mixed` with a hand-written validator, so
 * the shape was documented in `@mention/shared-types` `MediaItem` and enforced
 * nowhere. These are the fields that are actually PERSISTED; `url`, `thumbUrl`,
 * `posterUrl`, `fullUrl` and `hlsUrl` on the DTO are resolved at read time by
 * `utils/mediaResolver.ts` and are deliberately absent here.
 */
export const postMedia = pgTable(
  'post_media',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    /**
     * The Oxy file id, OR a raw remote URL for federated media the cache has not
     * rewritten yet. Two id spaces in one column, which is what the application
     * stores and what `MediaMetadataService.isOxyFileId` discriminates.
     */
    mediaId: text().notNull(),
    type: text({ enum: MEDIA_TYPES }).notNull(),
    /** Author-written alt text (the Bluesky-style ALT badge). */
    alt: text(),
    width: integer(),
    height: integer(),
    durationSec: doublePrecision(),
    sizeBytes: integer(),
    orientation: text({ enum: MEDIA_ORIENTATIONS }),
    aspectRatio: doublePrecision(),
    mime: text(),
    /** The origin URL, kept when the media cache rewrote `media_id` to a file id. */
    remoteUrl: text(),
    cachedFromFederation: boolean(),
  },
  (t) => [
    check('post_media_type_check', sql`${t.type} in (${sql.raw(inList(MEDIA_TYPES))})`),
    check(
      'post_media_orientation_check',
      sql`${t.orientation} is null or ${t.orientation} in (${sql.raw(inList(MEDIA_ORIENTATIONS))})`
    ),
    // Mongo's `isValidMediaItem` rejected a non-positive numeric field. Same rule.
    check(
      'post_media_positive_dimensions_check',
      sql`(${t.width} is null or ${t.width} > 0)
        and (${t.height} is null or ${t.height} > 0)
        and (${t.durationSec} is null or ${t.durationSec} > 0)
        and (${t.sizeBytes} is null or ${t.sizeBytes} > 0)
        and (${t.aspectRatio} is null or ${t.aspectRatio} > 0)`
    ),
    check('post_media_position_check', sql`${t.position} >= 0`),
    unique('post_media_post_id_position_key').on(t.postId, t.position),
    // The videos feed's `$elemMatch` on (type, orientation, durationSec) plus a
    // width/height floor. Leading with `type` because every such query fixes it.
    index('post_media_video_idx').on(t.type, t.orientation, t.durationSec),
    // "Which post is this media on" — the media-cache rewrite path.
    index('post_media_media_id_idx').on(t.mediaId),
  ]
);

/**
 * `post_variant_media` — a language variant's media OVERRIDE (a different
 * infographic per language). Absent means the variant shows the shared set.
 *
 * Mutually exclusive with `post_variant_alt_texts` by application rule
 * (`validateAuthorVariants`): a replaced set carries its own alt text.
 */
export const postVariantMedia = pgTable(
  'post_variant_media',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => postContentVariants.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    mediaId: text().notNull(),
    type: text({ enum: MEDIA_TYPES }).notNull(),
    alt: text(),
    width: integer(),
    height: integer(),
    durationSec: doublePrecision(),
    sizeBytes: integer(),
    orientation: text({ enum: MEDIA_ORIENTATIONS }),
    aspectRatio: doublePrecision(),
    mime: text(),
    remoteUrl: text(),
    cachedFromFederation: boolean(),
  },
  (t) => [
    check('post_variant_media_type_check', sql`${t.type} in (${sql.raw(inList(MEDIA_TYPES))})`),
    check(
      'post_variant_media_orientation_check',
      sql`${t.orientation} is null or ${t.orientation} in (${sql.raw(inList(MEDIA_ORIENTATIONS))})`
    ),
    check(
      'post_variant_media_positive_dimensions_check',
      sql`(${t.width} is null or ${t.width} > 0)
        and (${t.height} is null or ${t.height} > 0)
        and (${t.durationSec} is null or ${t.durationSec} > 0)
        and (${t.sizeBytes} is null or ${t.sizeBytes} > 0)
        and (${t.aspectRatio} is null or ${t.aspectRatio} > 0)`
    ),
    check('post_variant_media_position_check', sql`${t.position} >= 0`),
    unique('post_variant_media_variant_id_position_key').on(t.variantId, t.position),
  ]
);

/**
 * `post_variant_alt_texts` — localized alt text for the SHARED media set,
 * keyed by media id.
 *
 * Mongo stored this as a `Mixed` object used as a `Record<mediaId, string>`.
 * That is a MAP with a known key and value type, so it becomes a child table —
 * jsonb would make "does this media item have localized alt in language X"
 * unanswerable by an index.
 */
export const postVariantAltTexts = pgTable(
  'post_variant_alt_texts',
  {
    id: generatedId(),
    variantId: text()
      .notNull()
      .references(() => postContentVariants.id, { onDelete: 'cascade' }),
    /** The `post_media.media_id` this describes. */
    mediaId: text().notNull(),
    description: text().notNull(),
  },
  (t) => [unique('post_variant_alt_texts_variant_id_media_id_key').on(t.variantId, t.mediaId)]
);

/**
 * `post_attachments` — the ordered attachment descriptors.
 *
 * A thin pointer list: `media` entries carry an id and a media type, the rest
 * are markers that a poll/article/event/room/podcast exists on the post (the
 * data itself is in the `content_*` columns or an owning table).
 */
export const postAttachments = pgTable(
  'post_attachments',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    type: text({ enum: POST_ATTACHMENT_TYPES }).notNull(),
    /** Required for `media`, absent otherwise — exactly Mongo's conditional. */
    attachmentId: text(),
    mediaType: text({ enum: MEDIA_TYPES }),
  },
  (t) => [
    check(
      'post_attachments_type_check',
      sql`${t.type} in (${sql.raw(inList(POST_ATTACHMENT_TYPES))})`
    ),
    check(
      'post_attachments_media_type_check',
      sql`${t.mediaType} is null or ${t.mediaType} in (${sql.raw(inList(MEDIA_TYPES))})`
    ),
    // Mongo made `id`/`mediaType` `required` only when `type === 'media'`. That
    // conditional requirement is a CHECK here rather than a validator function.
    check(
      'post_attachments_media_fields_check',
      sql`${t.type} <> 'media' or (${t.attachmentId} is not null and ${t.mediaType} is not null)`
    ),
    check('post_attachments_position_check', sql`${t.position} >= 0`),
    unique('post_attachments_post_id_position_key').on(t.postId, t.position),
  ]
);

/** `post_sources` — external sources cited in the post, in author order. */
export const postSources = pgTable(
  'post_sources',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    position: integer().notNull(),
    url: text().notNull(),
    title: text(),
  },
  (t) => [
    check('post_sources_position_check', sql`${t.position} >= 0`),
    unique('post_sources_post_id_position_key').on(t.postId, t.position),
  ]
);

/**
 * `post_mentions` — the resolved @mention allowlist.
 *
 * Mongo held `mentions: [String]` (Oxy user ids), multikey-indexed and queried
 * by element for the mentions feed and for notification fan-out. An id array is
 * a junction table by the contract; it also gets the per-user index a `text[]`
 * could only approximate with GIN.
 */
export const postMentions = pgTable(
  'post_mentions',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
  },
  (t) => [
    unique('post_mentions_post_id_oxy_user_id_key').on(t.postId, t.oxyUserId),
    // "Posts that mention me", newest first — the mentions surface.
    index('post_mentions_oxy_user_id_idx').on(t.oxyUserId),
  ]
);

/**
 * `post_classification_topic_refs` — the RESOLVED form of
 * `postClassification.topics`.
 *
 * Carries the slug plus the Topic-registry id when the name resolved. The
 * registry lives in Oxy, so `topic_id` is a cross-service id with no foreign
 * key; the slug-only list stays on `posts.classification_topics` because
 * candidate fetching matches it as a set.
 */
export const postClassificationTopicRefs = pgTable(
  'post_classification_topic_refs',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** The canonical lowercase topic slug. */
    name: text().notNull(),
    /** The Oxy Topic-registry id, when the slug resolved to one. */
    topicId: text(),
    relevance: integer(),
    type: text({ enum: CLASSIFICATION_TOPIC_REF_TYPES }),
  },
  (t) => [
    check(
      'post_classification_topic_refs_type_check',
      sql`${t.type} is null or ${t.type} in (${sql.raw(inList(CLASSIFICATION_TOPIC_REF_TYPES))})`
    ),
    check(
      'post_classification_topic_refs_relevance_check',
      sql`${t.relevance} is null or ${t.relevance} between ${sql.raw(String(TOPIC_RELEVANCE_MIN))} and ${sql.raw(String(TOPIC_RELEVANCE_MAX))}`
    ),
    unique('post_classification_topic_refs_post_id_name_key').on(t.postId, t.name),
    // The canonical topic-page lookup (`postClassification.topicRefs.name`).
    index('post_classification_topic_refs_name_idx').on(t.name),
    index('post_classification_topic_refs_topic_id_idx')
      .on(t.topicId)
      .where(sql`${t.topicId} is not null`),
  ]
);

/**
 * How many repliers the projection keeps per post.
 *
 * Lives next to the table it constrains and is the ONE declaration of the cap:
 * `PostRecentReplierService` enforces it on write and honours it on read, and
 * the (now write-dead) Mongoose model's array validator reads it from here. A
 * CHECK cannot count sibling rows, so this is application-enforced by necessity
 * rather than by preference — which is exactly why it must not exist twice.
 */
export const POST_RECENT_REPLIER_LIMIT = 3;

/**
 * `post_recent_repliers` — the ≤3 most recent distinct repliers, per post.
 *
 * Mongo kept one document per post holding an ORDERED array with a `≤3`
 * validator, maintained by a hand-written aggregation update pipeline
 * (`buildRecentReplierUpdatePipeline`). Here it is one ROW per (post, replier)
 * with the cap enforced by the writer, because the pipeline existed only to
 * splice an array in place — a thing Postgres never needs to do.
 */
export const postRecentRepliers = pgTable(
  'post_recent_repliers',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    repliedAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('post_recent_repliers_post_id_oxy_user_id_key').on(t.postId, t.oxyUserId),
    // The read is always "this post's repliers, newest first".
    index('post_recent_repliers_post_idx').on(t.postId, t.repliedAt.desc()),
  ]
);

/**
 * `post_corrections` — the PUBLIC record of how a channel post's body has
 * changed since it was published.
 *
 * A channel is a publication, and a publication corrects in the open. Its posts
 * are editable for their whole life (the 30-minute window personal posts carry
 * does not apply — see `updatePost`), and this table is the price of that: every
 * correction leaves a row saying what the post said BEFORE it, so a reader can
 * see that it changed and read the version they were shown.
 *
 * ## One row per correction, holding the body it SUPERSEDED
 *
 * `previous_text` is the primary rendition as it read immediately before this
 * correction, so revision 1 holds the post AS PUBLISHED and the live post is the
 * newest version. The full history is therefore
 * `[revision 1, revision 2, …, the post itself]` and nothing needs to duplicate
 * the current body here.
 *
 * ## `corrected_by_oxy_user_id` is stored and NEVER served
 *
 * A channel's writer is disclosed only when the channel sets
 * `UserSettings.channel.signPosts`, which is why `posts.written_by_oxy_user_id`
 * is absent from the post DTO. A correction is made by exactly such a writer, so
 * shipping it here would route around that setting and end the anonymity of every
 * channel that did not opt in — the same reasoning, one table over. It exists for
 * operator audit and stays server-side; see `listPostCorrections`, which does not
 * select it.
 *
 * ## Retention
 *
 * Bounded per post by `MAX_RETAINED_POST_CORRECTIONS`, oldest-superseded-first,
 * with revision 1 exempt — the version as published is the one a correction trail
 * exists to preserve. `posts.correction_count` counts corrections MADE, so the
 * cap can never make a publication look like it rewrote itself less often than it
 * did; only the intermediate bodies become unreadable, and the gap in `revision`
 * says exactly where.
 *
 * Append-only: a row records that something happened at a moment, so it carries
 * `created_at` alone (the CONVENTIONS contract for an append-only table) and that
 * timestamp IS when the correction was made.
 */
export const postCorrections = pgTable(
  'post_corrections',
  {
    id: generatedId(),
    postId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /**
     * 1-based, in the order the corrections happened. NOT a row count: retention
     * deletes intermediate rows and never renumbers, so a gap is a dropped body
     * rather than a miscount.
     */
    revision: integer().notNull(),
    /** The primary rendition as it read BEFORE this correction. */
    previousText: text().notNull(),
    /**
     * The human who made the correction — an Oxy account id, no foreign key.
     * Stored for audit, never served; see the module docblock.
     */
    correctedByOxyUserId: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check('post_corrections_revision_check', sql`${t.revision} >= 1`),
    // One row per revision of a post, and the only read this table serves —
    // "this post's trail, in order" — is a leading-prefix scan of it. A separate
    // index on `post_id` would be redundant with it.
    unique('post_corrections_post_id_revision_key').on(t.postId, t.revision),
  ]
);
