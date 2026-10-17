import { randomUUID } from 'node:crypto';
import type { ServiceReferenceReconcileResult } from '@oxy.so/core';
import { desc, eq, sql } from 'drizzle-orm';
import { config } from '../../config';
import {
  databaseNow,
  rearmInUseFederatedMediaDeletions,
} from '../../db/federation/mediaDeletionRepository';
import {
  FILE_REFERENCE_ENTITIES,
  OXY_RECONCILE_MAX_ITEMS,
  oxyEntityTypeName,
  shardSql,
  type FileReferenceEntity,
  type FileReferencePair,
} from '../../db/oxyFiles/fileReferenceEntities';
import {
  findRemovalsAnsweredSince,
  forceResendFileReferences,
} from '../../db/oxyFiles/fileReferenceSyncRepository';
import { getDb } from '../../db/postgres';
import { oxyFileReferenceReconciliations, oxyFileReferenceSync } from '../../db/schema/oxyFiles';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { describeOxyError, oxyErrorStatus } from './oxyErrors';

/**
 * The nightly reference reconciliation (ADR 0043 D6) — the safety net under the
 * reference drain, and how Mention's existing data first enters Oxy's model.
 *
 * For every Oxy entity type Mention registers (`post.00` … `post.31`, `gif`,
 * `profile_banner`, `video_poster`, `job_application`), the registry's
 * inventory — every pair in use now — is sent to Oxy as the whole truth: Oxy adds
 * what it lacks and removes what it holds that the inventory does not list
 * (only references created before the session began, so the drain's concurrent
 * writes are never undone), and reports the counts.
 *
 * `OXY_FILE_REFERENCE_RECONCILE_MODE`: `dry_run` (the default and first
 * deployment) commits nothing and records what WOULD change; `apply` commits;
 * `off` skips the run.
 *
 * ## The one race a commit has, and how it is closed
 *
 * The inventory is read at T1 and committed at T4. A pair in use at T1 whose
 * use ended at T2 was removed by the drain at T3 — and is then RE-ADDED by the
 * commit, because the inventory listed it. Left alone, that stale reference
 * would keep an application file from being collected, and make Oxy answer
 * `in_use` to the deletion of a re-hosted federated file. So after an applied
 * commit, every removal Oxy answered at or after T1 for that entity type (and
 * shard) is sent again, and any federated deletion Oxy kept as `in_use` for
 * those files is re-opened to be asked again.
 *
 * ## Oxy's request budget
 *
 * Every reconciliation request — begin, each page, commit, release — counts
 * toward Oxy's 240 a minute per application (`rl:asset-app:reconcile:`), and a
 * 429 past it fails the entity type. The SDK sends a session's pages back to
 * back and retries no 4xx, and the post shards alone are hundreds of pages, so
 * the inventory is handed to it as a paced stream ({@link pacedInventory}: one
 * pause between pages, at most ~120 pages a minute), and an entity type Oxy
 * still answers 429 is tried again once its one-minute window has passed.
 */

export type ReconcileMode = 'dry_run' | 'apply';

/** Items per reconciliation page — the SDK's `SERVICE_RECONCILE_PAGE_SIZE`. */
export const RECONCILE_PAGE_ITEMS = 1000;
/** The pause between two pages of one session: keeps a run near half of Oxy's 240/min. */
export const RECONCILE_PAGE_PAUSE_MS = 500;
/** On a 429, how long to wait before trying the entity type again: Oxy's window is one minute. */
export const RECONCILE_RATE_LIMIT_WAIT_MS = 61_000;
/** Attempts per entity type when Oxy answers 429. */
export const RECONCILE_RATE_LIMIT_ATTEMPTS = 4;

export interface ReconcileOptions {
  /** Waits between pages and after a 429; injectable so tests do not sleep. */
  pause?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The inventory as the SDK reads it, with a pause before every page after the
 * first: the SDK flushes a page as its 1000th item arrives, so the pause sits
 * between two page requests.
 */
export async function* pacedInventory(
  items: readonly FileReferencePair[],
  pause: (ms: number) => Promise<void>,
): AsyncGenerator<FileReferencePair> {
  for (let index = 0; index < items.length; index += 1) {
    if (index > 0 && index % RECONCILE_PAGE_ITEMS === 0) await pause(RECONCILE_PAGE_PAUSE_MS);
    yield items[index];
  }
}

export interface ReconciledEntityType {
  oxyEntityType: string;
  ok: boolean;
  items?: number;
  added?: number;
  removed?: number;
  unchanged?: number;
  refused?: number;
  replayed?: number;
  error?: string;
}

export interface FileReferenceReconciliationResult {
  runId: string;
  mode: ReconcileMode;
  entityTypes: ReconciledEntityType[];
}

/** Reconcile one Oxy entity type: one shard of one registry entry. Never throws. */
async function reconcileOne(
  runId: string,
  mode: ReconcileMode,
  entity: FileReferenceEntity,
  shard: number,
  pause: (ms: number) => Promise<void>,
): Promise<ReconciledEntityType> {
  const oxyEntityType = oxyEntityTypeName(entity, shard);
  const [record] = await getDb()
    .insert(oxyFileReferenceReconciliations)
    .values({ runId, entityType: entity.type, oxyEntityType, mode })
    .returning({ id: oxyFileReferenceReconciliations.id });

  try {
    // T1: the instant removals are replayed from (see the module docblock).
    // The DATABASE clock, because `synced_at` is written by the database.
    const inventoryReadAt = await databaseNow();
    const items = await entity.inventory(getDb(), shard);
    if (items.length > OXY_RECONCILE_MAX_ITEMS) {
      throw new Error(
        `${oxyEntityType} holds ${items.length} pairs, over Oxy's ${OXY_RECONCILE_MAX_ITEMS} per ` +
          'reconciliation: raise its shard count (db/oxyFiles/fileReferenceEntities.ts)',
      );
    }

    // A retry after a 429 sends the same inventory; T1 stays the first read's,
    // which only widens the removals replayed below.
    let result: ServiceReferenceReconcileResult;
    for (let attempt = 1; ; attempt += 1) {
      try {
        result = await getServiceOxyClient().assets.references.reconcile(
          oxyEntityType,
          pacedInventory(items, pause),
          { dryRun: mode === 'dry_run' },
        );
        break;
      } catch (error) {
        if (oxyErrorStatus(error) !== 429 || attempt >= RECONCILE_RATE_LIMIT_ATTEMPTS) throw error;
        logger.warn('[FileReferences] Oxy rate-limited a reconciliation; trying again', {
          oxyEntityType,
          attempt,
        });
        await pause(RECONCILE_RATE_LIMIT_WAIT_MS);
      }
    }

    let replayed = 0;
    if (mode === 'apply') {
      const shardFilter =
        entity.shards > 1
          ? sql`${shardSql(sql`${oxyFileReferenceSync.entityId}`, entity.shards)} = ${shard}`
          : null;
      const removals = await findRemovalsAnsweredSince(entity.type, inventoryReadAt, shardFilter);
      await forceResendFileReferences(removals);
      await rearmInUseFederatedMediaDeletions([...new Set(removals.map((row) => row.fileId))]);
      replayed = removals.length;
    }

    await getDb()
      .update(oxyFileReferenceReconciliations)
      .set({
        outcome: 'completed',
        items: items.length,
        added: result.added,
        removed: result.removed,
        unchanged: result.unchanged,
        refused: result.refused,
        replayed,
        finishedAt: new Date(),
      })
      .where(eq(oxyFileReferenceReconciliations.id, record.id));
    return {
      oxyEntityType,
      ok: true,
      items: items.length,
      added: result.added,
      removed: result.removed,
      unchanged: result.unchanged,
      refused: result.refused,
      replayed,
    };
  } catch (error) {
    const reason = describeOxyError(error);
    await getDb()
      .update(oxyFileReferenceReconciliations)
      .set({ outcome: 'failed', error: reason.slice(0, 500), finishedAt: new Date() })
      .where(eq(oxyFileReferenceReconciliations.id, record.id))
      .catch(() => undefined);
    return { oxyEntityType, ok: false, error: reason };
  }
}

/**
 * Reconcile every Oxy entity type, one after another (Oxy holds one session
 * per entity type; a failure of one is recorded and the rest still run).
 */
export async function runFileReferenceReconciliation(
  mode: ReconcileMode,
  { pause = sleep }: ReconcileOptions = {},
): Promise<FileReferenceReconciliationResult> {
  const runId = randomUUID();
  const entityTypes: ReconciledEntityType[] = [];
  for (const entity of FILE_REFERENCE_ENTITIES) {
    for (let shard = 0; shard < Math.max(1, entity.shards); shard += 1) {
      entityTypes.push(await reconcileOne(runId, mode, entity, shard, pause));
    }
  }
  return { runId, mode, entityTypes };
}

/** When the latest reconciliation started, or null. */
export async function latestReconciliationStartedAt(): Promise<Date | null> {
  const [row] = await getDb()
    .select({ startedAt: oxyFileReferenceReconciliations.startedAt })
    .from(oxyFileReferenceReconciliations)
    .orderBy(desc(oxyFileReferenceReconciliations.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

/** How often the scheduler asks whether a run is due. */
const DUE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
/** A run is due when none started in this long — under a day, so it holds its night. */
export const RECONCILE_MIN_GAP_MS = 20 * 60 * 60 * 1000;
/** The night: runs start between these UTC hours (inclusive start, exclusive end). */
export const RECONCILE_WINDOW_START_HOUR_UTC = 2;
export const RECONCILE_WINDOW_END_HOUR_UTC = 6;

/** Whether a run is due at `now`, given when the last one started. Exported for tests. */
export function isReconciliationDue(now: Date, latestStartedAt: Date | null): boolean {
  const hour = now.getUTCHours();
  if (hour < RECONCILE_WINDOW_START_HOUR_UTC || hour >= RECONCILE_WINDOW_END_HOUR_UTC) return false;
  return !latestStartedAt || now.getTime() - latestStartedAt.getTime() >= RECONCILE_MIN_GAP_MS;
}

export type FileReferenceReconcileRun = (
  mode: ReconcileMode,
) => Promise<FileReferenceReconciliationResult>;

/**
 * Starts the nightly run on the elected leader (`runtime/schedulers.ts`). The
 * run history is the schedule — a short due-check tick asks when the last run
 * started — so a deploy cannot reset a 24-hour timer into never firing.
 */
export class FileReferenceReconciliationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly run: FileReferenceReconcileRun = runFileReferenceReconciliation,
    private readonly now: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.running) return;
    if (config.oxyFiles.reconcileMode === 'off') {
      logger.info('[FileReferences] reconciliation off (OXY_FILE_REFERENCE_RECONCILE_MODE=off)');
      return;
    }
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, DUE_CHECK_INTERVAL_MS);
    this.timer.unref?.();
    logger.info('[FileReferences] reconciliation scheduler started', {
      mode: config.oxyFiles.reconcileMode,
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    const work = this.runIfDue()
      .catch((error: unknown) => {
        logger.error('[FileReferences] reconciliation failed to run', {
          reason: describeOxyError(error),
        });
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    await work;
  }

  private async runIfDue(): Promise<void> {
    const mode = config.oxyFiles.reconcileMode;
    if (mode === 'off') return;
    if (!isReconciliationDue(this.now(), await latestReconciliationStartedAt())) return;

    const result = await this.run(mode);
    const failed = result.entityTypes.filter((entry) => !entry.ok);
    const sum = (key: 'added' | 'removed' | 'refused' | 'replayed') =>
      result.entityTypes.reduce((total, entry) => total + (entry[key] ?? 0), 0);
    logger.info('[FileReferences] reconciliation finished', {
      runId: result.runId,
      mode,
      entityTypes: result.entityTypes.length,
      added: sum('added'),
      removed: sum('removed'),
      refused: sum('refused'),
      replayed: sum('replayed'),
      failed: failed.length,
    });
    if (failed.length > 0) {
      // A failed entity type is not reconciled tonight: loud, with the reasons.
      logger.error('[FileReferences] reconciliation failed for some entity types', {
        runId: result.runId,
        failures: failed.slice(0, 10).map((entry) => `${entry.oxyEntityType}: ${entry.error}`),
      });
    }
  }
}

export const fileReferenceReconciliationScheduler = new FileReferenceReconciliationScheduler();
