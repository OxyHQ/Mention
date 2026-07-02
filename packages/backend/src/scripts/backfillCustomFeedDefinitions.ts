/**
 * One-shot migration: derive a composable `definition` for every CustomFeed that
 * predates Phase 3 (custom feeds as definitions).
 *
 * Before Phase 3 a custom feed stored a fixed filter shape
 * (`memberOxyUserIds`/`keywords`/`language`/`includeReplies`/`includeBoosts`/
 * `includeMedia`, owner implicitly excluded from keyword-only feeds). The feed
 * engine now runs a {@link StoredFeedDefinition}. This backfill maps each legacy
 * feed's fields into that definition via the shared {@link legacyCustomFeedToDefinition}
 * mapper (the same mapping the request-time fallback uses), so behaviour is
 * preserved and the two paths can never drift.
 *
 * Idempotent (a feed with a stored `definition` is removed from the selection
 * filter, so the ascending `_id` cursor never revisits it and a re-run only fills
 * gaps), batched via a stable ascending `_id` page cursor, and fail-soft (a single
 * feed's mapping failure is logged at warn and skipped — never aborts the run).
 * Supports `--dry-run` (report what it would migrate, write nothing).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillCustomFeedDefinitions.js
 *   bun packages/backend/dist/src/scripts/backfillCustomFeedDefinitions.js --dry-run
 */

import mongoose from 'mongoose';
import CustomFeed from '../models/CustomFeed';
import { legacyCustomFeedToDefinition } from '../mtn/feed/definitions/legacyCustomFeed';
import { logger } from '../utils/logger';

/** Feeds scanned per page (stable ascending `_id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

/** Update writes flushed per bulkWrite chunk. */
const BULK_CHUNK_SIZE = 500;

export interface BackfillCustomFeedDefinitionsResult {
  scanned: number;
  updated: number;
}

/** Minimal projected shape the mapper needs. */
interface LegacyFeedRow {
  _id: mongoose.Types.ObjectId;
  ownerOxyUserId?: string;
  memberOxyUserIds?: string[];
  keywords?: string[];
  language?: string;
  includeReplies?: boolean;
  includeBoosts?: boolean;
  includeMedia?: boolean;
}

/**
 * Backfill definitions over the un-migrated corpus. Operates on the `CustomFeed`
 * model only — the caller owns the Mongo connection lifecycle — so it is
 * unit-testable with a mocked model and reusable from an in-process caller.
 */
export async function backfillCustomFeedDefinitions(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillCustomFeedDefinitionsResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;

  // Feeds without a stored definition. Setting the definition removes a feed from
  // this filter, so the ascending `_id` cursor never revisits a migrated feed.
  const baseFilter: Record<string, unknown> = { definition: { $in: [null, undefined] } };

  let scanned = 0;
  let updated = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof CustomFeed>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0 || dryRun) {
      pendingOps = [];
      return;
    }
    await CustomFeed.bulkWrite(pendingOps, { ordered: false });
    pendingOps = [];
  };

  for (;;) {
    const pageFilter: Record<string, unknown> = { ...baseFilter };
    if (lastId) {
      pageFilter._id = { $gt: lastId };
    }

    const page = await CustomFeed.find(pageFilter, {
      _id: 1,
      ownerOxyUserId: 1,
      memberOxyUserIds: 1,
      keywords: 1,
      language: 1,
      includeReplies: 1,
      includeBoosts: 1,
      includeMedia: 1,
    })
      .sort({ _id: 1 })
      .limit(pageSize)
      .lean<LegacyFeedRow[]>();

    if (page.length === 0) break;

    for (const feed of page) {
      scanned += 1;
      try {
        const definition = legacyCustomFeedToDefinition(feed);
        updated += 1;
        if (dryRun) continue;

        pendingOps.push({
          updateOne: {
            filter: { _id: feed._id },
            update: { $set: { definition } },
          },
        });

        if (pendingOps.length >= BULK_CHUNK_SIZE) {
          await flush();
        }
      } catch (error) {
        logger.warn('[backfillCustomFeedDefinitions] mapping failed for feed; skipping', {
          id: String(feed._id),
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1]._id;
    logger.info(`[backfillCustomFeedDefinitions] progress: scanned ${scanned}, updated ${updated}`);
  }

  await flush();

  return { scanned, updated };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;
  const dryRun = process.argv.includes('--dry-run');

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[backfillCustomFeedDefinitions] connected to MongoDB (${dbName}); DRY_RUN=${dryRun}`);

    const result = await backfillCustomFeedDefinitions({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillCustomFeedDefinitions] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[backfillCustomFeedDefinitions] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
