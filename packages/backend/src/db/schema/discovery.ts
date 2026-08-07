/**
 * Discovery and telemetry: `trending`, `trend_batches`, `topic_stats`,
 * `author_follower_snapshots`, `gifs`, `notifications`, `push_tokens`.
 *
 * Three of these had Mongo TTL indexes (`trending`, `notifications`,
 * `author_follower_snapshots`); each keeps the btree its sweep predicate needs
 * and gets a registry entry in `db/expiry.ts`. Every one of the three was
 * written to DELETE the row, and deleting is still the intent — checked one by
 * one, because the sibling port found a TTL that was destroying history someone
 * meant to keep.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { TREND_CATEGORIES } from '@mention/shared-types';
import type { TrendGraphEdgeDTO, TrendGraphNodeDTO } from '@mention/shared-types';
import { createdAt, generatedId, inList, timestamptz, tsvector, updatedAt } from '@oxyhq/db';

/** The vocabulary the `trending.type` CHECK enforces. */
export const TRENDING_TYPES = ['hashtag', 'topic', 'entity'] as const;

/**
 * The same three strings as a string ENUM — the PUBLIC vocabulary.
 *
 * Both spellings exist on purpose, and `TrendingService.ts` explains why:
 * TypeScript treats enums nominally, so an enum member is not assignable to
 * `'hashtag'` and vice versa. The enum is what `routes/trending.routes.ts`
 * validates `?type=` against; everything that touches a row uses the column's
 * own literal union. They are identical at runtime, which is what makes the
 * boundary conversion a no-op rather than a translation.
 *
 * It lives HERE, beside the array the CHECK is built from, rather than in
 * `models/Trending.ts` where it used to. An enum is a VALUE, so importing it
 * executed `mongoose.model(...)` — two production files registered a Mongoose
 * model to read three constants, on data that is already Postgres.
 */
export enum TrendingType {
  HASHTAG = 'hashtag',
  TOPIC = 'topic',
  ENTITY = 'entity',
}

/**
 * The two spellings cannot drift.
 *
 * Adjacency is a convention; this is a compile error. Each direction is needed:
 * the first catches an enum member the CHECK would refuse, the second catches a
 * vocabulary entry the route would silently stop accepting as a `?type=` filter.
 */
const _trendingTypeCoversVocabulary: Record<(typeof TRENDING_TYPES)[number], TrendingType> = {
  hashtag: TrendingType.HASHTAG,
  topic: TrendingType.TOPIC,
  entity: TrendingType.ENTITY,
};
const _vocabularyCoversTrendingType: Record<TrendingType, (typeof TRENDING_TYPES)[number]> = {
  [TrendingType.HASHTAG]: 'hashtag',
  [TrendingType.TOPIC]: 'topic',
  [TrendingType.ENTITY]: 'entity',
};
void _trendingTypeCoversVocabulary;
void _vocabularyCoversTrendingType;

/** `TrendStatus` — present only while a trend is bursting hard enough to say so. */
export const TREND_STATUSES = ['hot'] as const;

/** `NotificationType`. */
export const NOTIFICATION_TYPES = [
  'like',
  'reply',
  'mention',
  'follow',
  'boost',
  'quote',
  'welcome',
  'post',
  'poke',
  'collab_invite',
  'collab_accepted',
  'collab_declined',
  // `'channel_invite'` was here and is gone, and it needed no production
  // reading to remove — which is worth stating, because the sibling column
  // below DID.
  //
  // It appeared in exactly ONE place in the repository: this line. No writer in
  // the backend, nothing in `@mention/shared-types`, nothing in the frontend.
  // And the decisive fact is structural rather than statistical: the Mongoose
  // model this vocabulary is copied FROM (`models/Notification.ts`) declares
  // `type` without it, and Mongoose validates the enum on every save — so
  // production cannot hold a `channel_invite` notification, and there was no
  // code path that could have written one past the validator anyway.
  //
  // Carrying it meant the Postgres CHECK admitted a value the source schema
  // forbids, which is a vocabulary disagreement in the permissive direction:
  // harmless to the copy, and exactly what `closedValueSets` exists to refuse.
  // Re-add it WITH its writer if channel invitations are ever built.
] as const;

/**
 * `NotificationEntityType`.
 *
 * `'channel'` was here and is gone. Three independent facts, and it needed all
 * three — a value with no rows is not the same as a value with no writer:
 *
 *  1. Production holds exactly `['post', 'profile']` — measured twice, 1h54m
 *     apart, identical. No row would hit the tightened CHECK.
 *  2. NOTHING writes `'channel'`. The channel model it belonged to is retired.
 *  3. The Mongoose source (`models/Notification.ts`) declares
 *     `['post', 'reply', 'profile']`, so carrying `'channel'` was a
 *     disagreement between the two vocabularies rather than a wider one.
 *
 * `'reply'` STAYS, and the reason is the trap in the same neighbourhood: it has
 * no production rows either, but `connectors/activitypub/inbox.service.ts` is
 * typed `entityType: 'post' | 'reply'` and writes it for a federated reply.
 * Zero rows there is timing, not deadness — dropping it would refuse a
 * legitimate write the first time a federated reply arrived.
 */
export const NOTIFICATION_ENTITY_TYPES = ['post', 'reply', 'profile'] as const;

/** `PushToken.type`. */
export const PUSH_TOKEN_TYPES = ['fcm', 'apns', 'unknown'] as const;

/** `PushToken.platform`. */
export const PUSH_TOKEN_PLATFORMS = ['android', 'ios', 'unknown'] as const;

/**
 * Retention windows, in seconds, for the three tables in this module that had a
 * Mongo TTL index. Declared here beside the table and asserted EQUAL to the
 * Mongoose model's own constant by `__tests__/expiry.test.ts`, so the two cannot
 * drift while both stores are live.
 */
export const TRENDING_RETENTION_SECONDS = 90 * 24 * 60 * 60;
/**
 * 30 days. Long enough that a story people return to keeps its summary, short
 * enough that a collection of one-off explanations for terms nobody will search
 * again stays bounded.
 */
export const TREND_SUMMARY_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const NOTIFICATION_RETENTION_SECONDS = 90 * 24 * 60 * 60;
/** 30 days — `SNAPSHOT_TTL_SECONDS` in `models/AuthorFollowerSnapshot.ts`. */
export const AUTHOR_FOLLOWER_SNAPSHOT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** `Gif.source` — only Klipy today. */
export const GIF_SOURCES = ['klipy'] as const;

/**
 * `trending` — one row per (name, type) per batch.
 *
 * The unique key is `(name, calculated_at, type)` in that ORDER, and the order
 * is load-bearing: `(name, calculated_at)` stays an exact index prefix, so the
 * per-name volume-series range scan behind the sparkline gets its sort straight
 * from the index. Moving `type` into the middle adds a blocking sort.
 *
 * `type` is in the key at all because a trend is a (name, type) PAIR: a hashtag
 * someone typed and a topic the classifier inferred legitimately appear in one
 * batch under the same name and route to different screens. Keying on the name
 * alone made that collision fatal — the batch insert aborted and the job stopped
 * publishing.
 */
export const trending = pgTable(
  'trending',
  {
    id: generatedId(),
    type: text({ enum: TRENDING_TYPES }).notNull(),
    /**
     * The TERM — the retrieval key. Lowercase, possibly a phrase, and what the
     * `trend|<name>` feed matches posts against. Not for display: see
     * {@link trending.displayName}.
     */
    name: text().notNull(),
    /**
     * What a reader is shown ("Kremer Trade" for the term `orioles`).
     *
     * NULLABLE only because the table retains 90 days of rows written before
     * trends had labels; every row written from now on carries one. Readers fall
     * back to `name` — exactly the old behaviour for an old row, and never a
     * fabricated label.
     */
    displayName: text(),
    /** Coarse taxonomy hint shown under the label. NULL on pre-label rows. */
    category: text({ enum: TREND_CATEGORIES }),
    /**
     * Which labelling rules produced {@link trending.displayName}. A label from
     * older rules is re-derived rather than carried forward for the rest of the run.
     */
    labelVersion: integer(),
    /**
     * The primary languages of the posts behind this term (ISO 639-1).
     *
     * A trend is not language-neutral — `noticia` is a Spanish story and reading
     * it in an Italian list is noise — so the languages travel with the row and
     * the reader's own are matched against them. NULL on rows written before
     * trending measured language, which simply match every reader.
     */
    languages: text().array(),
    description: text().notNull().default(''),
    score: doublePrecision().notNull(),
    /** Posts carrying the term in the trailing window. */
    volume: integer().notNull().default(0),
    /**
     * DISTINCT authors behind those posts. Stored alongside `volume` because it,
     * not the post count, is what the reporting floor is applied to — keeping it
     * makes a stored row explain why it qualified.
     */
    authorCount: integer(),
    /**
     * How far above its own baseline the term landed, in standard deviations —
     * the actual trend measurement (`score` only orders it). NULL on rows written
     * before detection became a burst statistic.
     */
    burstScore: doublePrecision(),
    momentum: doublePrecision().notNull().default(0),
    /**
     * When the CURRENT run of this trend began — reconstructed from the batches
     * it has appeared in, not from when this row was written. Drives the client's
     * `new` badge and its age label. NULL on pre-onset rows.
     */
    startedAt: timestamptz(),
    /** Present only while the trend is bursting hard enough to be called out. */
    status: text({ enum: TREND_STATUSES }),
    /**
     * A few of the accounts behind the trend, for the faces shown beside it.
     * Evidence that real people are posting, not a directory — capped at
     * `MtnConfig.trending.detection.maxActors`. Oxy account ids, no foreign key.
     */
    actorIds: text().array(),
    /**
     * Every term this row stands for, `name` first.
     *
     * A story arrives as several names at once and co-occurrence merges them
     * into ONE row, so the row's feed has to match all of them. Without this the
     * merge would be actively harmful: `Ukraine` would absorb `Kyiv`'s evidence
     * into its score and then open onto a screen missing every post that only
     * said `Kyiv`.
     *
     * NULLABLE for the same reason `display_name` is — 90 days of rows predate
     * clustering. A reader falls back to `[name]`, which is what an unmerged row
     * means anyway, so NULL and `{name}` are the same fact and neither needs a
     * backfill.
     */
    terms: text().array(),
    rank: integer().notNull(),
    /** An Oxy Topic-registry id — no foreign key (the registry lives in Oxy). */
    topicId: text(),
    /** The batch stamp. Also the expiry column — see `db/expiry.ts`. */
    calculatedAt: timestamptz().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('trending_type_check', sql`${t.type} in (${sql.raw(inList(TRENDING_TYPES))})`),
    check(
      'trending_category_check',
      sql`${t.category} is null or ${t.category} in (${sql.raw(inList(TREND_CATEGORIES))})`
    ),
    check(
      'trending_status_check',
      sql`${t.status} is null or ${t.status} in (${sql.raw(inList(TREND_STATUSES))})`
    ),
    check('trending_volume_check', sql`${t.volume} >= 0`),
    unique('trending_name_calculated_at_type_key').on(t.name, t.calculatedAt, t.type),
    // Latest batch + history browsing.
    index('trending_batch_idx').on(t.calculatedAt.desc(), t.score.desc()),
    // Required by the expiry sweep, and it doubles as the ascending range index
    // the history aggregation's `calculated_at >= cutoff` uses.
    index('trending_calculated_at_idx').on(t.calculatedAt),
    index('trending_topic_id_idx')
      .on(t.topicId)
      .where(sql`${t.topicId} is not null`),
  ]
);

/**
 * `trend_summaries` — one generated explanation per (term, run).
 *
 * `run_started_at` is part of the IDENTITY, not metadata: `orioles` is a trade
 * this week and a no-hitter next month, so a summary written for one would be
 * actively wrong for the other and keying on the term alone would serve it
 * anyway. A new run therefore earns a new summary, and has to clear the demand
 * threshold again to get one.
 *
 * The unique constraint is what makes generation idempotent BY CONSTRUCTION: a
 * race between two tasks that both cleared the threshold ends with one insert
 * and one unique violation, never two generations stored.
 *
 * `generated_at` is the expiry column — see `db/expiry.ts` (30 days). Derived
 * text, so losing an old one costs nothing but a regeneration that demand would
 * have to justify all over again.
 */
export const trendSummaries = pgTable(
  'trend_summaries',
  {
    id: generatedId(),
    /** The trending term this explains. */
    term: text().notNull(),
    /** Onset of the RUN the summary was written for. */
    runStartedAt: timestamptz().notNull(),
    description: text().notNull(),
    generatedAt: timestamptz().notNull(),
  },
  (t) => [
    unique('trend_summaries_term_run_started_at_key').on(t.term, t.runStartedAt),
    // Required by the expiry sweep.
    index('trend_summaries_generated_at_idx').on(t.generatedAt),
  ]
);

/**
 * `trend_graphs` — one batch's CO-OCCURRENCE GRAPH, the structure behind the
 * trend list.
 *
 * ONE ROW PER BATCH, not a row per edge. A graph is a snapshot: its nodes and
 * edges are only meaningful against each other and against the batch that
 * produced them, so the batch is the natural unit — one insert, one read, and no
 * way to serve half of one graph beside half of another. That is also why `nodes`
 * and `edges` are `jsonb` rather than the two child tables the migration
 * contract would otherwise ask for: nothing queries an edge or a node
 * individually (the ONLY read is `trendGraphQuery`, which loads a whole batch and
 * filters in memory), and splitting them would buy per-element predicates nobody
 * writes at the cost of making a graph assemblable from two batches.
 *
 * NORMALIZED against `trending`: a node carries structure only. Its display
 * label is NOT stored here — merged rows already have one on their `trending`
 * row and the read path joins them, so there is no second place for a label to
 * be wrong; most nodes are not trends at all and have no label to copy.
 *
 * `calculated_at` is the expiry column — see `db/expiry.ts`. Mongo reaped these
 * with a TTL index and Postgres will not, so the registry entry is what keeps
 * the table bounded.
 */

/**
 * A stored node — the wire DTO MINUS `display_name`.
 *
 * The omission is the normalization rule stated above, written into the type so
 * it cannot be violated by a writer that happens to have a label to hand: a
 * label lives on the term's `trending` row and is joined at read time.
 */
export type StoredTrendGraphNode = Omit<TrendGraphNodeDTO, 'displayName'>;
export const trendGraphs = pgTable(
  'trend_graphs',
  {
    id: generatedId(),
    // (see `StoredTrendGraphNode` below for why the node type is not the DTO)
    /**
     * The batch stamp, and the identity. UNIQUE so a retried batch REPLACES its
     * own graph rather than leaving two — the property `saveTrendGraph`'s upsert
     * relies on.
     */
    calculatedAt: timestamptz().notNull().unique('trend_graphs_calculated_at_key'),
    nodes: jsonb().$type<StoredTrendGraphNode[]>().notNull().default([]),
    edges: jsonb().$type<TrendGraphEdgeDTO[]>().notNull().default([]),
    /**
     * Edges dropped for size, if any. A cap that is not reported reads as "this
     * is the whole graph" when it is not.
     */
    droppedEdges: integer(),
  },
  (t) => [
    // The unique constraint above already indexes `calculated_at`, which is what
    // the expiry sweep's `calculated_at <= now() - N` needs; no second index.
    check('trend_graphs_dropped_edges_check', sql`${t.droppedEdges} is null or ${t.droppedEdges} >= 0`),
  ]
);

/** 7 days. Long enough to compare a few days of batches, short enough to stay small. */
export const TREND_GRAPH_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** `trend_batches` — one row per published batch, for the history index. */
export const trendBatches = pgTable(
  'trend_batches',
  {
    id: generatedId(),
    calculatedAt: timestamptz().notNull().unique('trend_batches_calculated_at_key'),
    summary: text().notNull().default(''),
  }
);

/**
 * `topic_stats` — popularity and post count per Oxy topic.
 *
 * `topic_id` is a cross-service id (the registry is Oxy's) and is unique here —
 * one stats row per topic.
 */
export const topicStats = pgTable(
  'topic_stats',
  {
    id: generatedId(),
    /** An Oxy Topic-registry id — no foreign key. */
    topicId: text().notNull().unique('topic_stats_topic_id_key'),
    popularity: doublePrecision().notNull().default(0),
    postCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('topic_stats_post_count_check', sql`${t.postCount} >= 0`),
    index('topic_stats_popularity_idx').on(t.popularity.desc()),
  ]
);

/**
 * `author_follower_snapshots` — a rolling per-author follower-count time series.
 *
 * The `risingCreators` source computes a growth delta over a window from these
 * (current − prior). Bounded by a 30-day retention entry in `db/expiry.ts`;
 * deleting an old sample is the intent — the delta only ever looks inside the
 * window.
 */
export const authorFollowerSnapshots = pgTable(
  'author_follower_snapshots',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    followerCount: integer().notNull(),
    /** The sample instant. Also the expiry column — see `db/expiry.ts`. */
    at: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    check('author_follower_snapshots_follower_count_check', sql`${t.followerCount} >= 0`),
    // Per-author time-ordered lookup (the delta reads first/last in a window).
    index('author_follower_snapshots_owner_chrono_idx').on(t.oxyUserId, t.at.desc()),
    // Required by the expiry sweep.
    index('author_follower_snapshots_at_idx').on(t.at),
  ]
);

/**
 * `gifs` — a GIF fully IMPORTED into Mention's own library, not a TTL cache.
 *
 * The bytes live in Oxy S3; the row is the deduped index keyed by the provider
 * id, so a GIF posted by N users maps to one row and one pair of shared file ids.
 *
 * Mongo's `$text` index over `searchTerms` + `title` becomes a GENERATED
 * `tsvector` + GIN. Mongo's 5:1 `searchTerms`:`title` ratio is reproduced by
 * `GIF_RANK_WEIGHTS` in `services/gifLibrary/gifLibraryService.ts` — NOT by the
 * `setweight` calls below, which do not both do what they read as.
 *
 * The `setweight(…, 'A')` on the `searchTerms` half is a **no-op**:
 * `array_to_tsvector` emits lexemes with no positions, a weight label lives on a
 * position, so there is nothing to label and those lexemes stay in the default D
 * bucket. Measured, not reasoned — on PostgreSQL 17.5,
 * `setweight(array_to_tsvector(array['alpha','beta']),'A')` renders
 * `'alpha' 'beta'` unchanged, while `setweight(to_tsvector('simple','alpha beta'),'B')`
 * renders `'alpha':1B 'beta':2B`. The live buckets are therefore **D and B**, and
 * `GIF_RANK_WEIGHTS` is `{D,C,B,A} = {1.0, 0, 0.2, 0}` for exactly that reason:
 * 1.0/0.2 = 5. Read that constant's docblock before touching either half — the
 * two are one decision split across two files, and the A label reading as live
 * here is what would invert the ordering if someone "tidied" the weights.
 *
 * The two halves use DIFFERENT functions, and the reason is volatility rather
 * than taste. `array_to_string(text[], text)` is STABLE, so
 * `to_tsvector('simple', array_to_string(search_terms, ' '))` is rejected
 * outright — `generation expression is not immutable`, measured, not guessed
 * (`pg_proc.provolatile = 's'`). `array_to_tsvector(text[])` IS immutable and
 * takes each element as a lexeme verbatim, which is also the more faithful port:
 * `normalizeToTerms` in `services/gifLibrary/gifLibraryService.ts` already
 * lowercases, strips diacritics and punctuation, and drops stop words, and BOTH
 * the stored terms and the query go through it — that is exactly what Mongo's
 * `default_language: 'none'` meant. `title` is raw remote text, so it goes
 * through `to_tsvector('simple', …)`, the immutable no-stemming configuration.
 */
export const gifs = pgTable(
  'gifs',
  {
    id: generatedId(),
    /** The provider id (Klipy's numeric id, stringified). The dedup key. */
    klipyId: text().notNull().unique('gifs_klipy_id_key'),
    source: text({ enum: GIF_SOURCES }).notNull().default('klipy'),
    slug: text().notNull().default(''),
    title: text().notNull().default(''),
    /** Normalized query terms this GIF surfaced for. Appended to, deduped. */
    searchTerms: text().array().notNull().default(sql`array[]::text[]`),
    width: integer().notNull(),
    height: integer().notNull(),
    /** Oxy file id of the imported full mp4 — the SHARED source on posts. */
    mp4FileId: text().notNull(),
    /** Oxy file id of the small mp4 preview — the picker grid tile. */
    previewFileId: text().notNull(),
    useCount: integer().notNull().default(0),
    searchHitCount: integer().notNull().default(0),
    lastUsedAt: timestamptz().notNull().defaultNow(),
    searchVector: tsvector().generatedAlwaysAs(
      sql`setweight(array_to_tsvector(search_terms), 'A')
        || setweight(to_tsvector('simple', title), 'B')`
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('gifs_source_check', sql`${t.source} in (${sql.raw(inList(GIF_SOURCES))})`),
    check('gifs_dimensions_check', sql`${t.width} > 0 and ${t.height} > 0`),
    check('gifs_counts_check', sql`${t.useCount} >= 0 and ${t.searchHitCount} >= 0`),
    index('gifs_search_gin').using('gin', t.searchVector),
    // Local-first ranking: most-posted, then most-recently-used as the tie-break.
    index('gifs_use_count_idx').on(t.useCount.desc()),
    index('gifs_last_used_at_idx').on(t.lastUsedAt.desc()),
  ]
);

/**
 * `notifications` — one row per (recipient, actor, type, entity).
 *
 * The unique index is what makes the notification writer idempotent (a second
 * like from the same actor on the same post cannot mint a second row). Bounded
 * by a 90-day retention entry in `db/expiry.ts`; deleting is the intent — the
 * list is a rolling recent view and nothing reads a year-old notification.
 *
 * `entity_id` is polymorphic by `entity_type` (`post` | `reply` → `posts.id`,
 * `profile` → an Oxy account id), so it carries no foreign key. The consequence
 * is real and already true today: `deletePost` deletes notifications for the
 * post by hand (`posts.controller.ts:1747`) rather than relying on a cascade,
 * and the query phase must keep doing so.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: generatedId(),
    /** Oxy account ids — no foreign keys. */
    recipientId: text().notNull(),
    actorId: text().notNull(),
    type: text({ enum: NOTIFICATION_TYPES }).notNull(),
    /** Polymorphic by `entity_type` — no foreign key. See the docblock. */
    entityId: text().notNull(),
    entityType: text({ enum: NOTIFICATION_ENTITY_TYPES }).notNull(),
    read: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'notifications_type_check',
      sql`${t.type} in (${sql.raw(inList(NOTIFICATION_TYPES))})`
    ),
    check(
      'notifications_entity_type_check',
      sql`${t.entityType} in (${sql.raw(inList(NOTIFICATION_ENTITY_TYPES))})`
    ),
    unique('notifications_dedup_key').on(t.recipientId, t.actorId, t.type, t.entityId),
    /**
     * The keyset-paginated list: filter on recipient, order by
     * `(created_at DESC, id DESC)` — the same pair the cursor carries, so the
     * index serves the whole page without a sort.
     *
     * It used to be `(recipient_id, id DESC)`, and that was only ever correct
     * while `id DESC` WAS chronological order. It stopped being: `id` is `text`
     * holding a 24-char ObjectId hex before the cutover and a uuid v7 after, and
     * `'0' < '6'` under the database's collation, so ordering on it alone put
     * every post-cutover notification below every pre-cutover one. The `id` half
     * stays as the TIEBREAK, where the collation order does not matter because
     * the ORDER BY and the keyset comparison agree on it — `created_at` defaults
     * to `date_trunc('milliseconds', now())`, so rows written in one millisecond
     * or one transaction share it exactly and something has to break the tie.
     */
    index('notifications_recipient_keyset_idx').on(t.recipientId, t.createdAt.desc(), t.id.desc()),
    // The unread badge.
    index('notifications_recipient_unread_idx')
      .on(t.recipientId, t.createdAt.desc())
      .where(sql`${t.read} = false`),
    // Required by the expiry sweep.
    index('notifications_created_at_idx').on(t.createdAt),
  ]
);

/** `push_tokens` — a device push registration for an Oxy user. */
export const pushTokens = pgTable(
  'push_tokens',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    userId: text().notNull(),
    /**
     * The FCM/APNs device token. Globally unique — one device, one row,
     * whichever account last registered it.
     *
     * Mongoose applied no `trim` here; nothing to re-apply.
     */
    token: text().notNull().unique('push_tokens_token_key'),
    type: text({ enum: PUSH_TOKEN_TYPES }).notNull().default('unknown'),
    platform: text({ enum: PUSH_TOKEN_PLATFORMS }).notNull().default('unknown'),
    /** A device id from the client. Not a row id anywhere — no foreign key. */
    deviceId: text(),
    locale: text(),
    enabled: boolean().notNull().default(true),
    lastSeenAt: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('push_tokens_type_check', sql`${t.type} in (${sql.raw(inList(PUSH_TOKEN_TYPES))})`),
    check(
      'push_tokens_platform_check',
      sql`${t.platform} in (${sql.raw(inList(PUSH_TOKEN_PLATFORMS))})`
    ),
    // The delivery fan-out: this user's enabled tokens.
    index('push_tokens_user_enabled_idx')
      .on(t.userId)
      .where(sql`${t.enabled}`),
  ]
);
