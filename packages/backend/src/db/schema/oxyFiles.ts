/**
 * Mention's side of Oxy Files' ownership and usage model (ADR 0043,
 * `docs/oxy-files.md`).
 *
 * Oxy owns the files; Mention says which of them it USES. Every use is an Oxy
 * file reference `(fileId, entityType, entityId)` registered with Mention's
 * service token, and these tables are how those references follow Mention's
 * own data without a write path that can forget one:
 *
 *  - `oxy_file_reference_sync` — the durable outbox. Database TRIGGERS on every
 *    table that stores an Oxy file id (migration 0077) mark a
 *    `(file, entity type, entity)` pair dirty in the writing transaction; the
 *    drain recomputes whether the pair is still in use and tells Oxy.
 *  - `oxy_file_reference_reconciliations` — the nightly reconciliation's run
 *    history, which is also how "is a run due" survives deploys.
 *  - `oxy_file_events` — every file event Oxy sent (the dedupe record and the
 *    audit of what Mention did about it).
 *  - `oxy_file_states` — the last known state of each file an event named, and
 *    whether Mention withholds it.
 *  - `gif_cache_file_retirements` — the GIF library's move out of the
 *    federation media cache: each old cache file still owed a delete.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import { gifs } from './discovery';
import { MEDIA_WITHHELD_REASONS } from './postContent';

/**
 * The kinds of Mention entity that use an Oxy file — the BASE names. The
 * registry in `services/oxyFiles/fileReferenceEntities.ts` says, for each, which
 * table holds the file id, how "in use" is decided and what Oxy entity type it
 * is sent as (`post` is sharded: `post.00` … `post.31`). Documented in
 * `docs/oxy-files.md`.
 */
export const FILE_REFERENCE_ENTITY_TYPES = [
  'post',
  'gif',
  'profile_banner',
  'video_poster',
  'job_application',
  'moderation_report',
] as const;

/** `oxy_file_reference_sync.state`. */
export const FILE_REFERENCE_SYNC_STATES = ['pending', 'synced', 'refused'] as const;

/** What Oxy was last told about a pair. */
export const FILE_REFERENCE_OPS = ['add', 'remove'] as const;

/**
 * How long a settled sync row is kept: the reconciliation replays removals
 * sent while its inventory was being read (see the drain), and an operator
 * reads recent outcomes here. Past this, the row carries no information the
 * source tables do not.
 */
export const FILE_REFERENCE_SYNC_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/**
 * `oxy_file_reference_sync` — the outbox that keeps Oxy's references in step
 * with Mention's data.
 *
 * ## Dirty marks, not commands
 *
 * A row does not say "add" or "remove"; it says "whether entity E uses file F
 * may have changed". The triggers write it (`mention_mark_file_reference`) in
 * the transaction that changed the data — an insert, an edit's delete-and-
 * reinsert, a `ON DELETE CASCADE` three tables away, a script — so no write path
 * can skip it. The drain then asks the CURRENT data whether the pair is in use
 * and sends Oxy the difference from `synced_op`, what Oxy was last told.
 *
 * That shape is what makes it correct under every ordering: an edit that
 * deletes and re-inserts the same media marks the pair twice and sends nothing
 * (still in use, already `add`); a post created and deleted before the drain
 * runs sends a `remove` Oxy answers `not_found`; a mark that lands while the
 * drain is talking to Oxy bumps `generation`, the drain's settle (`where
 * generation = <read>`) misses, and the row is decided again on the next run.
 *
 * ## Lifecycle
 *
 * `pending` → (`synced` | `refused`). `refused` is Oxy's `not_found` to an add:
 * the file does not exist or Mention may not reference it (a person's private
 * file). Any later mark makes the row `pending` again. A settled row expires
 * after {@link FILE_REFERENCE_SYNC_RETENTION_SECONDS}; `expires_at` is NULL
 * while pending, so the expiry sweep never deletes owed work.
 */
export const oxyFileReferenceSync = pgTable(
  'oxy_file_reference_sync',
  {
    fileId: text().notNull(),
    entityType: text({ enum: FILE_REFERENCE_ENTITY_TYPES }).notNull(),
    entityId: text().notNull(),
    state: text({ enum: FILE_REFERENCE_SYNC_STATES }).notNull().default('pending'),
    /** What Oxy holds as of the last answer: `add` (referenced), `remove`, or unknown. */
    syncedOp: text({ enum: FILE_REFERENCE_OPS }),
    /** Bumped by every mark; the drain settles only the generation it read. */
    generation: integer().notNull().default(0),
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamptz().notNull().defaultNow(),
    /** Short, non-sensitive reason of the last failed attempt. */
    lastError: text(),
    /** When Oxy last answered for this pair. */
    syncedAt: timestamptz(),
    /** Set on settle, NULL while pending — the expiry sweep's deadline. */
    expiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: 'oxy_file_reference_sync_pkey',
      columns: [t.fileId, t.entityType, t.entityId],
    }),
    check(
      'oxy_file_reference_sync_entity_type_check',
      sql`${t.entityType} in (${sql.raw(inList(FILE_REFERENCE_ENTITY_TYPES))})`,
    ),
    check(
      'oxy_file_reference_sync_state_check',
      sql`${t.state} in (${sql.raw(inList(FILE_REFERENCE_SYNC_STATES))})`,
    ),
    check(
      'oxy_file_reference_sync_synced_op_check',
      sql`${t.syncedOp} is null or ${t.syncedOp} in (${sql.raw(inList(FILE_REFERENCE_OPS))})`,
    ),
    check('oxy_file_reference_sync_counts_check', sql`${t.attempts} >= 0 and ${t.generation} >= 0`),
    // The drain's claim: due pending rows only.
    index('oxy_file_reference_sync_due_idx').on(t.nextAttemptAt).where(sql`${t.state} = 'pending'`),
    // The reconciliation's replay: removals Oxy answered since a given instant.
    index('oxy_file_reference_sync_removed_idx')
      .on(t.entityType, t.syncedAt)
      .where(sql`${t.syncedOp} = 'remove'`),
    // Required by the expiry sweep.
    index('oxy_file_reference_sync_expires_at_idx').on(t.expiresAt),
  ],
);

/** `oxy_file_reference_reconciliations.mode`. */
export const FILE_REFERENCE_RECONCILE_MODES = ['dry_run', 'apply'] as const;

/** `oxy_file_reference_reconciliations.outcome`. */
export const FILE_REFERENCE_RECONCILE_OUTCOMES = ['running', 'completed', 'failed'] as const;

/** 90 days of nightly runs: enough to compare a dry run with what apply later did. */
export const FILE_REFERENCE_RECONCILIATION_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * `oxy_file_reference_reconciliations` — one row per Oxy entity type per
 * nightly reconciliation (ADR 0043 D6). The run history IS the schedule: the
 * job asks "when did the last run start" every few minutes, so a nightly run
 * still happens on a service that redeploys more often than nightly.
 */
export const oxyFileReferenceReconciliations = pgTable(
  'oxy_file_reference_reconciliations',
  {
    id: generatedId(),
    /** Every entity type reconciled by one run shares it. */
    runId: text().notNull(),
    entityType: text({ enum: FILE_REFERENCE_ENTITY_TYPES }).notNull(),
    /** The name Oxy holds (`post.07`, `gif`). */
    oxyEntityType: text().notNull(),
    mode: text({ enum: FILE_REFERENCE_RECONCILE_MODES }).notNull(),
    outcome: text({ enum: FILE_REFERENCE_RECONCILE_OUTCOMES }).notNull().default('running'),
    /** Pairs sent as the inventory. */
    items: integer(),
    added: integer(),
    removed: integer(),
    unchanged: integer(),
    refused: integer(),
    /** Removals answered during the inventory and re-sent after an applied commit. */
    replayed: integer(),
    error: text(),
    startedAt: timestamptz().notNull().defaultNow(),
    finishedAt: timestamptz(),
  },
  (t) => [
    check(
      'oxy_file_reference_reconciliations_entity_type_check',
      sql`${t.entityType} in (${sql.raw(inList(FILE_REFERENCE_ENTITY_TYPES))})`,
    ),
    check(
      'oxy_file_reference_reconciliations_mode_check',
      sql`${t.mode} in (${sql.raw(inList(FILE_REFERENCE_RECONCILE_MODES))})`,
    ),
    check(
      'oxy_file_reference_reconciliations_outcome_check',
      sql`${t.outcome} in (${sql.raw(inList(FILE_REFERENCE_RECONCILE_OUTCOMES))})`,
    ),
    // The due check (latest start) and the expiry sweep.
    index('oxy_file_reference_reconciliations_started_at_idx').on(t.startedAt),
  ],
);

/**
 * The event types Oxy sends (`FILE_EVENT_TYPES` in `@oxy.so/core/server`,
 * pinned to it in `services/oxyFiles/fileEvents.ts`).
 */
export const OXY_FILE_EVENT_TYPES = [
  'file.deleted',
  'file.visibility_changed',
  'file.trashed',
  'file.restored',
  'file.blocked',
  'file.unblocked',
  'file.lost',
] as const;

/** `FileEvent.file.ownerKind`. */
export const OXY_FILE_OWNER_KINDS = ['account', 'application', 'platform'] as const;

/**
 * A year and a month: a takedown's audit outlives the counter-notice window
 * of any claim process Oxy runs, and a redelivery stops after days.
 */
export const OXY_FILE_EVENT_RETENTION_SECONDS = 400 * 24 * 60 * 60;

/**
 * `oxy_file_events` — every verified file event, keyed by Oxy's event id.
 *
 * Both the dedupe record (delivery is at least once) and the AUDIT of what
 * Mention did: which withholding the event left the file in and how many rows
 * of each kind it changed. Written in the same transaction as those changes.
 */
export const oxyFileEvents = pgTable(
  'oxy_file_events',
  {
    eventId: text().primaryKey(),
    type: text({ enum: OXY_FILE_EVENT_TYPES }).notNull(),
    fileId: text().notNull(),
    ownerKind: text({ enum: OXY_FILE_OWNER_KINDS }).notNull(),
    /** The file's status and visibility AFTER the change, as Oxy reported them. */
    fileStatus: text().notNull(),
    fileVisibility: text().notNull(),
    occurredAt: timestamptz().notNull(),
    /**
     * False when the event was older than one already applied for the file
     * (delivery is not ordered) — recorded, changed nothing.
     */
    applied: boolean().notNull(),
    /** The withholding the file was left in (NULL: served). */
    withheld: text({ enum: MEDIA_WITHHELD_REASONS }),
    /** How many of Mention's references Oxy listed for the file. */
    referencesListed: integer().notNull().default(0),
    /** Post and variant media rows whose `withheld` changed. */
    mediaRowsChanged: integer().notNull().default(0),
    /** GIF library rows removed (their file is gone or taken down). */
    gifsRemoved: integer().notNull().default(0),
    /** Profile banners cleared. */
    bannersCleared: integer().notNull().default(0),
    /** Job-application resumes cleared. */
    resumesCleared: integer().notNull().default(0),
    /** Reference pairs marked to be sent again (Mention's own file in trash). */
    referencesResent: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'oxy_file_events_type_check',
      sql`${t.type} in (${sql.raw(inList(OXY_FILE_EVENT_TYPES))})`,
    ),
    check(
      'oxy_file_events_owner_kind_check',
      sql`${t.ownerKind} in (${sql.raw(inList(OXY_FILE_OWNER_KINDS))})`,
    ),
    check(
      'oxy_file_events_withheld_check',
      sql`${t.withheld} is null or ${t.withheld} in (${sql.raw(inList(MEDIA_WITHHELD_REASONS))})`,
    ),
    index('oxy_file_events_file_id_idx').on(t.fileId),
    // Required by the expiry sweep.
    index('oxy_file_events_created_at_idx').on(t.createdAt),
  ],
);

/** A released file's state is kept this long to order a late redelivery against it. */
export const OXY_FILE_STATE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * `oxy_file_states` — the last state Oxy reported for a file, and whether
 * Mention withholds it.
 *
 * The AUTHORITY for withholding: `post_media.withheld` and
 * `post_variant_media.withheld` are copies of `withheld` here, rewritten by the
 * webhook and copied onto every new media row by trigger. `last_event_at`
 * orders events (an older one changes nothing). A row that withholds nothing
 * expires after {@link OXY_FILE_STATE_RETENTION_SECONDS}; a withholding row
 * never does (`expires_at` NULL), and `deleted` is never released.
 */
export const oxyFileStates = pgTable(
  'oxy_file_states',
  {
    fileId: text().primaryKey(),
    status: text().notNull(),
    visibility: text().notNull(),
    withheld: text({ enum: MEDIA_WITHHELD_REASONS }),
    lastEventId: text().notNull(),
    lastEventAt: timestamptz().notNull(),
    expiresAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'oxy_file_states_withheld_check',
      sql`${t.withheld} is null or ${t.withheld} in (${sql.raw(inList(MEDIA_WITHHELD_REASONS))})`,
    ),
    check('oxy_file_states_expiry_check', sql`${t.withheld} is null or ${t.expiresAt} is null`),
    // Required by the expiry sweep.
    index('oxy_file_states_expires_at_idx').on(t.expiresAt),
  ],
);

/** `gif_cache_file_retirements.state`. */
export const GIF_CACHE_RETIREMENT_STATES = ['pending', 'deleted', 'not_found', 'kept'] as const;

/**
 * `gif_cache_file_retirements` — a GIF library file left behind in Oxy's
 * federation media cache by the move to application-owned files.
 *
 * Written by `scripts/migrateGifLibraryToApplicationFiles.ts` in the transaction
 * that points the `gifs` row and every post at the new application file, so
 * the old id is never forgotten between "nothing uses it" and "it is deleted".
 * The same script deletes it from the cache (`pending` → `deleted` /
 * `not_found`) unless something still uses it (`kept`: a federated media cache
 * entry holding the same bytes, which the cache's own eviction owns).
 *
 * Bounded by the library (two files per GIF at most) and never re-filled, so
 * it does not expire: it is the record of the migration.
 */
export const gifCacheFileRetirements = pgTable(
  'gif_cache_file_retirements',
  {
    oldFileId: text().primaryKey(),
    /** The library row that used it; NULL once that row is gone (a takedown). */
    gifId: text().references(() => gifs.id, { onDelete: 'set null' }),
    newFileId: text().notNull(),
    state: text({ enum: GIF_CACHE_RETIREMENT_STATES }).notNull().default('pending'),
    attempts: integer().notNull().default(0),
    lastError: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'gif_cache_file_retirements_state_check',
      sql`${t.state} in (${sql.raw(inList(GIF_CACHE_RETIREMENT_STATES))})`,
    ),
    check('gif_cache_file_retirements_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
