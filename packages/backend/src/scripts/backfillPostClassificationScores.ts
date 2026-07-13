/**
 * One-shot corpus backfill: recompute `postClassification.scores` for posts that
 * predate the v5 (low-effort + bot-shape hardening) deterministic ruleset.
 *
 * WHY THIS IS MANDATORY AFTER THE v5 BUMP: ranking (and the discovery gate) only
 * TRUST a post's classification scores when they carry a real provenance marker —
 * `status === 'classified'` OR `version >= BASELINE_CLASSIFIER_VERSION` (see
 * `services/contentClassification/trustedScores`). Bumping the baseline to v5
 * therefore drops every existing baseline-only v4 post BELOW the provenance bar:
 * until this backfill re-stamps it, its scores read as NEUTRAL in ranking. That
 * is the known, planned transition. This script re-runs the deterministic scorer
 * with the stronger v5 heuristics and re-stamps `version = 5`, restoring the fast
 * (no-AI) ranking path across the corpus.
 *
 * It EXCLUDES `status: 'classified'` posts: those carry real async-AI (Alia)
 * scores that are trusted via status and must NEVER be clobbered by the
 * deterministic baseline.
 *
 * For federated posts it batch-resolves the author's AP `type` + instance host
 * from the {@link FederatedActor} record (keyed by `federation.actorUri`) so the
 * RSS/bot-mirror signal fires; when the actor can't be resolved it falls back to
 * text-only bot detection (the link-only news-bot signal still works from shape).
 * It writes ONLY `postClassification.scores` + `postClassification.version` — it
 * does not touch languages / topics / sensitive.
 *
 * Idempotent (re-stamping the version removes a post from the selection filter, so
 * a re-run only fills remaining gaps), batched via a stable ascending `_id` page
 * cursor, and fail-soft (a single post's failure is logged at warn and skipped —
 * never aborts the run). Supports `--dry-run` (report what it would update, write
 * nothing).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillPostClassificationScores.js
 *   bun packages/backend/dist/src/scripts/backfillPostClassificationScores.js --dry-run
 */

import mongoose from 'mongoose';
import { Post } from '../models/Post';
import { FederatedActor } from '../models/FederatedActor';
import { BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import {
  computeDeterministicScores,
  toClassificationScores,
} from '../services/contentClassification/spamQuality';
import { logger } from '../utils/logger';

/** Posts scanned per page (stable ascending `_id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

/** Update writes flushed per bulkWrite chunk. */
const BULK_CHUNK_SIZE = 500;

export interface BackfillPostClassificationScoresResult {
  scanned: number;
  updated: number;
}

/** Minimal projected shape the score recompute needs. */
interface PostScoreRow {
  _id: mongoose.Types.ObjectId;
  content?: { text?: string };
  hashtags?: string[];
  federation?: { actorUri?: string } | null;
  postClassification?: { hashtagsNorm?: string[] };
}

/** Resolved federated-origin context for a page of posts, keyed by actor URI. */
interface ActorContext {
  type?: string;
  domain?: string;
}

/**
 * Batch-resolve the AP `type` + instance host for every federated actor URI on a
 * page, in ONE query. Posts whose actor can't be resolved simply get no entry and
 * fall back to text-only bot detection.
 */
async function resolveActorContexts(rows: PostScoreRow[]): Promise<Map<string, ActorContext>> {
  const actorUris = Array.from(
    new Set(
      rows
        .map((row) => row.federation?.actorUri)
        .filter((uri): uri is string => typeof uri === 'string' && uri.length > 0),
    ),
  );
  const contexts = new Map<string, ActorContext>();
  if (actorUris.length === 0) {
    return contexts;
  }

  const actors = await FederatedActor.find(
    { uri: { $in: actorUris } },
    { uri: 1, type: 1, domain: 1 },
  ).lean<Array<{ uri: string; type?: string; domain?: string }>>();

  for (const actor of actors) {
    contexts.set(actor.uri, { type: actor.type, domain: actor.domain });
  }
  return contexts;
}

/**
 * Recompute + backfill deterministic scores over the qualifying corpus. Operates
 * on the `Post` / `FederatedActor` models only — the caller owns the Mongo
 * connection lifecycle — so it is unit-testable with mocked models and reusable
 * from an in-process caller.
 */
export async function backfillPostClassificationScores(
  opts: { batchSize?: number; dryRun?: boolean } = {},
): Promise<BackfillPostClassificationScoresResult> {
  const pageSize = opts.batchSize ?? DEFAULT_PAGE_SIZE;
  const dryRun = opts.dryRun ?? false;

  // Non-classified posts (never clobber real AI scores) whose baseline predates
  // the current ruleset version. Re-stamping `version` removes a post from this
  // filter, so the ascending `_id` cursor never revisits a completed post and a
  // re-run only fills remaining gaps.
  const baseFilter: Record<string, unknown> = {
    'postClassification.status': { $ne: 'classified' },
    $or: [
      { 'postClassification.version': { $lt: BASELINE_CLASSIFIER_VERSION } },
      { 'postClassification.version': { $exists: false } },
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
      'federation.actorUri': 1,
      'postClassification.hashtagsNorm': 1,
    })
      .sort({ _id: 1 })
      .limit(pageSize)
      .lean<PostScoreRow[]>();

    if (page.length === 0) break;

    const actorContexts = await resolveActorContexts(page);

    for (const post of page) {
      scanned += 1;
      try {
        const isFederated = post.federation != null;
        const actorUri = post.federation?.actorUri;
        const actorContext = actorUri ? actorContexts.get(actorUri) : undefined;

        // Canonical hashtag count = the stored normalized hashtags (falling back
        // to the raw hashtags array), so the recomputed spam heuristic agrees with
        // the classifier on what counts as a hashtag.
        const hashtagCount = post.postClassification?.hashtagsNorm?.length ?? post.hashtags?.length ?? 0;

        const scores = toClassificationScores(
          computeDeterministicScores(post.content?.text ?? '', hashtagCount, {
            actorType: actorContext?.type,
            instanceDomain: actorContext?.domain,
            isFederated,
          }),
        );

        updated += 1;
        if (dryRun) continue;

        pendingOps.push({
          updateOne: {
            filter: { _id: post._id },
            update: {
              $set: {
                'postClassification.scores': scores,
                'postClassification.version': BASELINE_CLASSIFIER_VERSION,
              },
            },
          },
        });

        if (pendingOps.length >= BULK_CHUNK_SIZE) {
          await flush();
        }
      } catch (error) {
        logger.warn('[backfillPostClassificationScores] recompute failed for post; skipping', {
          id: String(post._id),
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1]._id;
    logger.info(`[backfillPostClassificationScores] progress: scanned ${scanned}, updated ${updated}`);
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
    logger.info(`[backfillPostClassificationScores] connected to MongoDB (${dbName}); DRY_RUN=${dryRun}`);

    const result = await backfillPostClassificationScores({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillPostClassificationScores] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated} (${elapsedSeconds}s)`,
    );

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    logger.error('[backfillPostClassificationScores] failed', error);
    await mongoose.disconnect();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
