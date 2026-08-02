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
 * selection filter, so a re-run only fills gaps) and batched via a stable
 * ascending `_id` page cursor. A single post's classify failure is isolated so
 * the scan can finish, but the completed run exits non-zero rather than reporting
 * a partial backfill as successful. Supports `--dry-run` (report what it would
 * update, write nothing).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillPostLanguages.js
 *   bun packages/backend/dist/src/scripts/backfillPostLanguages.js --dry-run
 */

import { and, asc, gt, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { resolveVariant } from '../services/postVariants';
import { connectPostgres } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { findPostRecords, updatePostRecord } from '../db/posts/postRepository';
import { baselineContentClassifier, BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import { logger } from '../utils/logger';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

/** Posts scanned per page (stable ascending `id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

export interface BackfillPostLanguagesResult {
  scanned: number;
  updated: number;
  failed: number;
}

/**
 * Re-classify and backfill languages over the qualifying corpus. The caller owns
 * the connection lifecycle, so this is reusable from an in-process caller.
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
  // A NULL `classification_version` is one of the qualifying states and must be
  // spelled out: `version < N` is NULL for an unstamped row, and a NULL predicate
  // excludes the row — so the literal translation would silently skip exactly the
  // posts that were never classified at all.
  const baseFilter = or(
    isNull(posts.classificationLanguages),
    sql`cardinality(${posts.classificationLanguages}) = 0`,
    isNull(posts.classificationVersion),
    lt(posts.classificationVersion, BASELINE_CLASSIFIER_VERSION),
  ) as SQL;

  let scanned = 0;
  let updated = 0;
  let failed = 0;
  let lastId: string | null = null;

  for (;;) {
    const page = await findPostRecords(
      lastId ? and(baseFilter, gt(posts.id, lastId)) : baseFilter,
      { orderBy: [asc(posts.id)], limit: pageSize },
    );

    if (page.length === 0) break;

    for (const post of page) {
      scanned += 1;
      try {
        const signals = baselineContentClassifier.classify({
          // The PRIMARY rendition — the author's own words. Detecting a language
          // from a machine translation would just re-derive the language we asked
          // the translator for.
          text: resolveVariant(post.content).text,
          hashtags: post.hashtags,
          sensitive: post.federation?.sensitive,
          isFederated: post.federation != null,
        });
        // No derivable language (too short / undetectable): leave it for a later
        // run rather than fabricating one. Never write an empty array.
        if (signals.languages.length === 0) continue;

        updated += 1;
        if (dryRun) continue;

        // A per-post PARTIAL patch rather than a batched bulkWrite: the two
        // classification fields are a MERGE onto the existing subdocument, which
        // is what `updatePostRecord` expresses and what a whole-column write
        // would destroy. The page size still bounds the work per round.
        await updatePostRecord(post.id, {
          postClassification: {
            languages: signals.languages,
            version: signals.version,
          },
          language: signals.languages[0],
        });
      } catch (error) {
        failed += 1;
        logger.warn('[backfillPostLanguages] classify failed for post; skipping', {
          id: post.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1].id;
    logger.info(
      `[backfillPostLanguages] progress: scanned ${scanned}, updated ${updated}, failed ${failed}`,
    );
  }

  return { scanned, updated, failed };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const dryRun = process.argv.includes('--dry-run');

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillPostLanguages',
      dryRun,
    });
    await connectPostgres();
    logger.info('[backfillPostLanguages] connected to PostgreSQL', { dryRun });

    const result = await backfillPostLanguages({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillPostLanguages] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated}, failed ${result.failed} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete('backfillPostLanguages', {
      failed: result.failed,
    });
  } catch (error) {
    logger.error('[backfillPostLanguages] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillPostLanguages] unhandled failure', error);
      process.exit(1);
    });
}
