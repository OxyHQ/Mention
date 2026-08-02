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
 * `NODE_ENV=production` is mandatory or it silently reads `mention-development`.
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { baselineContentClassifier, BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import { logger } from '../utils/logger';

/**
 * Default window. Twice the trending window, so a batch computed moments after
 * this finishes sees re-derived terms for every post it can count — and the
 * margin covers a post whose remote timestamp precedes its arrival.
 */
const DEFAULT_HOURS = 48;

/** Posts read per page. Bulk cursor, no per-document query — safe over a tunnel. */
const PAGE_SIZE = 500;

/** Bulk writes flushed per round trip. */
const BULK_CHUNK = 500;

interface PostRow {
  _id: mongoose.Types.ObjectId;
  hashtags?: string[];
  content?: { variants?: Array<{ text?: string }> };
  postClassification?: { version?: number; trendTerms?: string[] };
}

function parseHours(): number {
  const flag = process.argv.find((arg) => arg.startsWith('--hours='));
  const parsed = flag ? Number(flag.slice('--hours='.length)) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOURS;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const hours = parseHours();
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/mention', {
    dbName: `mention-${process.env.NODE_ENV || 'development'}`,
  });
  logger.info('[rebaselineTrendTerms] started', { hours, dryRun, version: BASELINE_CLASSIFIER_VERSION });

  let lastId: mongoose.Types.ObjectId | undefined;
  let scanned = 0;
  let updated = 0;
  let pending: mongoose.AnyBulkWriteOperation[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0 || dryRun) {
      pending = [];
      return;
    }
    await Post.bulkWrite(pending, { ordered: false });
    pending = [];
  };

  for (;;) {
    const page = await Post.find(
      {
        createdAt: { $gte: since },
        ...(lastId ? { _id: { $gt: lastId } } : {}),
      },
      {
        hashtags: 1,
        'content.variants.text': 1,
        'postClassification.version': 1,
        'postClassification.trendTerms': 1,
      },
    )
      .sort({ _id: 1 })
      .limit(PAGE_SIZE)
      .lean<PostRow[]>();

    if (page.length === 0) break;

    for (const post of page) {
      scanned += 1;
      // The PRIMARY rendition — the author's own words, the same text ingest
      // classifies. A machine translation would re-derive terms from a
      // translator's word choices.
      const text = post.content?.variants?.[0]?.text ?? '';
      const signals = baselineContentClassifier.classify({ text, hashtags: post.hashtags });

      // Skip a post whose terms are already what the current rules produce:
      // most of a 48-hour window is untouched by any given rule change, and a
      // no-op write is still a write.
      const current = post.postClassification?.trendTerms ?? [];
      if (
        post.postClassification?.version === BASELINE_CLASSIFIER_VERSION &&
        current.length === signals.trendTerms.length &&
        current.every((term, index) => term === signals.trendTerms[index])
      ) {
        continue;
      }

      updated += 1;
      pending.push({
        updateOne: {
          filter: { _id: post._id },
          update: {
            $set: {
              'postClassification.trendTerms': signals.trendTerms,
              'postClassification.version': BASELINE_CLASSIFIER_VERSION,
            },
          },
        },
      });
      if (pending.length >= BULK_CHUNK) await flush();
    }

    lastId = page[page.length - 1]._id;
    logger.info('[rebaselineTrendTerms] progress', { scanned, updated });
  }

  await flush();
  logger.info('[rebaselineTrendTerms] done', { scanned, updated, dryRun });

  // One-shot scripts MUST disconnect and exit: imported singletons otherwise
  // keep a Fargate task alive forever. See AGENTS.md § one-shot scripts.
  await mongoose.disconnect();
  process.exit(0);
}

main().catch((error) => {
  logger.error('[rebaselineTrendTerms] failed', error);
  process.exit(1);
});
