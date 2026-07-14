/**
 * One-shot reconciliation: link ALREADY-imported federated replies into their
 * threads.
 *
 * Before the thread-linking fix, federated replies were stored with
 * `federation.inReplyTo` (the raw remote parent URI) but WITHOUT the local
 * `parentPostId` / `threadId` that the thread + replies machinery reads — so an
 * imported reply rendered as an orphan, never attached to its parent.
 *
 * This script finds those orphans (`federation.inReplyTo` set but `parentPostId`
 * unset) and links each one:
 *   - resolve `federation.inReplyTo` → the parent's local Post `_id`
 *     (`parentPostId`),
 *   - derive `threadId` = the thread ROOT id, mirroring the native reply rule
 *     (`threadId = parent.threadId ?? parent._id`), walking UP the chain so every
 *     reply in a thread shares the same root.
 *
 * Resolution reuses `OutboxSyncService.ensureFederatedReplyLink`, the same logic
 * the live ingest paths use. By default it resolves ONLY against parents already
 * present locally (no network I/O). Set `BACKFILL_ANCESTORS=true` to ALSO fetch +
 * import missing ancestor Notes (bounded, signed, SSRF-safe) before linking —
 * this mutates the DB by importing ancestors and is therefore opt-in.
 *
 * Idempotent (re-running skips posts already linked — they no longer match the
 * filter), batched via a stable ascending `_id` cursor, logs progress + a final
 * summary, and supports `DRY_RUN=true` (resolve + report, write nothing; always
 * local-only — never imports ancestors).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillFederatedThreadLinks.js
 *   DRY_RUN=true bun packages/backend/dist/src/scripts/backfillFederatedThreadLinks.js
 *   BACKFILL_ANCESTORS=true bun packages/backend/dist/src/scripts/backfillFederatedThreadLinks.js
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { outboxSyncService } from '../connectors/activitypub/outbox.service';
import { extractInReplyToUri } from '../connectors/activitypub/helpers';
import { logger } from '../utils/logger';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Link writes flushed per bulkWrite chunk. */
const BULK_CHUNK_SIZE = 500;

const DRY_RUN = process.env.DRY_RUN === 'true';
// Opt-in: fetch + import missing ancestor Notes before linking (network I/O,
// mutates the DB). Never active under DRY_RUN.
const BACKFILL_ANCESTORS = !DRY_RUN && process.env.BACKFILL_ANCESTORS === 'true';

interface OrphanReplyRow {
  _id: mongoose.Types.ObjectId;
  federation?: { inReplyTo?: string };
}

async function backfillFederatedThreadLinks(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(
      `[backfillFederatedThreadLinks] connected to MongoDB (${dbName}); DRY_RUN=${DRY_RUN}, BACKFILL_ANCESTORS=${BACKFILL_ANCESTORS}`,
    );

    // Orphans: a federated reply (has federation.inReplyTo) that was never linked
    // (no parentPostId). The filter set only ever SHRINKS as we set parentPostId,
    // so the ascending `_id` cursor never revisits a linked post.
    const baseFilter: Record<string, unknown> = {
      'federation.inReplyTo': { $exists: true, $ne: null },
      parentPostId: null,
    };

    const totalCount = await Post.countDocuments(baseFilter);
    logger.info(`[backfillFederatedThreadLinks] ${totalCount} orphan federated replies to scan`);

    if (totalCount === 0) {
      logger.info('[backfillFederatedThreadLinks] nothing to do');
      return;
    }

    let scanned = 0;
    let linked = 0;
    let unresolved = 0;
    let malformed = 0;
    let lastId: mongoose.Types.ObjectId | null = null;
    let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

    const flush = async (): Promise<void> => {
      if (pendingOps.length === 0 || DRY_RUN) {
        pendingOps = [];
        return;
      }
      await Post.bulkWrite(pendingOps, { ordered: false });
      pendingOps = [];
    };

    for (;;) {
      const pageFilter: Record<string, unknown> = { ...baseFilter };
      if (lastId) {
        pageFilter._id = { $gt: lastId };
      }

      const page = await Post.find(pageFilter, { _id: 1, 'federation.inReplyTo': 1 })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<OrphanReplyRow[]>();

      if (page.length === 0) break;

      for (const post of page) {
        const inReplyToUri = extractInReplyToUri(post.federation?.inReplyTo);
        if (!inReplyToUri) {
          malformed += 1;
          continue;
        }

        const link = await outboxSyncService.ensureFederatedReplyLink(inReplyToUri, {
          allowBackfill: BACKFILL_ANCESTORS,
        });
        if (!link) {
          unresolved += 1;
          continue;
        }

        linked += 1;
        pendingOps.push({
          updateOne: {
            filter: { _id: post._id },
            update: {
              $set: {
                parentPostId: link.parentPostId,
                threadId: link.threadId,
              },
            },
          },
        });

        if (pendingOps.length >= BULK_CHUNK_SIZE) {
          await flush();
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1]._id;
      logger.info(
        `[backfillFederatedThreadLinks] progress: scanned ${scanned}/${totalCount}, linked ${linked}, unresolved ${unresolved}, malformed ${malformed}`,
      );
    }

    await flush();

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedThreadLinks] done${DRY_RUN ? ' (DRY_RUN — no writes)' : ''}: scanned ${scanned}, linked ${linked}, unresolved ${unresolved}, malformed ${malformed} (${elapsedSeconds}s)`,
    );

  } catch (error) {
    logger.error('[backfillFederatedThreadLinks] failed', error);
    throw error;
  } finally {
    await mongoose.disconnect().catch((disconnectError) => {
      logger.warn('[backfillFederatedThreadLinks] error during mongoose.disconnect()', disconnectError);
    });
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (the Redis client and BullMQ
  // handles pulled in through the outbox service) keep the event loop alive, so
  // the Fargate one-shot would sit RUNNING forever after the work completed.
  // Mirrors recomputeFederatedEngagement.
  backfillFederatedThreadLinks()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillFederatedThreadLinks] unhandled failure', error);
      process.exit(1);
    });
}

export default backfillFederatedThreadLinks;
