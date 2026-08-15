/**
 * Re-derive `postClassification.trendTerms` for a recent window of posts.
 *
 * Extraction runs once, when a post arrives, so a change to what counts as a
 * term reaches only posts written after it deploys — and trending measures a
 * trailing window, so the OLD rules keep deciding the list for as long as that
 * window holds pre-change posts. A day of a visibly wrong list is not an
 * acceptable price for improving the rules, and the alternative that was
 * reached for instead — adding the leaked words to a stop-word list so the
 * detection-time filter removes them immediately — is a bridge that has to be
 * rebuilt every time a new word leaks, in a language somebody happens to have
 * listed. The network's own posts carry `ru`, `zh` and `pl`, which no list
 * here covers.
 *
 * This is the honest bridge: apply the CURRENT rules to the window that is
 * currently being measured, once, and let the extractor be the only authority
 * on what a term is.
 *
 * Read-modify-write, and deliberately NOT guarded by
 * `assertAdminMutationAllowed`: it writes one derived field, computed by a pure
 * function, from data already on the post. Re-running it is idempotent, and
 * running it by mistake costs a re-derivation of a field the ingest path
 * rewrites anyway.
 *
 *   bun packages/backend/dist/src/scripts/rebaselineTrendTerms.js [--hours=48] [--dry-run]
 *
 * ## The window is `created_at`; the cursor is NOT
 *
 * Paging is a keyset over `id`, which is `text` holding an ObjectId hex for a
 * pre-cutover row and a uuid v7 after it (`@oxyhq/db`) — a total order, but NOT
 * a chronological one, so it cannot stand in for the window. The
 * `created_at >= since` term is therefore carried in the filter on every page
 * rather than expressed as a cursor bound, which is what keeps a backfilled
 * post (old `created_at`, new id) inside the window it belongs to.
 */

import { and, asc, gt, gte, type SQL } from 'drizzle-orm';
import { resolveVariant } from '../services/postVariants';
import { connectPostgres } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { findPostRecords, updatePostRecord } from '../db/posts/postRepository';
import { baselineContentClassifier, BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';

/**
 * Default window. Twice the trending window, so a batch computed moments after
 * this finishes sees re-derived terms for every post it can count — and the
 * margin covers a post whose remote timestamp precedes its arrival.
 */
const DEFAULT_HOURS = 48;

/** Posts read per page (stable ascending `id` cursor pagination). */
const PAGE_SIZE = 500;

export interface RebaselineTrendTermsResult {
  scanned: number;
  updated: number;
}

function parseHours(): number {
  const flag = process.argv.find((arg) => arg.startsWith('--hours='));
  const parsed = flag ? Number(flag.slice('--hours='.length)) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOURS;
}

/**
 * Re-derive trend terms over the window. The caller owns the connection
 * lifecycle, so this is reusable from an in-process caller.
 */
export async function rebaselineTrendTerms(
  opts: { hours?: number; batchSize?: number; dryRun?: boolean } = {},
): Promise<RebaselineTrendTermsResult> {
  const pageSize = opts.batchSize ?? PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;
  const hours = opts.hours ?? DEFAULT_HOURS;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const windowFilter = gte(posts.createdAt, since) as SQL;

  let scanned = 0;
  let updated = 0;
  let lastId: string | null = null;

  for (;;) {
    const page = await findPostRecords(
      lastId ? and(windowFilter, gt(posts.id, lastId)) : windowFilter,
      { orderBy: [asc(posts.id)], limit: pageSize },
    );

    if (page.length === 0) break;

    for (const post of page) {
      scanned += 1;
      // The PRIMARY rendition — the author's own words, the same text ingest
      // classifies. A machine translation would re-derive terms from a
      // translator's word choices.
      const signals = baselineContentClassifier.classify({
        text: resolveVariant(post.content).text,
        hashtags: post.hashtags,
      });

      // Skip a post whose terms are already what the current rules produce:
      // most of a 48-hour window is untouched by any given rule change, and a
      // no-op write is still a write.
      const current = post.postClassification?.trendTerms ?? [];
      if (
        post.postClassification?.version === BASELINE_CLASSIFIER_VERSION
        && current.length === signals.trendTerms.length
        && current.every((term, index) => term === signals.trendTerms[index])
      ) {
        continue;
      }

      updated += 1;
      if (dryRun) continue;

      // A per-post PARTIAL patch, not a batched whole-column write: the
      // classification fields are a MERGE onto the existing subdocument, and
      // rewriting the column would destroy every sibling signal (languages,
      // topics, the quality/spam scores) this script never computed.
      await updatePostRecord(post.id, {
        postClassification: {
          trendTerms: signals.trendTerms,
          version: BASELINE_CLASSIFIER_VERSION,
        },
      });
    }

    lastId = page[page.length - 1].id;
    logger.info('[rebaselineTrendTerms] progress', { scanned, updated });
  }

  return { scanned, updated };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const hours = parseHours();

  try {
    await connectPostgres();
    logger.info('[rebaselineTrendTerms] started', {
      hours,
      dryRun,
      version: BASELINE_CLASSIFIER_VERSION,
    });

    const result = await rebaselineTrendTerms({ hours, dryRun });
    logger.info('[rebaselineTrendTerms] done', { ...result, dryRun });
  } catch (error) {
    logger.error('[rebaselineTrendTerms] failed', error);
    throw error;
  } finally {
    // One-shot scripts MUST release their resources and exit: imported
    // singletons otherwise keep a Fargate task alive forever.
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[rebaselineTrendTerms] unhandled failure', error);
      process.exit(1);
    });
}
