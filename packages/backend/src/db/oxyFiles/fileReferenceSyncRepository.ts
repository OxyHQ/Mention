import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import {
  FILE_REFERENCE_SYNC_RETENTION_SECONDS,
  oxyFileReferenceSync,
  type FILE_REFERENCE_ENTITY_TYPES,
} from '../schema/oxyFiles';

/**
 * Reads and writes of `oxy_file_reference_sync` — the reference outbox. See the
 * table's docblock for the model (dirty marks, `generation`, `synced_op`).
 */

type EntityType = (typeof FILE_REFERENCE_ENTITY_TYPES)[number];

/** A pair as the outbox keys it. */
export interface FileReferenceKey {
  fileId: string;
  entityType: EntityType;
  entityId: string;
}

/** A due row, with what the settle must match. */
export interface DueFileReference extends FileReferenceKey {
  generation: number;
  syncedOp: 'add' | 'remove' | null;
  attempts: number;
}

/**
 * Mark pairs dirty from application code, through the SAME function the
 * triggers call (`mention_mark_file_reference`, migration 0075), so the
 * ignore rule and the re-arm rule cannot differ between the two.
 */
export async function markFileReferences(
  keys: readonly FileReferenceKey[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (keys.length === 0) return;
  await db.execute(sql`
    select mention_mark_file_reference(t.file_id, t.entity_type, t.entity_id)
    from unnest(
      ${sql.param(keys.map((key) => key.fileId))}::text[],
      ${sql.param(keys.map((key) => key.entityType))}::text[],
      ${sql.param(keys.map((key) => key.entityId))}::text[]
    ) as t(file_id, entity_type, entity_id)
  `);
}

/** Pending rows whose attempt is due, oldest first. */
export async function findDueFileReferences(
  limit: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<DueFileReference[]> {
  const rows = await db
    .select({
      fileId: oxyFileReferenceSync.fileId,
      entityType: oxyFileReferenceSync.entityType,
      entityId: oxyFileReferenceSync.entityId,
      generation: oxyFileReferenceSync.generation,
      syncedOp: oxyFileReferenceSync.syncedOp,
      attempts: oxyFileReferenceSync.attempts,
    })
    .from(oxyFileReferenceSync)
    .where(
      and(
        eq(oxyFileReferenceSync.state, 'pending'),
        lte(oxyFileReferenceSync.nextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(asc(oxyFileReferenceSync.nextAttemptAt))
    .limit(limit);
  return rows;
}

/**
 * Every row of these files that may still hold — or be about to send — an Oxy
 * reference: pending, refused, or last told `add`. What the federated deletion
 * drain must settle to `remove` before asking Oxy to delete a file.
 */
export async function findLiveFileReferencesOfFiles(
  fileIds: readonly string[],
  db: DatabaseOrTransaction = getDb(),
): Promise<FileReferenceKey[]> {
  if (fileIds.length === 0) return [];
  return db
    .select({
      fileId: oxyFileReferenceSync.fileId,
      entityType: oxyFileReferenceSync.entityType,
      entityId: oxyFileReferenceSync.entityId,
    })
    .from(oxyFileReferenceSync)
    .where(
      and(
        inArray(oxyFileReferenceSync.fileId, [...fileIds]),
        sql`(${oxyFileReferenceSync.state} <> 'synced' or ${oxyFileReferenceSync.syncedOp} is distinct from 'remove')`,
      ),
    );
}

/** These keys' rows, as the drain needs them, regardless of due time. */
export async function findFileReferences(
  keys: readonly FileReferenceKey[],
  db: DatabaseOrTransaction = getDb(),
): Promise<DueFileReference[]> {
  if (keys.length === 0) return [];
  const rows = await db.execute<{
    file_id: string;
    entity_type: EntityType;
    entity_id: string;
    generation: number;
    synced_op: 'add' | 'remove' | null;
    attempts: number;
  }>(sql`
    select s.file_id, s.entity_type, s.entity_id, s.generation, s.synced_op, s.attempts
    from ${oxyFileReferenceSync} s
    join unnest(
      ${sql.param(keys.map((key) => key.fileId))}::text[],
      ${sql.param(keys.map((key) => key.entityType))}::text[],
      ${sql.param(keys.map((key) => key.entityId))}::text[]
    ) as k(file_id, entity_type, entity_id)
      on k.file_id = s.file_id and k.entity_type = s.entity_type and k.entity_id = s.entity_id
  `);
  return [...rows].map((row) => ({
    fileId: row.file_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    generation: Number(row.generation),
    syncedOp: row.synced_op,
    attempts: Number(row.attempts),
  }));
}

/**
 * Forget what Oxy was told about these files' pairs and mark them dirty, so
 * the next sync SENDS each pair's current state instead of trusting
 * `synced_op`. For a moment that must be certain — a delete about to be asked
 * for, or a file Oxy says it is collecting while Mention still uses it.
 */
export async function forceResendFileReferences(
  keys: readonly FileReferenceKey[],
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (keys.length === 0) return;
  await markFileReferences(keys, db);
  await db.execute(sql`
    update ${oxyFileReferenceSync} s set synced_op = null
    from unnest(
      ${sql.param(keys.map((key) => key.fileId))}::text[],
      ${sql.param(keys.map((key) => key.entityType))}::text[],
      ${sql.param(keys.map((key) => key.entityId))}::text[]
    ) as k(file_id, entity_type, entity_id)
    where k.file_id = s.file_id and k.entity_type = s.entity_type and k.entity_id = s.entity_id
  `);
}

/** One decided row: what Oxy now holds for it. */
export interface SettledFileReference extends FileReferenceKey {
  generation: number;
  /** `refused`: Oxy would not hold the reference (its `not_found` to an add). */
  outcome: 'add' | 'remove' | 'refused';
}

/**
 * Record decided rows — each ONLY if no mark landed since it was read
 * (`generation` unchanged); a re-marked row stays pending and is decided again.
 * Returns how many settled.
 */
export async function settleFileReferences(
  settled: readonly SettledFileReference[],
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  if (settled.length === 0) return 0;
  const result = await db.execute<{ file_id: string }>(sql`
    update ${oxyFileReferenceSync} s set
      state = case when k.outcome = 'refused' then 'refused' else 'synced' end,
      synced_op = case when k.outcome = 'refused' then null else k.outcome end,
      attempts = 0,
      last_error = null,
      synced_at = now(),
      expires_at = now() + (${FILE_REFERENCE_SYNC_RETENTION_SECONDS} * interval '1 second'),
      updated_at = date_trunc('milliseconds', now())
    from unnest(
      ${sql.param(settled.map((row) => row.fileId))}::text[],
      ${sql.param(settled.map((row) => row.entityType))}::text[],
      ${sql.param(settled.map((row) => row.entityId))}::text[],
      ${sql.param(settled.map((row) => row.generation))}::int[],
      ${sql.param(settled.map((row) => row.outcome))}::text[]
    ) as k(file_id, entity_type, entity_id, generation, outcome)
    where k.file_id = s.file_id and k.entity_type = s.entity_type and k.entity_id = s.entity_id
      and s.generation = k.generation
      and s.state = 'pending'
    returning s.file_id
  `);
  return [...result].length;
}

/** The attempt failed for a reason that may pass: try these again after `delayMs`. */
export async function retryFileReferences(
  keys: readonly FileReferenceKey[],
  delayMs: number,
  reason: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<void> {
  if (keys.length === 0) return;
  await db.execute(sql`
    update ${oxyFileReferenceSync} s set
      attempts = s.attempts + 1,
      next_attempt_at = now() + (${delayMs} * interval '1 millisecond'),
      last_error = ${reason.slice(0, 200)},
      updated_at = date_trunc('milliseconds', now())
    from unnest(
      ${sql.param(keys.map((key) => key.fileId))}::text[],
      ${sql.param(keys.map((key) => key.entityType))}::text[],
      ${sql.param(keys.map((key) => key.entityId))}::text[]
    ) as k(file_id, entity_type, entity_id)
    where k.file_id = s.file_id and k.entity_type = s.entity_type and k.entity_id = s.entity_id
      and s.state = 'pending'
  `);
}

/**
 * The reconciliation's replay: pairs of `entityType` (in one shard, when
 * `shardFilter` is given) whose REMOVAL Oxy answered at or after `since`.
 * A reconciliation commit re-adds every pair its inventory listed, and a pair
 * removed while the inventory was being read was listed, so each of these is
 * sent again (see `fileReferenceReconciliation.ts`).
 */
export async function findRemovalsAnsweredSince(
  entityType: EntityType,
  since: Date,
  shardFilter: ReturnType<typeof sql> | null,
  db: DatabaseOrTransaction = getDb(),
): Promise<FileReferenceKey[]> {
  const rows = await db
    .select({
      fileId: oxyFileReferenceSync.fileId,
      entityType: oxyFileReferenceSync.entityType,
      entityId: oxyFileReferenceSync.entityId,
    })
    .from(oxyFileReferenceSync)
    .where(
      and(
        eq(oxyFileReferenceSync.entityType, entityType),
        eq(oxyFileReferenceSync.syncedOp, 'remove'),
        sql`${oxyFileReferenceSync.syncedAt} >= ${since.toISOString()}::timestamptz`,
        ...(shardFilter ? [shardFilter] : []),
      ),
    );
  return rows;
}

/** Pending rows whose attempts reached `threshold`: references Oxy keeps failing to take. */
export async function countStuckFileReferences(
  threshold: number,
  db: DatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db.execute<{ stuck: number }>(sql`
    select count(*)::int as stuck from ${oxyFileReferenceSync}
    where ${oxyFileReferenceSync.state} = 'pending'
      and ${oxyFileReferenceSync.attempts} >= ${threshold}
  `);
  return Number(row?.stuck ?? 0);
}
