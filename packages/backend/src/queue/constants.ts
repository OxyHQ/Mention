/**
 * Centralized BullMQ queue names + numeric tunables.
 *
 * Every queue name, attempt count, backoff interval, concurrency, and cadence
 * used by the federation queue system is declared here as a named constant — no
 * magic numbers leak into the queue/worker code.
 */

// --- Time helpers -----------------------------------------------------------

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;

// --- Queue names ------------------------------------------------------------

/** Inbound ActivityPub activities awaiting `processInboxActivity`. */
export const FEDERATION_INBOX_QUEUE = 'federation-inbox';

/** Outbound ActivityPub deliveries (signed POST to a remote inbox). */
export const FEDERATION_DELIVERY_QUEUE = 'federation-delivery';

/** Periodic federation maintenance jobs (cron-style repeatable jobs). */
export const FEDERATION_PERIODIC_QUEUE = 'federation-periodic';

// --- Inbox worker tunables --------------------------------------------------

/**
 * Total attempts for an inbound activity (1 initial + retries). Inbound
 * processing is mostly local DB work; a small bounded retry covers transient
 * DB/Redis hiccups without holding poison messages forever.
 */
export const INBOX_JOB_ATTEMPTS = 5;

/** Base delay for the inbox exponential backoff (ms). */
export const INBOX_BACKOFF_BASE_MS = 5 * MS_PER_SECOND;

/** Concurrency for the inbox worker (per process). */
export const INBOX_WORKER_CONCURRENCY = 8;

/** Completed inbox jobs retained for observability before automatic removal. */
export const INBOX_REMOVE_ON_COMPLETE_COUNT = 1000;

/** Failed inbox jobs retained for debugging before automatic removal. */
export const INBOX_REMOVE_ON_FAIL_COUNT = 5000;

// --- Delivery worker tunables -----------------------------------------------

/**
 * Per-attempt delays for outbound delivery retries, in milliseconds.
 *
 * This MIRRORS `FederationDeliveryQueue#getNextRetryTime`'s 6-tier backoff
 * exactly: [1m, 5m, 30m, 2h, 12h, 48h]. With {@link DELIVERY_JOB_ATTEMPTS}
 * (= 7) total attempts, the delays are applied AFTER attempts 1..6 fail, and
 * attempt 7 is the final try (matching the Mongo model giving up once
 * `attempts >= 6`). Indexed by `attemptsMade - 1` in the custom backoff
 * strategy; an out-of-range index returns the last interval as a safe floor
 * (the worker caps attempts so this is never actually reached past tier 6).
 */
export const DELIVERY_BACKOFF_INTERVALS_MS: readonly number[] = [
  1 * MS_PER_MINUTE, // after attempt 1
  5 * MS_PER_MINUTE, // after attempt 2
  30 * MS_PER_MINUTE, // after attempt 3
  2 * MS_PER_HOUR, // after attempt 4
  12 * MS_PER_HOUR, // after attempt 5
  48 * MS_PER_HOUR, // after attempt 6
];

/**
 * Total attempts for an outbound delivery: 1 initial + 6 backoff retries = 7,
 * matching the Mongo model's `BACKOFF_INTERVALS_MS.length` (6) retry tiers
 * before giving up.
 */
export const DELIVERY_JOB_ATTEMPTS = DELIVERY_BACKOFF_INTERVALS_MS.length + 1;

/**
 * Named custom backoff strategy key registered on the delivery Worker's
 * `settings.backoffStrategy`. Referenced by job `opts.backoff.type`.
 */
export const DELIVERY_BACKOFF_STRATEGY = 'federation-delivery';

/** Concurrency for the delivery worker (per process). */
export const DELIVERY_WORKER_CONCURRENCY = 8;

/** Completed delivery jobs retained before automatic removal. */
export const DELIVERY_REMOVE_ON_COMPLETE_COUNT = 1000;

/** Failed delivery jobs retained before automatic removal. */
export const DELIVERY_REMOVE_ON_FAIL_COUNT = 5000;

/** Max `FederationDeliveryQueue` rows drained per page during startup migration. */
export const DELIVERY_DRAIN_PAGE_SIZE = 500;

// --- Periodic job tunables --------------------------------------------------

/**
 * Repeatable-job scheduler ids (stable keys). `upsertJobScheduler` is
 * idempotent per id, so re-registering on every leader election is safe and
 * never produces duplicate schedules.
 */
export const PERIODIC_REFRESH_STALE_ACTORS = 'federation:refresh-stale-actors';
export const PERIODIC_SYNC_FOLLOWED_OUTBOX = 'federation:sync-followed-outbox';
export const PERIODIC_RECENT_OUTBOX_BACKFILL = 'federation:recent-outbox-backfill';
export const PERIODIC_BACKFILL_OXY_USER_IDS = 'federation:backfill-oxy-user-ids';
export const PERIODIC_MEDIA_CACHE_WORKER = 'federation:media-cache-worker';
export const PERIODIC_MEDIA_CACHE_EVICTION = 'federation:media-cache-eviction';

/**
 * Recommendation-signal scheduler ids. These pipe Mention curation + engagement
 * into Oxy's cross-app recommendation graph (see EndorsementSignalService /
 * InterestScoreService). They share the periodic queue + worker but are
 * registered as their own repeatable jobs.
 */
export const PERIODIC_COMPUTE_INTEREST_SCORES = 'recommendations:compute-interest-scores';
export const PERIODIC_FLUSH_ENDORSEMENT_OUTBOX = 'recommendations:flush-endorsement-outbox';

/**
 * Cadences for the repeatable jobs. These reuse the exact intervals the legacy
 * in-process `FederationJobScheduler` used so behavior is unchanged — only the
 * scheduling transport moves to BullMQ. (Media-cache cadences come from
 * `mediaCache/constants.ts` and are passed through by the scheduler, not
 * redefined here.)
 */
export const REFRESH_STALE_ACTORS_INTERVAL_MS = 6 * MS_PER_HOUR;
export const SYNC_FOLLOWED_OUTBOX_INTERVAL_MS = 15 * MS_PER_MINUTE;
export const RECENT_OUTBOX_BACKFILL_INTERVAL_MS = 15 * MS_PER_MINUTE;

/**
 * Cadence for the one-shot-style oxyUserId backfill. The legacy scheduler ran
 * this once at +10s after boot. As a repeatable job it runs hourly; the task
 * itself is a no-op once there is nothing left to backfill (it early-returns on
 * an empty result set), so a slow cadence keeps the safety net without cost.
 */
export const BACKFILL_OXY_USER_IDS_INTERVAL_MS = 1 * MS_PER_HOUR;

/**
 * Interest-score recompute cadence. Engagement aggregation over a 30-day window
 * is a heavyweight scan, and the score is a slow-moving signal, so a 6-hour
 * cadence is plenty fresh while keeping the load light.
 */
export const COMPUTE_INTEREST_SCORES_INTERVAL_MS = 6 * MS_PER_HOUR;

/**
 * Endorsement-outbox drain cadence. Membership mutations attempt an immediate
 * push; this drain is the safety net for rows left pending (Oxy down, transient
 * error), so it runs every 2 minutes to keep the backlog small.
 */
export const FLUSH_ENDORSEMENT_OUTBOX_INTERVAL_MS = 2 * MS_PER_MINUTE;

/** Concurrency for the periodic worker. MUST be 1 so a repeatable job never overlaps itself. */
export const PERIODIC_WORKER_CONCURRENCY = 1;

/** Completed periodic jobs retained before automatic removal. */
export const PERIODIC_REMOVE_ON_COMPLETE_COUNT = 100;

/** Failed periodic jobs retained before automatic removal. */
export const PERIODIC_REMOVE_ON_FAIL_COUNT = 500;
