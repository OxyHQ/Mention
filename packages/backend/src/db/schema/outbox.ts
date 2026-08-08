/**
 * `engagement_outbox` and `endorsement_outbox` — the two durable work queues
 * that are not federation delivery.
 *
 * Both keep the lease-based claim shape Mongo used: a worker CLAIMS a row by
 * setting `lease_owner` + `lease_until`, and an expired lease is reclaimable, so
 * every consumer must be idempotent on the row's id. That is stated in
 * `EngagementOutbox`'s own docblock ("consumers must therefore use `_id` as
 * their idempotency key") and it survives the port unchanged.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';
import { posts } from './posts';

/** `EngagementOutboxKind`. */
export const ENGAGEMENT_OUTBOX_KINDS = [
  'post.like',
  'post.unlike',
  'post.downvote',
  'post.undownvote',
  'post.save',
  'post.unsave',
] as const;

/** `EngagementOutboxStatus`. */
export const ENGAGEMENT_OUTBOX_STATUSES = ['pending', 'processing', 'processed'] as const;

/**
 * 30 days. A hard ceiling so a stalled dispatcher cannot turn the outbox into an
 * unbounded table. See the WARNING on this table's entry in `db/expiry.ts`: the
 * sweep deletes by deadline regardless of status, so operational alerting has to
 * fire long before it.
 */
export const ENGAGEMENT_OUTBOX_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** `EndorsementSource` — which membership model a scope belongs to. */
export const ENDORSEMENT_SOURCES = ['starterPack', 'accountList'] as const;

/** `EndorsementOutboxStatus`. */
export const ENDORSEMENT_OUTBOX_STATUSES = ['pending', 'sent'] as const;

/**
 * `engagement_outbox` — durable domain events emitted by engagement commands.
 *
 * `id` is caller-supplied and deterministic (derived from the relationship id
 * plus the revision), which is what makes a retry re-derive the same row rather
 * than mint a second event. Hence `text().primaryKey()` with no generator.
 *
 * ## The payload is COLUMNS, not jsonb
 *
 * Mongo declared `payload` as a nested object with eight named leaves — a known
 * shape, so it becomes columns. The one exception is `postAuthorship`, which
 * Mongo typed `[Schema.Types.Mixed]`: it is a SNAPSHOT of the post's authorship
 * at emit time, carried so a downstream consumer does not have to re-read a post
 * that may have changed. It is reconstructible from `post_authorships`, so it is
 * DROPPED rather than ported as jsonb — the consumer reads the rows. That is a
 * deliberate removal of Mongo baggage and it needs the query phase to make the
 * corresponding read; it is called out in the migration report.
 */
export const engagementOutbox = pgTable(
  'engagement_outbox',
  {
    /** Caller-supplied and deterministic — see the docblock. */
    id: text().primaryKey(),
    kind: text({ enum: ENGAGEMENT_OUTBOX_KINDS }).notNull(),
    /** Monotonic per-relationship revision; the dispatcher orders on it. */
    revision: integer().notNull(),

    /** An Oxy account id — no foreign key. */
    payloadActorOxyUserId: text().notNull(),
    /**
     * CASCADE: an event about a deleted post has nothing left to do. Mongo left
     * these behind and the dispatcher discovered the missing post at claim time.
     */
    payloadPostId: text()
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** The `likes.id` / `bookmarks.id` this transition is about. */
    payloadRelationshipId: text().notNull(),
    /** An Oxy account id — no foreign key. */
    payloadPostOwnerOxyUserId: text(),
    /** The AP activity id to Undo, for a federated engagement. */
    payloadFederationActivityId: text(),
    /** The vote value before/after the transition (`1`, `-1`, or absent). */
    payloadPreviousValue: integer(),
    payloadValue: integer(),

    status: text({ enum: ENGAGEMENT_OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull().defaultNow(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    /** Retention ceiling, swept by `db/expiry.ts`. */
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'engagement_outbox_kind_check',
      sql`${t.kind} in (${sql.raw(inList(ENGAGEMENT_OUTBOX_KINDS))})`
    ),
    check(
      'engagement_outbox_status_check',
      sql`${t.status} in (${sql.raw(inList(ENGAGEMENT_OUTBOX_STATUSES))})`
    ),
    check('engagement_outbox_revision_check', sql`${t.revision} >= 1`),
    check('engagement_outbox_attempts_check', sql`${t.attempts} >= 0`),
    check(
      'engagement_outbox_values_check',
      sql`(${t.payloadPreviousValue} is null or ${t.payloadPreviousValue} in (1, -1))
        and (${t.payloadValue} is null or ${t.payloadValue} in (1, -1))`
    ),
    // Pending work and expired claims are separate bounded scans.
    index('engagement_outbox_due_idx').on(t.status, t.availableAt, t.createdAt),
    index('engagement_outbox_lease_idx').on(t.status, t.leaseUntil, t.createdAt),
    // The dispatcher checks for a LOWER unprocessed revision after claiming, so
    // two workers cannot apply one relationship's transitions out of order.
    index('engagement_outbox_relationship_order_idx').on(
      t.payloadRelationshipId,
      t.revision,
      t.status
    ),
    // Required by the expiry sweep.
    index('engagement_outbox_expires_at_idx').on(t.expiresAt),
  ]
);

/**
 * `endorsement_outbox` — desired-state pushes of endorsement signals to Oxy.
 *
 * At most ONE row per `(source, source_id)`: a new mutation on an already-pending
 * scope upserts and re-arms the same row rather than queuing duplicates. Because
 * the normal path is DESIRED-STATE, an exhausted row is harmless to re-arm and
 * the backoff schedule clamps rather than dropping.
 *
 * `pending_remove_member_ids` stays a `text[]`: it is a transient batch attached
 * to one retry, read whole and cleared whole, never joined.
 */
export const endorsementOutbox = pgTable(
  'endorsement_outbox',
  {
    id: generatedId(),
    source: text({ enum: ENDORSEMENT_SOURCES }).notNull(),
    /** A `starter_packs.id` or `account_lists.id`, by `source`. Polymorphic. */
    sourceId: text().notNull(),
    status: text({ enum: ENDORSEMENT_OUTBOX_STATUSES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    /** The backoff gate: earliest time the next attempt may run. */
    nextAttemptAt: timestamptz().notNull().defaultNow(),
    lastAttemptAt: timestamptz(),
    error: text(),
    /** Owner captured before members were pruned, for the removal edges. */
    pendingRemoveOwnerId: text(),
    /** Removed members that must be retracted before the row counts as sent. */
    pendingRemoveMemberIds: text().array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'endorsement_outbox_source_check',
      sql`${t.source} in (${sql.raw(inList(ENDORSEMENT_SOURCES))})`
    ),
    check(
      'endorsement_outbox_status_check',
      sql`${t.status} in (${sql.raw(inList(ENDORSEMENT_OUTBOX_STATUSES))})`
    ),
    check('endorsement_outbox_attempts_check', sql`${t.attempts} >= 0`),
    // One row per scope — the upsert target.
    unique('endorsement_outbox_source_source_id_key').on(t.source, t.sourceId),
    // The drain query: pending rows due for an attempt, oldest first.
    index('endorsement_outbox_drain_idx').on(t.status, t.nextAttemptAt),
  ]
);
