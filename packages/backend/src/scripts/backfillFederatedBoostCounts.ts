/**
 * One-shot corpus backfill: derive `stats.federatedBoostsCount` for posts that
 * predate the counter.
 *
 * `stats.federatedBoostsCount` records how many of a post's boosts originated as
 * inbound ActivityPub Announces (federated boosts) rather than native reposts.
 * Going forward it is maintained in lockstep with `stats.boostsCount` at the
 * federated import site (`OutboxSyncService.importAnnounce`) and the undo site
 * (`InboxProcessingService.handleUndoAnnounce`). Posts boosted before the field
 * existed carry no value (defaulting to 0), so `boostsCount - federatedBoostsCount`
 * would over-count the native boost subset until this runs. This recomputes the
 * exact count from the authoritative boost `Post` records.
 *
 * For each post it counts the boost Posts that reference it (`boostOf === post._id`),
 * are of `type: 'boost'`, and carry a `federation.activityId` (the marker of a
 * federated Announce), then writes that number to `stats.federatedBoostsCount`.
 *
 * Idempotent: the stored value is compared to the freshly computed count and a
 * write is enqueued ONLY when they differ, so a re-run over an already-correct
 * corpus performs zero writes. Batched via a stable ascending `_id` page cursor,
 * bounded bulkWrite chunks, and fail-soft (a single post's count failure is
 * logged at warn and skipped — never aborts the run). Supports `--dry-run`
 * (report what it would update, write nothing).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillFederatedBoostCounts.js
 *   bun packages/backend/dist/src/scripts/backfillFederatedBoostCounts.js --dry-run
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';

/** Posts scanned per page (stable ascending `_id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

/** Update writes flushed per bulkWrite chunk. */
const BULK_CHUNK_SIZE = 500;

export interface BackfillFederatedBoostCountsResult {
  scanned: number;
  updated: number;
}

/** Minimal projected shape the backfill needs per post. */
interface PostBoostTargetRow {
  _id: mongoose.Types.ObjectId;
  stats?: { federatedBoostsCount?: number };
}

/**
 * Recompute and backfill `stats.federatedBoostsCount` across the corpus. Operates
 * on the `Post` model only — the caller owns the Mongo connection lifecycle — so
 * it is unit-testable with a mocked model and reusable from an in-process caller.
 */
export async function backfillFederatedBoostCounts(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillFederatedBoostCountsResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;

  let scanned = 0;
  let updated = 0;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0 || dryRun) {
      pendingOps = [];
      return;
    }
    await Post.bulkWrite(pendingOps, { ordered: false });
    pendingOps = [];
  };

  // No selection filter: any post can be a boost target, so every post is a
  // candidate. Posts with no federated boosts compute a count of 0 that matches
  // the stored default, so they are skipped without a write (idempotency). The
  // ascending `_id` cursor never revisits a page.
  for (;;) {
    const pageFilter: Record<string, unknown> = {};
    if (lastId) {
      pageFilter._id = { $gt: lastId };
    }

    const page = await Post.find(pageFilter, {
      _id: 1,
      'stats.federatedBoostsCount': 1,
    })
      .sort({ _id: 1 })
      .limit(pageSize)
      .lean<PostBoostTargetRow[]>();

    if (page.length === 0) break;

    for (const post of page) {
      scanned += 1;
      try {
        // Count the federated Announce boosts of this post: boost records that
        // reference it and carry a federation activity id (native reposts have
        // `boostOf` + `type: 'boost'` but NO `federation.activityId`).
        const federatedBoosts = await Post.countDocuments({
          boostOf: String(post._id),
          type: 'boost',
          'federation.activityId': { $exists: true },
        });

        const current = post.stats?.federatedBoostsCount ?? 0;
        // Already correct (the common zero-boost case): skip — keeps re-runs
        // write-free and idempotent.
        if (federatedBoosts === current) continue;

        updated += 1;
        if (dryRun) continue;

        pendingOps.push({
          updateOne: {
            filter: { _id: post._id },
            update: {
              $set: { 'stats.federatedBoostsCount': federatedBoosts },
            },
          },
        });

        if (pendingOps.length >= BULK_CHUNK_SIZE) {
          await flush();
        }
      } catch (error) {
        logger.warn('[backfillFederatedBoostCounts] count failed for post; skipping', {
          id: String(post._id),
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1]._id;
    logger.info(`[backfillFederatedBoostCounts] progress: scanned ${scanned}, updated ${updated}`);
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
    logger.info(`[backfillFederatedBoostCounts] connected to MongoDB (${dbName}); DRY_RUN=${dryRun}`);

    const result = await backfillFederatedBoostCounts({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedBoostCounts] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[backfillFederatedBoostCounts] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
