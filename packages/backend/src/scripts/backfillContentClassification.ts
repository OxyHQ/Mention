/**
 * One-shot backfill: populate the Stage-A deterministic content-classification
 * fields on existing posts that predate the unified classification wiring (P2).
 *
 * Stage A is the cheap, synchronous, side-effect-free baseline that now runs on
 * EVERY post at ingest (native + federated) via {@link BaselineContentClassifier}:
 *   - languages (ALL detected ISO 639-1, multi-language, primary first) —
 *     re-derived from stored text (the AP `contentMap` declared set is only
 *     available at ingest, so backfill re-detects from text); the resolved
 *     primary (`languages[0]`) is mirrored to the top-level AP `post.language`,
 *   - region (best-effort, from a federated instance domain),
 *   - hashtagsNorm (canonical, alias-mapped),
 *   - topics (rule-based),
 *   - sensitive (pass-through of the stored sensitive flag),
 *   - version (the deterministic ruleset version).
 *
 * Posts created before P2 only carry the AI/legacy fields (or a bare `pending`
 * subdoc), so this script recomputes the deterministic baseline from each post's
 * STORED state and `$set`s ONLY the Stage-A fields (plus a `$unset` of the
 * removed single `postClassification.language` so the corpus fully migrates to
 * the multi-language `postClassification.languages` with no stale data). It
 * deliberately does NOT touch the AI lifecycle fields (`status`, `attempts`,
 * `scores`, `sentiment`, `intent`, `confidence`) — the async
 * {@link PostClassificationService} owns those. A post still queued as `pending`
 * stays `pending`; a post already `classified` keeps its AI enrichment AND gains
 * the deterministic baseline.
 *
 * Properties:
 *   - Idempotent: a post already carrying the current `version` is skipped, so
 *     re-running is a no-op. Bump {@link BASELINE_CLASSIFIER_VERSION} to force a
 *     re-baseline of the whole corpus.
 *   - Resumable + bounded: pages by ascending `_id` (cursor pagination) with a
 *     fixed page size and flushes writes in bounded bulk chunks.
 *   - Best-effort per post: a classifier throw on one post is caught + logged at
 *     warn and the scan continues (the classifier is pure/synchronous so this is
 *     defensive only).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillContentClassification.js
 */

import mongoose from 'mongoose';
import { Post, IPost } from '../models/Post';
import { logger } from '../utils/logger';
import {
  baselineContentClassifier,
  BASELINE_CLASSIFIER_VERSION,
} from '../services/BaselineContentClassifier';
import { getRemoteHost } from '../services/federation/sharedFederationHelpers';

/** Posts scanned per page (stable `_id` cursor pagination). */
const PAGE_SIZE = 500;

/** Stage-A field writes flushed per bulkWrite chunk. */
const BULK_CHUNK_SIZE = 500;

/**
 * Projection of only the inputs the deterministic baseline needs. We also pull
 * `postClassification.status` so the backfill can AVOID overwriting AI scores on
 * a post that already reached `classified` (the AI scores are higher fidelity).
 */
const BACKFILL_PROJECTION: mongoose.ProjectionType<IPost> = {
  _id: 1,
  hashtags: 1,
  'content.text': 1,
  federation: 1,
  'metadata.isSensitive': 1,
  'postClassification.version': 1,
  'postClassification.status': 1,
};

/**
 * Minimal projection pulled for each post. Only the inputs the deterministic
 * baseline needs (no AI fields) plus the federation metadata for region/sensitive.
 */
export interface BackfillPostRow {
  _id: mongoose.Types.ObjectId;
  hashtags?: string[];
  content?: { text?: string };
  federation?: { activityId?: string; sensitive?: boolean; url?: string };
  metadata?: { isSensitive?: boolean };
  postClassification?: { version?: number; status?: string };
}

/**
 * Posts needing a baseline: the Stage-A `version` is missing or older than the
 * current ruleset. Posts already at the current version are skipped (idempotent).
 *
 * Exported for unit testing the idempotency contract.
 */
export function buildPageFilter(lastId: mongoose.Types.ObjectId | null): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    $or: [
      { 'postClassification.version': { $exists: false } },
      { 'postClassification.version': { $lt: BASELINE_CLASSIFIER_VERSION } },
    ],
  };
  if (lastId) {
    filter._id = { $gt: lastId };
  }
  return filter;
}

/**
 * Build the Mongo update document (`{ $set, $unset }`) for a single post's
 * Stage-A fields from its STORED state. Returns null when the classifier throws
 * (defensive) so the caller can skip it.
 *
 * Exported for unit testing. The `$set` writes ONLY the Stage-A fields — never
 * the AI lifecycle fields (status/attempts/scores/sentiment/intent/confidence).
 * The `$unset` migrates off the removed single `postClassification.language` so
 * no stale data lingers after the corpus moves to multi-language.
 */
export function buildBaselineUpdate(
  post: BackfillPostRow,
): { $set: Record<string, unknown>; $unset: Record<string, unknown> } | null {
  try {
    const isFederated = post.federation?.activityId != null;
    const sensitive = post.federation?.sensitive ?? post.metadata?.isSensitive;
    // The remote instance host comes from the stored federation URI (the post's
    // remote `url`, falling back to its `activityId`); both are absolute URLs to
    // the origin instance.
    const federationUri = post.federation?.url ?? post.federation?.activityId;
    const instanceDomain = isFederated && federationUri ? getRemoteHost(federationUri) : undefined;
    // Re-derive language(s) from the stored text rather than trusting the
    // top-level `post.language`: that column carries the schema default `'en'` for
    // every post created before the AP-language wiring, so it is not a reliable
    // explicit signal. Letting the classifier detect from text yields the real
    // language(s) and leaves the set empty for undetectable text. (The AP
    // `contentMap` declared set is only available at ingest, not on stored docs.)
    const signals = baselineContentClassifier.classify({
      text: post.content?.text,
      hashtags: post.hashtags,
      sensitive,
      isFederated,
      instanceDomain,
    });

    // Set ONLY the Stage-A fields. Never touch the AI LIFECYCLE fields
    // (status/attempts/sentiment/intent/confidence) — the async batch owns those.
    // `topics` is shared, but Stage A only seeds it; the AI batch overwrites it on
    // classification, so writing the rule-based topics here is additive for
    // not-yet-classified posts and harmless for classified ones. The classification
    // subdoc carries ONLY the multi-language `languages` array; the resolved
    // primary (`languages[0]`) is mirrored to the top-level AP `post.language`.
    const set: Record<string, unknown> = {
      'postClassification.topics': signals.topics,
      'postClassification.languages': signals.languages,
      'postClassification.region': signals.region,
      'postClassification.hashtagsNorm': signals.hashtagsNorm,
      'postClassification.sensitive': signals.sensitive,
      'postClassification.version': signals.version,
    };
    const primaryLanguage = signals.languages[0];
    if (primaryLanguage != null) {
      set.language = primaryLanguage;
    }

    // Deterministic spam/quality/toxicity scores: write them ONLY when the post
    // has NOT already been AI-classified. An AI-classified post carries
    // higher-fidelity scores we must not clobber with the deterministic baseline.
    // For every other status (pending/baseline/failed/missing) the baseline
    // scores are what ranking will honor until the AI batch (if ever) enriches it.
    if (post.postClassification?.status !== 'classified') {
      set['postClassification.scores'] = signals.scores;
    }

    // Migrate off the removed single classification-language field — fully drop
    // the stale value so only `postClassification.languages` remains.
    const unset: Record<string, unknown> = {
      'postClassification.language': '',
    };

    return { $set: set, $unset: unset };
  } catch (error) {
    logger.warn(`[backfillContentClassification] classify failed for ${post._id.toString()}; skipping`, error);
    return null;
  }
}

async function backfillContentClassification(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;

  try {
    await mongoose.connect(mongoUri, { dbName });
    logger.info(`[backfillContentClassification] connected to MongoDB (${dbName})`);

    const totalCount = await Post.countDocuments(buildPageFilter(null));
    logger.info(
      `[backfillContentClassification] ${totalCount} posts to baseline (version < ${BASELINE_CLASSIFIER_VERSION})`,
    );

    if (totalCount === 0) {
      logger.info('[backfillContentClassification] nothing to do');
      await mongoose.disconnect();
      return;
    }

    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    let lastId: mongoose.Types.ObjectId | null = null;
    let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

    const flush = async (): Promise<void> => {
      if (pendingOps.length === 0) return;
      const result = await Post.bulkWrite(pendingOps, { ordered: false });
      updated += result.modifiedCount;
      pendingOps = [];
    };

    // Stable cursor: page by ascending _id. Each page re-applies the version
    // filter, so a post updated to the current version in an earlier page drops
    // out of subsequent pages naturally (the cursor only ever advances).
    for (;;) {
      const page: BackfillPostRow[] = await Post.find(buildPageFilter(lastId), BACKFILL_PROJECTION)
        .sort({ _id: 1 })
        .limit(PAGE_SIZE)
        .lean<BackfillPostRow[]>();

      if (page.length === 0) break;

      for (const post of page) {
        const update = buildBaselineUpdate(post);
        if (!update) {
          skipped += 1;
          continue;
        }
        pendingOps.push({
          updateOne: {
            filter: { _id: post._id },
            update,
          },
        });

        if (pendingOps.length >= BULK_CHUNK_SIZE) {
          await flush();
        }
      }

      scanned += page.length;
      lastId = page[page.length - 1]._id;
      logger.info(
        `[backfillContentClassification] progress: scanned ${scanned}/${totalCount}, updated ${updated}, skipped ${skipped}`,
      );
    }

    await flush();

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillContentClassification] done: scanned ${scanned}, updated ${updated}, skipped ${skipped} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
  } catch (error) {
    logger.error('[backfillContentClassification] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  // Run as a one-shot and force a clean self-termination. The Post model import
  // can transitively open Redis/other handles that keep the event loop alive; an
  // explicit exit guarantees the Fargate one-shot finishes instead of lingering.
  backfillContentClassification()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillContentClassification] fatal', error);
      process.exit(1);
    });
}

export default backfillContentClassification;
