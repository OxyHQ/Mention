/**
 * One-shot move of the GIF library out of Oxy's federation media cache into
 * files the Mention APPLICATION owns (ADR 0043; `docs/oxy-files.md`).
 *
 * WHY. Until ADR 0043 an application could not own a file, so the library was
 * uploaded into the platform's federation media cache — a namespace owned by
 * nobody, kept only by the convention that Mention never evicted a GIF there.
 * New imports already go to application files (`gifLibraryService.importGif`,
 * `gifs.storage = 'application'`); this moves every row written before
 * (`gifs.storage = 'federation_cache'`, which is also the column default, so a
 * row the previous image wrote during the deploy is moved too).
 *
 * WHAT, PER PAGE OF GIFS:
 *  1. Oxy imports every file of the page from its own public CDN URL as a
 *     public application file, in ONE batch request (`importAppFiles`: same
 *     bytes, one fetch each, and a re-run answers the file it already made).
 *
 * THEN, PER GIF (`moveGifToApplicationFiles`), when both its files imported:
 *  2. ONE transaction records each old cache id as owed a delete
 *     (`gif_cache_file_retirements`), points the row at the new ids, and
 *     rewrites every post naming an old id — shared media, variant media,
 *     variant alt texts, attachments. The reference triggers move each post's
 *     Oxy reference to the new file in the same transaction, and the row's
 *     `gif` references with it.
 *  3. Post-record caches of the rewritten posts are invalidated.
 *
 * THEN, PER OLD FILE (`retireOldFiles`): any post row a racing request wrote
 * with the old id is rewritten too (the post insert already redirects retired
 * ids, so none can appear after the retirement committed), and the old file is
 * deleted from the cache namespace — unless a GIF row still uses it (retried on
 * the next run) or a federated media-cache entry holds the same bytes (`kept`:
 * the cache's own eviction owns it from there).
 *
 * OXY'S BUDGETS. Imports share Oxy's 30 requests a minute per application
 * (`rl:asset-app:upload:`) with the live GIF picker, and a batch of up to 50
 * counts as one request — so a page is one request, pages are spaced
 * {@link IMPORT_PAUSE_MS} apart, and a batch Oxy answers 429 is sent again once
 * the window has passed instead of failing the page. Old-file deletes share the
 * cache's 240 a minute with the eviction job; a delete refused for the budget
 * waits out the cooldown and is asked again.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`: counts the GIFs, the posts that would be
 *     rewritten and the retirements owed, and changes nothing (no Oxy call).
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Idempotent and resumable: a moved row is no longer `federation_cache`, a
 *     retirement no longer `pending`. A failed GIF is counted, left as it was,
 *     and moved by the next run; the run then exits non-zero.
 *
 * Runnable as a Fargate one-shot (DRY_RUN first), or through
 * `.github/workflows/run-gif-library-migration.yml`:
 *   bun packages/backend/dist/src/scripts/migrateGifLibraryToApplicationFiles.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=migrateGifLibraryToApplicationFiles \
 *     bun packages/backend/dist/src/scripts/migrateGifLibraryToApplicationFiles.js
 */

import { sql } from 'drizzle-orm';
import {
  findCacheGifs,
  findPendingRetirements,
  moveGifToApplicationFiles,
  prepareRetirement,
  settleRetirement,
  type CacheGif,
} from '../db/oxyFiles/gifCacheRetirementRepository';
import { connectPostgres, getDb } from '../db/postgres';
import {
  deleteRetiredGifCacheFile,
  isMediaStoreThrottled,
} from '../services/mediaCache/oxyMediaStore';
import { describeOxyError, oxyErrorStatus } from '../services/oxyFiles/oxyErrors';
import { invalidate as invalidatePostDetailCache } from '../services/postDetailCache';
import { logger } from '../utils/logger';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { assertAdminRunComplete, closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'migrateGifLibraryToApplicationFiles';

/** GIFs per page: each has at most two files, so a page fits Oxy's 50-item import batch. */
export const BATCH_SIZE = 25;

/** Pause after each import batch: at most 6 of Oxy's 30 import requests a minute. */
export const IMPORT_PAUSE_MS = 10_000;

/** Pause after each old-file delete: 120 a minute, half the cache's delete budget. */
export const DELETE_PAUSE_MS = 500;

/** On a 429, how long to wait before sending the batch again: Oxy's window is one minute. */
export const RATE_LIMIT_WAIT_MS = 61_000;

/** Attempts per batch, or per delete, while Oxy answers that its budget is spent. */
export const RATE_LIMIT_ATTEMPTS = 5;

/** One URL's import: the new file, or why it was not made. */
export type GifFileImport = { ok: true; fileId: string } | { ok: false; reason: string };

export interface GifLibraryMigrationDeps {
  /**
   * Import public files by URL as Mention's, in one request; one answer per
   * URL, in order. Throws when the request itself fails (a 429 included).
   */
  importFiles(sourceUrls: readonly string[]): Promise<GifFileImport[]>;
  /** The public URL Oxy serves an existing file at. */
  publicUrl(fileId: string): string;
  /** Delete an old cache-namespace file. */
  deleteCacheFile(fileId: string): Promise<'deleted' | 'not_found'>;
  invalidatePost(postId: string): Promise<void>;
  pause(ms: number): Promise<void>;
}

const defaultDeps: GifLibraryMigrationDeps = {
  async importFiles(sourceUrls) {
    const results = await getServiceOxyClient().assets.importAppFiles(
      sourceUrls.map((sourceUrl) => ({ sourceUrl, visibility: 'public' as const })),
    );
    const answers: GifFileImport[] = sourceUrls.map(() => ({
      ok: false,
      reason: 'no answer for this item',
    }));
    for (const result of results) {
      answers[result.index] = result.ok
        ? { ok: true, fileId: result.file.id }
        : { ok: false, reason: `HTTP ${result.error.status} ${result.error.code}` };
    }
    return answers;
  },
  publicUrl: (fileId) => getServiceOxyClient().assets.publicUrl(fileId),
  deleteCacheFile: deleteRetiredGifCacheFile,
  invalidatePost: invalidatePostDetailCache,
  pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface GifLibraryMigrationResult {
  gifsSeen: number;
  gifsMoved: number;
  /** Import or write failed; the row is unchanged and the next run retries it. */
  gifsFailed: number;
  postMediaRewritten: number;
  variantMediaRewritten: number;
  altTextsRewritten: number;
  attachmentsRewritten: number;
  /** Dry run: post media rows naming a file still in the cache. */
  postMediaToRewrite: number;
  retirementsDeleted: number;
  retirementsNotFound: number;
  retirementsKept: number;
  /** A GIF row still uses the old file; retried on the next run. */
  retirementsWaiting: number;
  retirementsFailed: number;
  /** Dry run: retirements owed a delete. */
  retirementsPending: number;
}

function emptyResult(): GifLibraryMigrationResult {
  return {
    gifsSeen: 0,
    gifsMoved: 0,
    gifsFailed: 0,
    postMediaRewritten: 0,
    variantMediaRewritten: 0,
    altTextsRewritten: 0,
    attachmentsRewritten: 0,
    postMediaToRewrite: 0,
    retirementsDeleted: 0,
    retirementsNotFound: 0,
    retirementsKept: 0,
    retirementsWaiting: 0,
    retirementsFailed: 0,
    retirementsPending: 0,
  };
}

/** Import a page's files, sending the batch again while Oxy answers 429. */
async function importWithBudget(
  sourceUrls: readonly string[],
  deps: GifLibraryMigrationDeps,
): Promise<GifFileImport[]> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.importFiles(sourceUrls);
    } catch (error) {
      if (oxyErrorStatus(error) !== 429 || attempt >= RATE_LIMIT_ATTEMPTS) throw error;
      logger.warn(`[${SCRIPT_NAME}] Oxy's import budget is spent; sending the batch again`, {
        attempt,
      });
      await deps.pause(RATE_LIMIT_WAIT_MS);
    }
  }
}

/** Move one page of GIFs: one import batch, then one transaction per GIF. */
async function movePage(
  page: readonly CacheGif[],
  deps: GifLibraryMigrationDeps,
  result: GifLibraryMigrationResult,
): Promise<void> {
  const fileIds = [...new Set(page.flatMap((gif) => [gif.mp4FileId, gif.previewFileId]))];
  let imported: Map<string, GifFileImport>;
  try {
    const answers = await importWithBudget(
      fileIds.map((fileId) => deps.publicUrl(fileId)),
      deps,
    );
    imported = new Map(fileIds.map((fileId, index) => [fileId, answers[index]]));
  } catch (error) {
    result.gifsFailed += page.length;
    logger.warn(`[${SCRIPT_NAME}] import batch failed; the next run retries its GIFs`, {
      gifs: page.length,
      reason: describeOxyError(error),
    });
    return;
  } finally {
    await deps.pause(IMPORT_PAUSE_MS);
  }

  for (const gif of page) {
    const mp4 = imported.get(gif.mp4FileId);
    const preview = imported.get(gif.previewFileId);
    if (!mp4?.ok || !preview?.ok) {
      result.gifsFailed += 1;
      const failure = [mp4, preview].find((answer) => answer && !answer.ok);
      logger.warn(`[${SCRIPT_NAME}] GIF not moved; the next run retries it`, {
        gifId: gif.id,
        reason: failure && !failure.ok ? failure.reason : 'no answer',
      });
      continue;
    }
    try {
      const rewrite = await moveGifToApplicationFiles(gif, mp4.fileId, preview.fileId);
      if (!rewrite) continue; // moved by a concurrent run
      result.gifsMoved += 1;
      result.postMediaRewritten += rewrite.postMedia;
      result.variantMediaRewritten += rewrite.variantMedia;
      result.altTextsRewritten += rewrite.altTexts;
      result.attachmentsRewritten += rewrite.attachments;
      for (const postId of rewrite.postIds) {
        await deps.invalidatePost(postId).catch(() => undefined);
      }
    } catch (error) {
      result.gifsFailed += 1;
      logger.warn(`[${SCRIPT_NAME}] GIF not moved; the next run retries it`, {
        gifId: gif.id,
        reason: describeOxyError(error),
      });
    }
  }
}

/** Delete one old cache file, waiting out the cache's write cooldown when Oxy says it is spent. */
async function deleteWithBudget(
  oldFileId: string,
  deps: GifLibraryMigrationDeps,
): Promise<'deleted' | 'not_found'> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await deps.deleteCacheFile(oldFileId);
    } catch (error) {
      if (!isMediaStoreThrottled(error) || attempt >= RATE_LIMIT_ATTEMPTS) throw error;
      await deps.pause(error.retryAfterMs + 1000);
    }
  }
}

/** Delete the old cache files the moved GIFs left behind. */
async function retireOldFiles(
  deps: GifLibraryMigrationDeps,
  result: GifLibraryMigrationResult,
): Promise<void> {
  // Pages by "still pending": every row leaves that state or is counted as
  // waiting/failed, and those are not read again in this run.
  const skip = new Set<string>();
  for (;;) {
    const page = (await findPendingRetirements(BATCH_SIZE + skip.size)).filter(
      (row) => !skip.has(row.oldFileId),
    );
    if (page.length === 0) return;
    for (const row of page) {
      skip.add(row.oldFileId);
      try {
        const prepared = await getDb().transaction((tx) =>
          prepareRetirement(tx, row.oldFileId, row.newFileId),
        );
        result.postMediaRewritten += prepared.rewrite.postMedia;
        result.variantMediaRewritten += prepared.rewrite.variantMedia;
        result.altTextsRewritten += prepared.rewrite.altTexts;
        result.attachmentsRewritten += prepared.rewrite.attachments;
        for (const postId of prepared.rewrite.postIds) {
          await deps.invalidatePost(postId).catch(() => undefined);
        }
        if (prepared.verdict === 'wait') {
          result.retirementsWaiting += 1;
          continue;
        }
        if (prepared.verdict === 'kept') {
          await settleRetirement(row.oldFileId, 'kept');
          result.retirementsKept += 1;
          continue;
        }
        const outcome = await deleteWithBudget(row.oldFileId, deps);
        await settleRetirement(row.oldFileId, outcome);
        if (outcome === 'deleted') result.retirementsDeleted += 1;
        else result.retirementsNotFound += 1;
        await deps.pause(DELETE_PAUSE_MS);
      } catch (error) {
        result.retirementsFailed += 1;
        const reason = describeOxyError(error);
        await settleRetirement(row.oldFileId, { error: reason }).catch(() => undefined);
        logger.warn(`[${SCRIPT_NAME}] old cache file not deleted; the next run retries it`, {
          oldFileId: row.oldFileId,
          reason,
        });
      }
    }
  }
}

export async function migrateGifLibraryToApplicationFiles({
  dryRun,
  deps = defaultDeps,
}: {
  dryRun: boolean;
  deps?: GifLibraryMigrationDeps;
}): Promise<GifLibraryMigrationResult> {
  const result = emptyResult();
  let cursor: string | null = null;
  // Rows that failed stay `federation_cache`; the cursor walks past them.
  for (;;) {
    const page = await findCacheGifs(cursor, BATCH_SIZE);
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;
    result.gifsSeen += page.length;
    if (dryRun) {
      const ids = [...new Set(page.flatMap((gif) => [gif.mp4FileId, gif.previewFileId]))];
      const [row] = await getDb().execute<{ n: number }>(sql`
        select count(*)::int as n from post_media
        where media_id = any(${sql.param(ids)}::text[])
      `);
      result.postMediaToRewrite += Number(row?.n ?? 0);
      continue;
    }
    await movePage(page, deps, result);
  }

  if (dryRun) {
    const [row] = await getDb().execute<{ n: number }>(sql`
      select count(*)::int as n from gif_cache_file_retirements where state = 'pending'
    `);
    result.retirementsPending = Number(row?.n ?? 0);
  } else {
    await retireOldFiles(deps, result);
  }

  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  const result = await migrateGifLibraryToApplicationFiles({ dryRun });
  // No tolerance: every failure here is a file this run did not move or
  // delete, and the next run retries it. A non-zero count fails the run so
  // nobody reads it as finished.
  assertAdminRunComplete(SCRIPT_NAME, {
    gifsFailed: result.gifsFailed,
    retirementsFailed: result.retirementsFailed,
  });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
