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
  pgTable,
  text,
  unique,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, tsvector, updatedAt } from './columns';

/** `TrendingType`. */
export const TRENDING_TYPES = ['hashtag', 'topic', 'entity'] as const;

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
] as const;

/** `NotificationEntityType`. */
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
    name: text().notNull(),
    description: text().notNull().default(''),
    score: doublePrecision().notNull(),
    volume: integer().notNull().default(0),
    momentum: doublePrecision().notNull().default(0),
    rank: integer().notNull(),
    /** An Oxy Topic-registry id — no foreign key (the registry lives in Oxy). */
    topicId: text(),
    /** The batch stamp. Also the expiry column — see `db/expiry.ts`. */
    calculatedAt: timestamptz().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('trending_type_check', sql`${t.type} in (${sql.raw(inList(TRENDING_TYPES))})`),
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
