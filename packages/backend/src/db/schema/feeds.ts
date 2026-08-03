/**
 * The feed layer: `custom_feeds` (+ its composable definition and the three
 * legacy filter arrays), `feed_generators`, `feed_likes`, `feed_reviews`,
 * `feed_interactions`, and the viewer's saved-feed layout.
 *
 * `CustomFeed` is the one model where the migration contract's "no Mongo
 * baggage" and "no relational link may be lost" pull hardest. The document
 * carries BOTH the current composable `definition` subdocument AND seven legacy
 * filter fields the doc comment marks "read-only; consumed only by the migration
 * + the request-time fallback while the backfill has not yet run". Both are
 * ported: the legacy fields are still READ today, so dropping them here would
 * lose data the running code depends on. They are the first thing to delete once
 * `scripts/backfillCustomFeedDefinitions.ts` has completed in production — see
 * the migration report.
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
import { FEED_CATEGORIES } from '@mention/shared-types';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';
import { accountLists } from './lists';

/**
 * `custom_feeds.category` takes `FEED_CATEGORIES` from `@mention/shared-types`,
 * which owns it — see the import above. It is NOT redeclared here.
 *
 * It used to exist as three independent copies (this file,
 * `models/CustomFeed.ts`, and shared-types), identical in every member. That is
 * the PRECONDITION for the `BLOCKLIST_SOURCE_OUTCOMES` defect rather than a
 * mitigation of it: three lists that agree today stay agreeing only while
 * somebody remembers all three exist. The counter-example is one table over —
 * `trending.category` reads the single `TREND_CATEGORIES` constant on BOTH
 * sides and therefore cannot drift at all, with no gate required.
 */

/** `FeedDefinition.mode` — ranked or chronological. */
export const FEED_MODES = ['ranked', 'chronological'] as const;

/** Which of the three module lists a `ModuleRef` belongs to. */
export const FEED_MODULE_KINDS = ['source', 'signal', 'filter'] as const;

/** `FeedInteraction.event`. */
export const FEED_INTERACTION_EVENTS = [
  'impression',
  'click',
  'like',
  'reply',
  'boost',
  'save',
  'report',
] as const;

/** The external networks a feed generator can be mirrored FROM. */
export const FEED_GENERATOR_NETWORKS = ['atproto'] as const;

/**
 * 90 days — the `expireAfterSeconds` on `models/FeedInteraction.ts`. Ranking
 * feedback is a rolling window; nothing reads a year-old impression.
 */
export const FEED_INTERACTION_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/** `FeedReview.rating` bounds, from the Mongoose `min`/`max`. */
/**
 * The review scale, exported because the ROUTE has to enforce it too.
 *
 * `feed_reviews_rating_check` is the floor, not the gate: a value outside the
 * range — or a fractional one, which an `integer` column refuses outright — 500s
 * on a request path. Mongoose declared the same `min`/`max` and never ran them
 * (`runValidators` is set nowhere in this package) and cast whatever it was
 * given, so the port turns a quietly-stored bad value into a visible error.
 * Better, but the honest answer to a malformed body is a 400.
 */
export const RATING_MIN = 1;
export const RATING_MAX = 5;

export const customFeeds = pgTable(
  'custom_feeds',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    ownerOxyUserId: text().notNull(),
    title: text().notNull(),
    description: text(),
    isPublic: boolean().notNull().default(false),
    /** Lucide icon name shown in the feeds screen / builder. */
    icon: text(),
    /**
     * The composable definition's `mode`. NULL means the feed predates Phase 3
     * and the request-time fallback derives a definition from the legacy fields
     * below. `custom_feed_definition_modules` holds the three module lists.
     */
    definitionMode: text({ enum: FEED_MODES }),

    // ── Legacy filter fields. See the module docblock: still read. ──
    keywords: text().array(),
    includeReplies: boolean().notNull().default(true),
    includeBoosts: boolean().notNull().default(true),
    includeMedia: boolean().notNull().default(true),
    language: text(),

    category: text({ enum: FEED_CATEGORIES }),
    tags: text().array(),
    coverImage: text(),
    /** Maintained by the `feed_likes` writer; the rows are the authority. */
    subscriberCount: integer().notNull().default(0),
    /** Maintained from `feed_reviews`; recomputed on every review write. */
    averageRating: doublePrecision().notNull().default(0),
    ratingsCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'custom_feeds_definition_mode_check',
      sql`${t.definitionMode} is null or ${t.definitionMode} in (${sql.raw(inList(FEED_MODES))})`
    ),
    check(
      'custom_feeds_category_check',
      sql`${t.category} is null or ${t.category} in (${sql.raw(inList(FEED_CATEGORIES))})`
    ),
    check('custom_feeds_counts_check', sql`${t.subscriberCount} >= 0 and ${t.ratingsCount} >= 0`),
    check(
      'custom_feeds_average_rating_check',
      sql`${t.averageRating} between 0 and ${sql.raw(String(RATING_MAX))}`
    ),
    index('custom_feeds_owner_chrono_idx').on(t.ownerOxyUserId, t.createdAt.desc()),
    index('custom_feeds_public_chrono_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.isPublic}`),
    // The marketplace's category browse, sorted by popularity.
    index('custom_feeds_marketplace_idx')
      .on(t.category, t.subscriberCount.desc())
      .where(sql`${t.isPublic}`),
  ]
);

/**
 * `custom_feed_definition_modules` — the `sources` / `signals` / `filters`
 * `ModuleRef[]` of a stored definition, flattened into one table with a `kind`
 * discriminator.
 *
 * `params` is the ONE genuinely shape-less value in this schema and is therefore
 * the ONE `jsonb`: a module's parameters are defined by the module, not by the
 * feed engine, so there is no shape to project into columns. Everything else on
 * a `ModuleRef` has a known type and gets a real column.
 */
export const customFeedDefinitionModules = pgTable(
  'custom_feed_definition_modules',
  {
    id: generatedId(),
    feedId: text()
      .notNull()
      .references(() => customFeeds.id, { onDelete: 'cascade' }),
    kind: text({ enum: FEED_MODULE_KINDS }).notNull(),
    /** Preserves the order within its list — module order is evaluation order. */
    position: integer().notNull(),
    /** The registered module id (`engine/types.ts` `ModuleRef.module`). */
    module: text().notNull(),
    enabled: boolean().notNull(),
    /** Module-defined; genuinely shape-less, hence jsonb. */
    params: jsonb(),
    weight: doublePrecision(),
  },
  (t) => [
    check(
      'custom_feed_definition_modules_kind_check',
      sql`${t.kind} in (${sql.raw(inList(FEED_MODULE_KINDS))})`
    ),
    check('custom_feed_definition_modules_position_check', sql`${t.position} >= 0`),
    unique('custom_feed_definition_modules_feed_kind_position_key').on(t.feedId, t.kind, t.position),
  ]
);

/** `custom_feed_members` — the junction replacing `CustomFeed.memberOxyUserIds`. */
export const customFeedMembers = pgTable(
  'custom_feed_members',
  {
    id: generatedId(),
    feedId: text()
      .notNull()
      .references(() => customFeeds.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    position: integer().notNull(),
  },
  (t) => [
    check('custom_feed_members_position_check', sql`${t.position} >= 0`),
    unique('custom_feed_members_feed_id_oxy_user_id_key').on(t.feedId, t.oxyUserId),
    unique('custom_feed_members_feed_id_position_key').on(t.feedId, t.position),
    index('custom_feed_members_oxy_user_id_idx').on(t.oxyUserId),
  ]
);

/**
 * `custom_feed_source_lists` — the junction replacing `CustomFeed.sourceListIds`.
 *
 * This one CAN carry a real foreign key, because `AccountList` is Mention's own
 * model. CASCADE: a feed sourcing a deleted list would silently yield fewer
 * posts with nothing to explain why.
 */
export const customFeedSourceLists = pgTable(
  'custom_feed_source_lists',
  {
    id: generatedId(),
    feedId: text()
      .notNull()
      .references(() => customFeeds.id, { onDelete: 'cascade' }),
    listId: text()
      .notNull()
      .references(() => accountLists.id, { onDelete: 'cascade' }),
  },
  (t) => [
    unique('custom_feed_source_lists_feed_id_list_id_key').on(t.feedId, t.listId),
    index('custom_feed_source_lists_list_id_idx').on(t.listId),
  ]
);

/**
 * `custom_feed_topics` — the junction replacing `CustomFeed.topicIds`.
 *
 * Mongo typed these `Schema.Types.ObjectId, ref: 'Topic'`, but there is no
 * `Topic` collection in Mention's database — the registry lives in Oxy (see the
 * comment on `Post.postClassification.topicRefs`). So the ref was never
 * resolvable and this carries no foreign key.
 */
export const customFeedTopics = pgTable(
  'custom_feed_topics',
  {
    id: generatedId(),
    feedId: text()
      .notNull()
      .references(() => customFeeds.id, { onDelete: 'cascade' }),
    /** An Oxy Topic-registry id — no foreign key. */
    topicId: text().notNull(),
  },
  (t) => [unique('custom_feed_topics_feed_id_topic_id_key').on(t.feedId, t.topicId)]
);

/**
 * `feed_generators` — a third-party / algorithmic feed Mention SERVES.
 *
 * Distinct from a `custom_feed`: the ranking runs on a remote service and
 * Mention pulls the result. Every row today is mirrored from atproto and is
 * read-only through any Mention write API.
 */
export const feedGenerators = pgTable(
  'feed_generators',
  {
    id: generatedId(),
    /** The source AT-URI. Globally unique — the dedup key for re-sync. */
    uri: text().notNull().unique('feed_generators_uri_key'),
    name: text().notNull(),
    description: text(),
    avatar: text(),
    /** The remote algorithm identifier. */
    algorithm: text().notNull(),
    /** An Oxy account id — no foreign key. */
    createdBy: text().notNull(),
    likeCount: integer().notNull().default(0),
    subscriberCount: integer().notNull().default(0),
    /** Set only on generators mirrored from an external network. */
    sourceNetwork: text({ enum: FEED_GENERATOR_NETWORKS }),
    /** The DID of the remote service that RUNS the ranking (`did:web:…`). */
    sourceServiceDid: text(),
    sourceSyncedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'feed_generators_source_network_check',
      sql`${t.sourceNetwork} is null or ${t.sourceNetwork} in (${sql.raw(inList(FEED_GENERATOR_NETWORKS))})`
    ),
    // Same all-or-nothing restoration as `starter_packs.source_*`.
    check(
      'feed_generators_source_complete_check',
      sql`(${t.sourceNetwork} is null and ${t.sourceServiceDid} is null and ${t.sourceSyncedAt} is null)
        or (${t.sourceNetwork} is not null and ${t.sourceServiceDid} is not null and ${t.sourceSyncedAt} is not null)`
    ),
    check(
      'feed_generators_counts_check',
      sql`${t.likeCount} >= 0 and ${t.subscriberCount} >= 0`
    ),
    index('feed_generators_created_by_idx').on(t.createdBy),
  ]
);

/**
 * `feed_likes` — the LIVE feed-subscription mechanism.
 *
 * `AGENTS.md` is explicit that this, not an `EntityFollow` with
 * `entityType: 'feed'`, is what moves `custom_feeds.subscriber_count` and what
 * every feed surface reads.
 */
export const feedLikes = pgTable(
  'feed_likes',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    userId: text().notNull(),
    feedId: text()
      .notNull()
      .references(() => customFeeds.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('feed_likes_user_id_feed_id_key').on(t.userId, t.feedId),
    // The like-count roll-up groups by feed.
    index('feed_likes_feed_id_idx').on(t.feedId),
    // "Feeds I subscribe to" — the marketplace exclusion.
    index('feed_likes_user_id_idx').on(t.userId),
  ]
);

/** `feed_reviews` — one rating + optional text per (feed, reviewer). */
export const feedReviews = pgTable(
  'feed_reviews',
  {
    id: generatedId(),
    feedId: text()
      .notNull()
      .references(() => customFeeds.id, { onDelete: 'cascade' }),
    /** An Oxy account id — no foreign key. */
    reviewerId: text().notNull(),
    rating: integer().notNull(),
    reviewText: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'feed_reviews_rating_check',
      sql`${t.rating} between ${sql.raw(String(RATING_MIN))} and ${sql.raw(String(RATING_MAX))}`
    ),
    unique('feed_reviews_feed_id_reviewer_id_key').on(t.feedId, t.reviewerId),
    index('feed_reviews_reviewer_id_idx').on(t.reviewerId),
  ]
);

/**
 * `feed_interactions` — impressions/clicks/engagement, for ranking feedback.
 *
 * Mongo reaped these with a 90-day TTL index on `createdAt`; the analogue is a
 * registry entry in `db/expiry.ts`, and `created_at` carries the btree the sweep
 * predicate needs.
 *
 * `post_uri` carries a POST ID, not a URL — `FeedInteractionTracker` says so
 * outright ("`postUri` is the local post id (Mongo `_id` string)"). It is
 * client-supplied and validated before use, so it carries no foreign key: a
 * forged value must produce no row rather than a constraint error.
 */
export const feedInteractions = pgTable(
  'feed_interactions',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    userId: text().notNull(),
    /** The feed descriptor the interaction happened on. */
    feedDescriptor: text().notNull(),
    /** A client-supplied post id. Deliberately unconstrained — see the docblock. */
    postUri: text().notNull(),
    event: text({ enum: FEED_INTERACTION_EVENTS }).notNull(),
    durationMs: integer(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'feed_interactions_event_check',
      sql`${t.event} in (${sql.raw(inList(FEED_INTERACTION_EVENTS))})`
    ),
    index('feed_interactions_user_chrono_idx').on(t.userId, t.createdAt.desc()),
    index('feed_interactions_post_event_idx').on(t.postUri, t.event),
    // Required by the expiry sweep: its predicate is a range scan on this column.
    index('feed_interactions_created_at_idx').on(t.createdAt),
  ]
);

/**
 * `user_feed_preferences` — one row per viewer holding their saved-feed layout.
 *
 * The layout itself (`savedFeeds: SavedFeed[]`) becomes `user_saved_feeds`. The
 * parent survives as its own row because it carries the timestamps and is the
 * thing the `PRESET_FEEDS` seeding decides to create.
 */
export const userFeedPreferences = pgTable(
  'user_feed_preferences',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. One row per user. */
    oxyUserId: text().notNull().unique('user_feed_preferences_oxy_user_id_key'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  }
);

/**
 * `user_saved_feeds` — one saved/pinned feed in the viewer's layout.
 *
 * Mongo's subdocument used `_id: false` because "a saved feed is identified by
 * its `key`, not an ObjectId"; the unique `(preference_id, key)` below is that
 * statement as a constraint.
 */
export const userSavedFeeds = pgTable(
  'user_saved_feeds',
  {
    id: generatedId(),
    preferenceId: text()
      .notNull()
      .references(() => userFeedPreferences.id, { onDelete: 'cascade' }),
    /** The stable identity of a saved feed within one user's layout. */
    key: text().notNull(),
    /** The feed descriptor this entry resolves to. */
    descriptor: text().notNull(),
    pinned: boolean().notNull().default(false),
    /** Display order within the layout. */
    order: integer().notNull().default(0),
  },
  (t) => [
    unique('user_saved_feeds_preference_id_key_key').on(t.preferenceId, t.key),
    index('user_saved_feeds_preference_order_idx').on(t.preferenceId, t.order),
  ]
);
