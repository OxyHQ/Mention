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
 *
 * Safety controls (env vars, read once at start):
 *   - `DRY_RUN` (`'true'`/`'1'`): perform the full read-only scan + remote
 *     re-fetch + drift comparison, but write NOTHING. Each post that WOULD be
 *     corrected is logged (`_id`, type, stored createdAt → resolved published);
 *     the summary reports `wouldCorrect` and states nothing was written.
 *   - `BACKFILL_LIMIT` (optional positive integer): stop after SCANNING that
 *     many federated posts (canary cap). Non-numeric / ≤0 values are ignored.
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

/**
 * Resolved, validated run-mode controls read once from the environment at start.
 * `dryRun` performs the full read-only scan (remote re-fetch + drift comparison)
 * but writes nothing. `limit` caps the number of federated posts SCANNED (canary).
 */
interface RunOptions {
  dryRun: boolean;
  limit: number | null;
}

/**
 * `DRY_RUN` is truthy when set to `'true'` or `'1'` (case-insensitive, trimmed).
 * Anything else (unset, `'false'`, `'0'`, empty) means a real, writing run.
 */
export function parseDryRun(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

/**
 * `BACKFILL_LIMIT` is an optional positive integer scan cap. Non-numeric, ≤0, or
 * non-integer values are ignored (treated as no limit).
 */
export function parseLimit(raw: string | undefined): number | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

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

  const options: RunOptions = {
    dryRun: parseDryRun(process.env.DRY_RUN),
    limit: parseLimit(process.env.BACKFILL_LIMIT),
  };

  logger.info(
    `[backfillFederatedPublishedDate] mode: ${options.dryRun ? 'DRY RUN (read-only, no writes)' : 'LIVE (writes enabled)'}; ` +
      `scan limit: ${options.limit === null ? 'none (full scan)' : String(options.limit)}`,
  );

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
    // In a live run this counts posts whose date we rewrote; in a dry run it stays
    // 0 and `wouldCorrect` carries the count of posts that WOULD be rewritten.
    let corrected = 0;
    let wouldCorrect = 0;
    let skipped = 0;
    let lastId: mongoose.Types.ObjectId | null = null;

    for (;;) {
      if (options.limit !== null && scanned >= options.limit) break;

      const pageFilter: Record<string, unknown> = {
        'federation.activityId': { $exists: true, $ne: null },
      };
      if (lastId) {
        pageFilter._id = { $gt: lastId };
      }

      // Cap the page so we never fetch a full extra page beyond the scan limit.
      const pageLimit = options.limit !== null
        ? Math.min(PAGE_SIZE, options.limit - scanned)
        : PAGE_SIZE;

      const page = await Post.find(pageFilter, { _id: 1, type: 1, createdAt: 1, 'federation.activityId': 1 })
        .sort({ _id: 1 })
        .limit(pageLimit)
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

          if (options.dryRun) {
            // Read-only: report what WOULD change without touching the document.
            const storedIso = row.createdAt ? row.createdAt.toISOString() : 'unknown';
            logger.info(
              `[backfillFederatedPublishedDate] would correct ${row._id.toString()} ` +
                `(type=${row.type ?? 'unknown'}): createdAt ${storedIso} → published ${original.toISOString()}`,
            );
            wouldCorrect++;
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
        options.dryRun
          ? `[backfillFederatedPublishedDate] progress: scanned ${scanned}/${totalCount}, wouldCorrect ${wouldCorrect}, skipped ${skipped}`
          : `[backfillFederatedPublishedDate] progress: scanned ${scanned}/${totalCount}, corrected ${corrected}, skipped ${skipped}`,
      );
    }

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      options.dryRun
        ? `[backfillFederatedPublishedDate] DRY RUN done: scanned ${scanned}, wouldCorrect ${wouldCorrect}, skipped ${skipped} — NOTHING was written (${elapsedSeconds}s)`
        : `[backfillFederatedPublishedDate] done: scanned ${scanned}, corrected ${corrected}, skipped ${skipped} (${elapsedSeconds}s)`,
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
