/**
 * One-shot reconciliation: restore the ORIGINAL publish date on federated posts
 * that were stored with the SYNC time instead of their ActivityPub `published`.
 *
 * Background: the inbox-push ingest path (`handleCreate`) historically did not
 * thread the AP `published` value into the new post, so real-time federated
 * posts got `createdAt = now()` (the moment our inbox received them) rather than
 * the date the author actually published them. The outbox-backfill path already
 * preserved `published`. The ingest fix lands going forward; this script repairs
 * the posts already stored with the wrong date.
 *
 * Strategy: for each federated post (carrying a `federation.activityId`), re-fetch
 * its remote AP object — the Note/Article by `federation.activityId` for normal
 * posts, or the Announce activity for boosts (`type: 'boost'`) — read `published`,
 * and, when it differs from the stored `createdAt` by more than a small tolerance,
 * write the original date back.
 *
 * The write uses the RAW collection (`Post.collection.updateOne`) so it bypasses
 * Mongoose's `timestamps` plugin: we set BOTH `createdAt` and `updatedAt` to the
 * original date without the plugin clobbering `updatedAt` to now.
 *
 * Idempotent (re-running over already-correct posts is a no-op), batched via a
 * stable ascending `_id` cursor, bounded remote concurrency, and logs progress
 * plus a final summary. Remote-fetch failures are skipped (logged) so one dead
 * instance never aborts the run.
 *
 * Runnable as a Fargate one-shot (same pattern as recomputeFederatedEngagement):
 *   bun packages/backend/dist/src/scripts/backfillFederatedPublishedDate.js
 *
 * Requires the federation service credential (`OXY_SERVICE_API_KEY/SECRET`) so
 * `signedFetch` can sign outbound GETs to authorized-fetch instances.
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';
import { AP_CONTENT_TYPE } from '../utils/federation/constants';
import { signedFetch, parseApPublished } from '../services/federation/sharedFederationHelpers';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Concurrent remote AP fetches per page (keep remote fan-out small). */
const FETCH_CONCURRENCY = 4;

/**
 * Minimum difference between the stored `createdAt` and the original `published`
 * before we rewrite it. Guards against churn from sub-second timestamp rounding.
 */
const DATE_DRIFT_TOLERANCE_MS = 1000;

interface FederatedPostRow {
  _id: mongoose.Types.ObjectId;
  type?: string;
  createdAt?: Date;
  federation?: { activityId?: string };
}

/**
 * Resolve the ORIGINAL publish date for a stored federated post by re-fetching
 * its remote AP object. For a boost the activity id is the Announce (whose
 * `published` is when the boost happened); for a normal post it is the Note.
 * Returns `undefined` when the object can't be fetched or carries no valid date.
 */
async function fetchOriginalPublished(row: FederatedPostRow): Promise<Date | undefined> {
  const objectUri = row.federation?.activityId;
  if (!objectUri || typeof objectUri !== 'string') return undefined;

  try {
    const res = await signedFetch(objectUri, AP_CONTENT_TYPE);
    if (!res.ok) {
      logger.debug(`[backfillFederatedPublishedDate] fetch ${objectUri} → ${res.status}; skipping`);
      return undefined;
    }
    const object = (await res.json()) as Record<string, unknown>;
    // Normal posts carry `published` directly. An Announce activity (boost) does
    // too; some servers wrap the Note under `object` — fall back to that.
    const direct = parseApPublished(object.published);
    if (direct) return direct;
    const nested = (object.object && typeof object.object === 'object')
      ? (object.object as Record<string, unknown>).published
      : undefined;
    return parseApPublished(nested);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug(`[backfillFederatedPublishedDate] error fetching ${objectUri}: ${message}; skipping`);
    return undefined;
  }
}

async function backfillFederatedPublishedDate(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[backfillFederatedPublishedDate] connected to MongoDB (${dbName})`);

    const totalCount = await Post.countDocuments({
      'federation.activityId': { $exists: true, $ne: null },
    });
    logger.info(`[backfillFederatedPublishedDate] ${totalCount} federated posts to scan`);

    if (totalCount === 0) {
      logger.info('[backfillFederatedPublishedDate] nothing to do');
      await mongoose.disconnect();
      return;
    }

    let scanned = 0;
    let corrected = 0;
    let skipped = 0;
    let lastId: mongoose.Types.ObjectId | null = null;

    for (;;) {
      const pageFilter: Record<string, unknown> = {
        'federation.activityId': { $exists: true, $ne: null },
      };
      if (lastId) {
        pageFilter._id = { $gt: lastId };
      }

      const page = await Post.find(pageFilter, { _id: 1, type: 1, createdAt: 1, 'federation.activityId': 1 })
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<FederatedPostRow[]>();

      if (page.length === 0) break;

      for (let i = 0; i < page.length; i += FETCH_CONCURRENCY) {
        const batch = page.slice(i, i + FETCH_CONCURRENCY);
        const originals = await Promise.all(batch.map(fetchOriginalPublished));

        for (let j = 0; j < batch.length; j++) {
          const row = batch[j];
          const original = originals[j];
          if (!original) {
            skipped++;
            continue;
          }

          const stored = row.createdAt ? row.createdAt.getTime() : undefined;
          if (stored != null && Math.abs(stored - original.getTime()) <= DATE_DRIFT_TOLERANCE_MS) {
            // Already correct — idempotent no-op.
            continue;
          }

          // Raw collection write bypasses the Mongoose timestamps plugin so we
          // can set BOTH createdAt and updatedAt to the original date without the
          // plugin overwriting updatedAt with the current time.
          await Post.collection.updateOne(
            { _id: row._id },
            { $set: { createdAt: original, updatedAt: original } },
          );
          corrected++;
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1]._id;
      logger.info(
        `[backfillFederatedPublishedDate] progress: scanned ${scanned}/${totalCount}, corrected ${corrected}, skipped ${skipped}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillFederatedPublishedDate] done: scanned ${scanned}, corrected ${corrected}, skipped ${skipped} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[backfillFederatedPublishedDate] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  backfillFederatedPublishedDate();
}

export default backfillFederatedPublishedDate;
