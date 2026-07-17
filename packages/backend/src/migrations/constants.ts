/**
 * Migration constants.
 *
 * Each migration is identified by a stable, human-readable id. Applied
 * migration ids are recorded in the `migrations` collection so that the
 * runner is idempotent across restarts and redeploys.
 */

/** Name of the collection that records applied migration ids. */
export const MIGRATIONS_COLLECTION = 'migrations';

/**
 * One-shot rename of the "repost" concept to "boost" across all collections.
 * See {@link ./0001-repost-to-boost} for the exact operations performed.
 */
export const MIGRATION_REPOST_TO_BOOST = '0001-repost-to-boost';

/**
 * One-shot backfill that lowercases (and de-duplicates) every element of each
 * post's `hashtags` array so stored tags are canonical lowercase, matching the
 * case-insensitive read paths. See {@link ./0002-lowercase-hashtags} for the
 * exact operations performed.
 */
export const MIGRATION_LOWERCASE_HASHTAGS = '0002-lowercase-hashtags';

/**
 * One-shot conversion of the `Trending.calculatedAt` single-field index into a
 * TTL index so the (append-only, every-30-min) trending collection stays
 * bounded. `autoIndex`/`autoCreate` are OFF in production, so the schema-
 * declared TTL index is created here. See {@link ./0003-trending-ttl-index}.
 */
export const MIGRATION_TRENDING_TTL_INDEX = '0003-trending-ttl-index';

/**
 * One-shot creation of the notification bounding indexes: a TTL index on
 * `createdAt` (so the append-only `notifications` collection stays bounded) and
 * a `{ recipientId: 1, _id: -1 }` keyset index (so the paginated list query is
 * fully index-served). `autoIndex`/`autoCreate` are OFF in production, so the
 * schema-declared indexes are created here. See {@link ./0004-notification-ttl-index}.
 */
export const MIGRATION_NOTIFICATION_TTL_INDEX = '0004-notification-ttl-index';

/**
 * One-shot creation of the multikey `{ memberOxyUserIds: 1, useCount: -1 }` index
 * on `starterpacks`, which serves the starter-pack curation aggregation
 * (`services/starterPackCuration.ts`) run on every user-summary cache-fill batch.
 * `autoIndex`/`autoCreate` are OFF in production, so the schema-declared index is
 * created here — without it that aggregation collection-scans.
 * See {@link ./0005-starter-pack-member-index}.
 */
export const MIGRATION_STARTER_PACK_MEMBER_INDEX = '0005-starter-pack-member-index';

/**
 * One-shot creation of the SPARSE UNIQUE `{ 'source.uri': 1 }` dedup index on
 * `starterpacks` (one Mention pack per mirrored remote pack) for the Bluesky
 * (atproto) profile-graph import. `autoIndex`/`autoCreate` are OFF in production, so
 * the schema-declared index is created here — without it, re-sync would DUPLICATE
 * mirrored packs. See {@link ./0006-federated-starter-pack-source-index}.
 */
export const MIGRATION_FEDERATED_STARTER_PACK_SOURCE_INDEX = '0006-federated-starter-pack-source-index';

/**
 * One-shot creation of the native `FeedGenerator` indexes: UNIQUE `{ uri: 1 }` (the
 * dedup key for a mirrored Bluesky feed generator) + `{ createdBy: 1 }` (the
 * per-owner listing on the profile Feeds surface). `autoIndex`/`autoCreate` are OFF
 * in production, so the schema-declared indexes are created here — without the
 * unique index, re-syncing an actor's feeds would DUPLICATE them on every profile
 * view. See {@link ./0007-feed-generator-index}.
 */
export const MIGRATION_FEED_GENERATOR_INDEX = '0007-feed-generator-index';
