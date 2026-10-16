import { inArray } from 'drizzle-orm';
import type { ServiceFileReference, ServiceFileReferenceResult } from '@oxy.so/core';
import { config } from '../../config';
import { getDb } from '../../db/postgres';
import {
  countStuckFileReferences,
  findDueFileReferences,
  findFileReferences,
  findLiveFileReferencesOfFiles,
  forceResendFileReferences,
  retryFileReferences,
  settleFileReferences,
  type DueFileReference,
  type FileReferenceKey,
  type SettledFileReference,
} from '../../db/oxyFiles/fileReferenceSyncRepository';
import { federatedMediaPosters } from '../../db/schema/federation';
import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import {
  fileReferenceEntity,
  oxyEntityTypeFor,
  pairKey,
  type FileReferenceEntityType,
} from '../../db/oxyFiles/fileReferenceEntities';
import { describeOxyError, oxyErrorStatus } from './oxyErrors';

/**
 * Drain `oxy_file_reference_sync`: tell Oxy which files Mention uses
 * (ADR 0041 D4; `docs/oxy-files.md`).
 *
 * Each due row is a pair the triggers marked. The drain asks the entity
 * registry whether the pair is in use NOW, compares that with what Oxy was last
 * told, and sends only the difference — `references.add` for a use Oxy does not
 * hold, `references.remove` for one that ended — in batches of 100 (Oxy's cap).
 * A row is settled only for the generation it read, so a mark that lands while
 * Oxy is answering is decided again on the next run.
 *
 * Oxy's answers: `created`/`exists` → Oxy holds it; `removed`/`not_found` to a
 * removal → it does not; `not_found` to an add → `refused` (the file is gone,
 * or Mention may not reference it — a person's private file). A failed call
 * (429, 5xx, transport, a missing scope) is retried with backoff; nothing is
 * read as an answer that is not one.
 *
 * Runs on the periodic queue (one run across the fleet). `OXY_FILE_REFERENCES_ENABLED=false`
 * PAUSES it: marks keep accumulating and nothing is lost.
 */

const STUCK_METRIC = 'oxy_file_reference_stuck';
const RETRY_BASE_MS = 60 * 1000;
const RETRY_MAX_MS = 6 * 60 * 60 * 1000;
/** Oxy's per-request cap of `POST`/`DELETE /assets/service/references`. */
export const OXY_REFERENCES_BATCH_MAX = 100;
/** Rows decided per batch; at most 5 Oxy calls per op. */
const ROWS_PER_BATCH = 500;
/** Batches per run: ≤ 2,000 pairs every 30 s, far inside Oxy's per-app request budget. */
const MAX_BATCHES_PER_RUN = 4;
/** Attempts after which a pending pair counts as STUCK (≈ a day of backoff). */
export const STUCK_ATTEMPTS = 10;

/** Exported for tests. */
export function fileReferenceBackoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts), RETRY_MAX_MS);
}

export interface FileReferenceSyncResult {
  checked: number;
  /** Pairs Oxy now holds that it did not (`created`, or `exists` after a lost answer). */
  added: number;
  removed: number;
  /** Adds Oxy refused (`not_found`). */
  refused: number;
  /** Already what Oxy was told: settled without a call. */
  unchanged: number;
  retried: number;
}

function emptyResult(): FileReferenceSyncResult {
  return { checked: 0, added: 0, removed: 0, refused: 0, unchanged: 0, retried: 0 };
}

function addInto(total: FileReferenceSyncResult, part: FileReferenceSyncResult): void {
  for (const key of Object.keys(total) as Array<keyof FileReferenceSyncResult>) {
    total[key] += part[key];
  }
}

/** The SDK reference for a row: its Oxy entity type is the (sharded) registry name. */
function toOxyReference(row: FileReferenceKey): ServiceFileReference {
  return {
    fileId: row.fileId,
    entityType: oxyEntityTypeFor(fileReferenceEntity(row.entityType), row.entityId),
    entityId: row.entityId,
  };
}

/** Which rows are in use, by asking each entity type about its own pairs. */
async function decideInUse(rows: readonly DueFileReference[]): Promise<Set<DueFileReference>> {
  const inUse = new Set<DueFileReference>();
  const byType = new Map<FileReferenceEntityType, DueFileReference[]>();
  for (const row of rows) {
    const list = byType.get(row.entityType) ?? [];
    list.push(row);
    byType.set(row.entityType, list);
  }
  for (const [type, list] of byType) {
    const used = await fileReferenceEntity(type).pairsInUse(getDb(), list);
    for (const row of list) if (used.has(pairKey(row.fileId, row.entityId))) inUse.add(row);
  }
  return inUse;
}

/**
 * Send one op for some rows, at most {@link OXY_REFERENCES_BATCH_MAX} per call,
 * settling each answered chunk as it lands. A failed call retries that chunk
 * and every chunk after it (they were never sent), and ends the op.
 */
async function sendOp(
  op: 'add' | 'remove',
  rows: readonly DueFileReference[],
  result: FileReferenceSyncResult,
): Promise<boolean> {
  const references = getServiceOxyClient().assets.references;
  for (let start = 0; start < rows.length; start += OXY_REFERENCES_BATCH_MAX) {
    const chunk = rows.slice(start, start + OXY_REFERENCES_BATCH_MAX);
    let answers: ServiceFileReferenceResult[];
    try {
      const body = chunk.map(toOxyReference);
      answers = op === 'add' ? await references.add(body) : await references.remove(body);
    } catch (error) {
      const remaining = rows.slice(start);
      const attempts = Math.max(0, ...remaining.map((row) => row.attempts));
      await retryFileReferences(
        remaining,
        fileReferenceBackoffMs(attempts),
        `${op}: ${describeOxyError(error)}`,
      ).catch(() => undefined);
      result.retried += remaining.length;
      logger.warn('[FileReferences] Oxy did not answer; will retry', {
        op,
        status: oxyErrorStatus(error),
        reason: describeOxyError(error),
        pairs: remaining.length,
      });
      return false;
    }

    const settled: SettledFileReference[] = [];
    const unanswered: DueFileReference[] = [];
    chunk.forEach((row, index) => {
      const answer = answers[index];
      // Answers come back in the order sent; one that does not name its row is
      // not an answer for it.
      if (!answer || answer.fileId !== row.fileId || answer.entityId !== row.entityId) {
        unanswered.push(row);
        return;
      }
      if (op === 'add') {
        if (answer.result === 'created' || answer.result === 'exists') {
          settled.push({ ...row, outcome: 'add' });
          result.added += 1;
        } else if (answer.result === 'not_found') {
          settled.push({ ...row, outcome: 'refused' });
          result.refused += 1;
        } else unanswered.push(row);
      } else if (answer.result === 'removed' || answer.result === 'not_found') {
        settled.push({ ...row, outcome: 'remove' });
        result.removed += 1;
      } else unanswered.push(row);
    });
    await settleFileReferences(settled);
    if (unanswered.length > 0) {
      const attempts = Math.max(0, ...unanswered.map((row) => row.attempts));
      await retryFileReferences(unanswered, fileReferenceBackoffMs(attempts), `${op}: no answer`);
      result.retried += unanswered.length;
    }
  }
  return true;
}

/**
 * Decide and send a set of rows. Never throws on an Oxy failure (rows are
 * backed off); a database failure propagates to the caller.
 */
export async function syncFileReferenceRows(
  rows: readonly DueFileReference[],
): Promise<FileReferenceSyncResult> {
  const result = emptyResult();
  if (rows.length === 0) return result;
  result.checked = rows.length;

  const inUse = await decideInUse(rows);
  const unchanged: SettledFileReference[] = [];
  const toAdd: DueFileReference[] = [];
  const toRemove: DueFileReference[] = [];
  for (const row of rows) {
    const desired = inUse.has(row) ? 'add' : 'remove';
    if (row.syncedOp === desired) unchanged.push({ ...row, outcome: desired });
    else if (desired === 'add') toAdd.push(row);
    else toRemove.push(row);
  }
  await settleFileReferences(unchanged);
  result.unchanged += unchanged.length;

  // Removals first: a reference that must go is the one with consequences
  // (it keeps a file alive), and they are the cheaper half to lose to a 429.
  const removedAll = await sendOp('remove', toRemove, result);
  if (!removedAll) {
    await retryFileReferences(toAdd, fileReferenceBackoffMs(0), 'add: deferred').catch(
      () => undefined,
    );
    result.retried += toAdd.length;
    return result;
  }
  await sendOp('add', toAdd, result);
  return result;
}

/** One batch of due rows. Never throws. */
async function drainOneBatch(): Promise<FileReferenceSyncResult> {
  try {
    const due = await findDueFileReferences(ROWS_PER_BATCH);
    return await syncFileReferenceRows(due);
  } catch (error) {
    logger.warn('[FileReferences] batch failed', { reason: describeOxyError(error) });
    return { ...emptyResult(), retried: 1 };
  }
}

/**
 * One drain run: batches until nothing is due, a batch had to retry (the rest
 * would hit the same wall), or {@link MAX_BATCHES_PER_RUN}. Then the stuck
 * gauge. Never throws.
 */
export async function drainFileReferenceSync(): Promise<FileReferenceSyncResult> {
  const total = emptyResult();
  if (!config.oxyFiles.referencesEnabled) {
    logger.debug('[FileReferences] paused by OXY_FILE_REFERENCES_ENABLED=false');
    return total;
  }
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const result = await drainOneBatch();
    addInto(total, result);
    if (result.checked < ROWS_PER_BATCH || result.retried > 0) break;
  }
  if (total.refused > 0) {
    // Not an error: a person's private file, or a file deleted before its post
    // was. Counted so a jump (a scope lost, an id-shape regression) is visible.
    logger.info('[FileReferences] Oxy refused references', { refused: total.refused });
  }
  try {
    const stuck = await countStuckFileReferences(STUCK_ATTEMPTS);
    metrics.setGauge(STUCK_METRIC, stuck);
    if (stuck > 0) {
      // Loud: an unregistered use of an APPLICATION file is collected by Oxy
      // after a day (D5), and a removal Oxy never takes keeps a file alive.
      logger.error('[FileReferences] file references are stuck (Oxy keeps failing to answer)', {
        stuck,
        attemptsAtLeast: STUCK_ATTEMPTS,
      });
    }
  } catch (error) {
    logger.warn('[FileReferences] stuck count failed', { reason: describeOxyError(error) });
  }
  return total;
}

/**
 * Make Oxy hold NO Mention reference to these files, now — the federated
 * deletion drain calls it after deciding (under its locks) that Mention no
 * longer shows them, and before asking Oxy to delete them. A re-hosted file is
 * owned by the federated actor's Oxy account, and Oxy refuses to delete an
 * account's file another application references (`in_use`): a Mention
 * reference still registered, or one whose removal is still queued, would keep
 * the file forever.
 *
 * Every pair of the file that is not certainly removed is re-sent from the
 * current data (posters included: a video's tombstone ends its poster's use
 * without touching a row the triggers watch). Returns the files that are
 * clear; the caller retries the others later. Throws only on a database error.
 */
export async function clearFileReferencesBeforeDelete(
  fileIds: readonly string[],
): Promise<Set<string>> {
  const clear = new Set(fileIds);
  if (fileIds.length === 0) return clear;

  const keys: FileReferenceKey[] = await findLiveFileReferencesOfFiles(fileIds);
  const posters = await getDb()
    .select({
      poster: federatedMediaPosters.posterFileId,
      video: federatedMediaPosters.videoFileId,
    })
    .from(federatedMediaPosters)
    .where(inArray(federatedMediaPosters.posterFileId, [...fileIds]));
  for (const row of posters) {
    keys.push({ fileId: row.poster, entityType: 'video_poster', entityId: row.video });
  }
  if (keys.length === 0) return clear;

  if (!config.oxyFiles.referencesEnabled) {
    // Paused: nothing can be sent, so nothing is certainly clear.
    for (const key of keys) clear.delete(key.fileId);
    return clear;
  }

  await forceResendFileReferences(keys);
  await syncFileReferenceRows(await findFileReferences(keys));

  // Clear only when every pair of the file now reads "Oxy holds no reference".
  for (const row of await findLiveFileReferencesOfFiles(fileIds)) clear.delete(row.fileId);
  return clear;
}
