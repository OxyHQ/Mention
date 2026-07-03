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
