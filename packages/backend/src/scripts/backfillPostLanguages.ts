/**
 * One-shot corpus backfill: derive `postClassification.languages` (+ the
 * top-level primary `post.language`) for posts that predate multi-language
 * classification.
 *
 * Language-based feed filtering/recommendation reads the canonical
 * `postClassification.languages` array. Posts created before v4 of the Stage-A
 * baseline (or before the multi-language field existed) either lack that array or
 * carry a stale `postClassification.version`, so they never match a viewer's
 * language preference. This re-runs the deterministic {@link baselineContentClassifier}
 * over those posts and writes the derived array + primary.
 *
 * It re-derives from the post's own `content.text` / `hashtags` (NOT the stored
 * `post.language`, which used to be defaulted to `'en'` — reusing it would
 * propagate that bad default). Posts whose text is too short/undetectable are
 * left untouched rather than fabricating a language.
 *
 * Idempotent (writing the array + current version removes a post from the
 * selection filter, so a re-run only fills gaps), batched via a stable ascending
 * `_id` page cursor, and fail-soft (a single post's classify failure is logged at
 * warn and skipped — never aborts the run). Supports `--dry-run` (report what it
 * would update, write nothing).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillPostLanguages.js
 *   bun packages/backend/dist/src/scripts/backfillPostLanguages.js --dry-run
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { baselineContentClassifier, BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import { logger } from '../utils/logger';

/** Posts scanned per page (stable ascending `_id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

/** Update writes flushed per bulkWrite chunk. */
const BULK_CHUNK_SIZE = 500;

export interface BackfillPostLanguagesResult {
  scanned: number;
  updated: number;
}

/** Minimal projected shape the classifier needs. */
interface PostLanguageRow {
  _id: mongoose.Types.ObjectId;
  content?: { text?: string };
  hashtags?: string[];
  federation?: { sensitive?: boolean } | null;
}

/**
 * Re-classify and backfill languages over the qualifying corpus. Operates on the
 * `Post` model only — the caller owns the Mongo connection lifecycle — so it is
 * unit-testable with a mocked model and reusable from an in-process caller.
 */
export async function backfillPostLanguages(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillPostLanguagesResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;

  // Posts whose canonical multi-language array is absent/empty, or that were
  // classified before the current baseline version. Setting the array + version
  // removes a post from this filter, so the ascending `_id` cursor never revisits
  // a completed post and a re-run only fills remaining gaps.
  const baseFilter: Record<string, unknown> = {
    $or: [
      { 'postClassification.languages': { $in: [null, []] } },
      { 'postClassification.languages': { $exists: false } },
      { 'postClassification.version': { $lt: BASELINE_CLASSIFIER_VERSION } },
    ],
  };

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

  for (;;) {
    const pageFilter: Record<string, unknown> = { ...baseFilter };
    if (lastId) {
      pageFilter._id = { $gt: lastId };
    }

    const page = await Post.find(pageFilter, {
      _id: 1,
      'content.text': 1,
      hashtags: 1,
      federation: 1,
    })
      .sort({ _id: 1 })
      .limit(pageSize)
      .lean<PostLanguageRow[]>();

    if (page.length === 0) break;

    for (const post of page) {
      scanned += 1;
      try {
        const signals = baselineContentClassifier.classify({
          text: post.content?.text,
          hashtags: post.hashtags,
          sensitive: post.federation?.sensitive,
          isFederated: post.federation != null,
        });
        // No derivable language (too short / undetectable): leave it for a later
        // run rather than fabricating one. Never write an empty array.
        if (signals.languages.length === 0) continue;

        updated += 1;
        if (dryRun) continue;

        pendingOps.push({
          updateOne: {
            filter: { _id: post._id },
            update: {
              $set: {
                'postClassification.languages': signals.languages,
                'postClassification.version': signals.version,
                language: signals.languages[0],
              },
            },
          },
        });

        if (pendingOps.length >= BULK_CHUNK_SIZE) {
          await flush();
        }
      } catch (error) {
        logger.warn('[backfillPostLanguages] classify failed for post; skipping', {
          id: String(post._id),
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1]._id;
    logger.info(`[backfillPostLanguages] progress: scanned ${scanned}, updated ${updated}`);
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
    logger.info(`[backfillPostLanguages] connected to MongoDB (${dbName}); DRY_RUN=${dryRun}`);

    const result = await backfillPostLanguages({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillPostLanguages] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[backfillPostLanguages] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
