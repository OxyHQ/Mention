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

/** Ensure engagement indexes and backfill authoritative Bookmark counts (expand-only). */
export const MIGRATION_BOOKMARK_STATS = '0008-bookmark-stats';

/**
 * Build the bounded recent-replier read model and its unique parent-post index.
 * See {@link ./0009-post-recent-repliers}.
 */
export const MIGRATION_POST_RECENT_REPLIERS = '0009-post-recent-repliers';

/**
 * Add exact keyset indexes for public search/feed, author feeds and replies.
 * Existing candidate indexes are retained until production index telemetry has
 * observed them for at least 14 days.
 */
export const MIGRATION_POST_HOT_PATH_INDEXES = '0010-post-hot-path-indexes';

/**
 * Create the claim/reclaim and retention indexes for the durable engagement
 * outbox. Production disables Mongoose auto-indexing, so the deployment
 * migration is the schema authority for these indexes.
 */
export const MIGRATION_ENGAGEMENT_OUTBOX_INDEXES = '0011-engagement-outbox-indexes';

/**
 * Repair pre-index MTN forks without deleting signed envelopes, then install
 * the sequence, repo-head and producer-event uniqueness backstops. This remains
 * separate so an applied outbox migration can never leave the dispatcher
 * active without MTN dedupe and canonical-chain constraints.
 */
export const MIGRATION_MTN_EVENT_IDEMPOTENCY_INDEX =
  '0012-mtn-event-idempotency-index';

/**
 * Widen the `Trending` batch uniqueness key from `{ name, calculatedAt }` to
 * `{ name, calculatedAt, type }`, so a name that trends as BOTH a hashtag and a
 * classified topic stops colliding and killing the whole batch write. Production
 * disables Mongoose auto-indexing, so this migration is the schema authority.
 * See {@link ./0013-trending-name-type-unique-index}.
 */
export const MIGRATION_TRENDING_NAME_TYPE_UNIQUE_INDEX =
  '0013-trending-name-type-unique-index';

/**
 * Create the multikey `trend_terms_idx` on `posts` so trend detection and the
 * `trend|<term>` feed can both reach a term without a collection scan.
 * Production disables Mongoose auto-indexing, so this migration is the schema
 * authority. See {@link ./0014-post-trend-terms-index}.
 */
export const MIGRATION_POST_TREND_TERMS_INDEX = '0014-post-trend-terms-index';

/**
 * Create the `TrendSummary` indexes: the UNIQUE `{term, runStartedAt}` identity
 * that makes on-demand summary generation idempotent, plus the TTL that keeps
 * the collection bounded. Production disables Mongoose auto-indexing, so this
 * migration is the schema authority. See {@link ./0015-trend-summary-indexes}.
 */
export const MIGRATION_TREND_SUMMARY_INDEXES = '0015-trend-summary-indexes';

/**
 * Create the UNIQUE `{script, scope}` identity of an administrative sweep's
 * resume cursor, so one shard scope can only ever have one recorded position.
 * Production disables Mongoose auto-indexing, so this migration is the schema
 * authority. See {@link ./0016-admin-script-cursor-index}.
 */
export const MIGRATION_ADMIN_SCRIPT_CURSOR_INDEX = '0016-admin-script-cursor-index';

/**
 * Create the `RepairFetchFailure` indexes: the UNIQUE `{script, postId}` identity
 * that keeps the re-fetch failure log bounded by distinct failing posts, plus the
 * `{script, reason}` index serving the targeted-retry query it exists for.
 * Production disables Mongoose auto-indexing, so this migration is the schema
 * authority. See {@link ./0017-repair-fetch-failure-indexes}.
 */
export const MIGRATION_REPAIR_FETCH_FAILURE_INDEXES = '0017-repair-fetch-failure-indexes';

/**
 * Create the `BlockedDomainPurge` ledger indexes: the UNIQUE `{domain}` identity
 * the policy reconciliation addresses one row by, plus the `{state, claimedAt}`
 * index its stale-claim re-arm sweep reads. Production disables Mongoose
 * auto-indexing, so this migration is the schema authority.
 * See {@link ./0018-blocked-domain-purge-indexes}.
 */
export const MIGRATION_BLOCKED_DOMAIN_PURGE_INDEXES = '0018-blocked-domain-purge-indexes';

/**
 * Create the `BlockedDomainPurgeRun` history indexes: the UNIQUE
 * `{domain, runId}` identity that stops a retried or resumed run appending a
 * duplicate row and inflating a per-domain total, plus `{domain, runAt}` serving
 * both queries a transparency surface needs (latest run, and every run to sum).
 * Production disables Mongoose auto-indexing, so this migration is the schema
 * authority. See {@link ./0019-blocked-domain-purge-run-indexes}.
 */
export const MIGRATION_BLOCKED_DOMAIN_PURGE_RUN_INDEXES = '0019-blocked-domain-purge-run-indexes';

/**
 * Create the `BlocklistProposal` review-queue indexes: the UNIQUE `{domain}`
 * identity that keeps one row per domain — and with it the second defence that
 * stops a DECLINED domain being resurrected by a concurrent sweep — plus
 * `{status, firstProposedAt}` serving the queue itself, oldest unanswered first.
 * Production disables Mongoose auto-indexing, so this migration is the schema
 * authority. See {@link ./0020-blocklist-proposal-indexes}.
 */
export const MIGRATION_BLOCKLIST_PROPOSAL_INDEXES = '0020-blocklist-proposal-indexes';

/**
 * Create the `BlocklistProposalRun` history indexes: the UNIQUE `{runId}`
 * identity, plus `{startedAt}` — the scheduler's only query, and what makes a
 * weekly sweep survive a service that restarts far more often than weekly.
 * Production disables Mongoose auto-indexing, so this migration is the schema
 * authority. See {@link ./0021-blocklist-proposal-run-indexes}.
 */
export const MIGRATION_BLOCKLIST_PROPOSAL_RUN_INDEXES = '0021-blocklist-proposal-run-indexes';
