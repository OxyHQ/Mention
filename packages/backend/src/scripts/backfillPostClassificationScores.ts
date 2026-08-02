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
 * Idempotent (re-stamping the version removes a post from the selection filter,
 * so a re-run only fills remaining gaps) and batched via a stable ascending `_id`
 * page cursor. A single post's failure is isolated so the scan can finish, but
 * the completed run exits non-zero rather than reporting a partial backfill as
 * successful. Supports `--dry-run` (report what it would update, write nothing).
 *
 * Runnable as a Fargate one-shot post-deploy:
 *   bun packages/backend/dist/src/scripts/backfillPostClassificationScores.js
 *   bun packages/backend/dist/src/scripts/backfillPostClassificationScores.js --dry-run
 */

import mongoose from 'mongoose';
import { and, asc, gt, isNull, lt, ne, or, type SQL } from 'drizzle-orm';
import { resolveVariant } from '../services/postVariants';
import { connectPostgres } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { findPostRecords, updatePostRecord } from '../db/posts/postRepository';
import type { PostRecord } from '../db/posts/postRecord';
import { findActorsByUris } from '../db/federation/actorRepository';
import { BASELINE_CLASSIFIER_VERSION } from '../services/BaselineContentClassifier';
import {
  computeDeterministicScores,
  toClassificationScores,
} from '../services/contentClassification/spamQuality';
import { logger } from '../utils/logger';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

/** Posts scanned per page (stable ascending `id` cursor pagination). */
const DEFAULT_PAGE_SIZE = 500;

export interface BackfillPostClassificationScoresResult {
  scanned: number;
  updated: number;
  failed: number;
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
async function resolveActorContexts(rows: PostRecord[]): Promise<Map<string, ActorContext>> {
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

  const actors = await findActorsByUris(actorUris);

  for (const actor of actors) {
    contexts.set(actor.uri, { type: actor.type, domain: actor.domain });
  }
  return contexts;
}

/**
 * Recompute + backfill deterministic scores over the qualifying corpus. Operates
 * on `Post` plus the `federated_actors` table only — the caller owns the
 * connection lifecycles — so it stays reusable
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
  // The NULL arm is spelled out: `version < N` is NULL for an unstamped row and a
  // NULL predicate excludes the row, so without it the literal translation would
  // skip exactly the posts that were never stamped at all.
  const baseFilter = and(
    ne(posts.classificationStatus, 'classified'),
    or(
      lt(posts.classificationVersion, BASELINE_CLASSIFIER_VERSION),
      isNull(posts.classificationVersion),
    ),
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
        const hashtagCount = post.postClassification.hashtagsNorm?.length ?? post.hashtags.length;

        const scores = toClassificationScores(
          computeDeterministicScores(resolveVariant(post.content).text, hashtagCount, {
            actorType: actorContext?.type,
            instanceDomain: actorContext?.domain,
            isFederated,
          }),
        );

        updated += 1;
        if (dryRun) continue;

        // A PARTIAL patch: the two fields MERGE onto the existing classification,
        // leaving the Stage-A languages/region/hashtagsNorm the caller did not
        // recompute exactly as they were.
        await updatePostRecord(post.id, {
          postClassification: { scores, version: BASELINE_CLASSIFIER_VERSION },
        });
      } catch (error) {
        failed += 1;
        logger.warn('[backfillPostClassificationScores] recompute failed for post; skipping', {
          id: post.id,
          reason: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    lastId = page[page.length - 1].id;
    logger.info(
      `[backfillPostClassificationScores] progress: scanned ${scanned}, updated ${updated}, failed ${failed}`,
    );
  }

  return { scanned, updated, failed };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;
  const dryRun = process.argv.includes('--dry-run');

  try {
    assertAdminMutationAllowed({
      scriptName: 'backfillPostClassificationScores',
      dryRun,
    });
    // BOTH stores, and that is not a leftover: the posts are Postgres, while the
    // federated-actor context this recompute reads (`FederatedActor.type` /
    // `.domain`) is still a Mongo model owned by the federation batch.
    await connectPostgres();
    await mongoose.connect(mongoUri, { dbName });
    logger.info('[backfillPostClassificationScores] connected to PostgreSQL + MongoDB', { dryRun });

    const result = await backfillPostClassificationScores({ dryRun });

    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    logger.info(
      `[backfillPostClassificationScores] done${dryRun ? ' (DRY_RUN — no writes)' : ''}: scanned ${result.scanned}, updated ${result.updated}, failed ${result.failed} (${elapsedSeconds}s)`,
    );

    assertAdminRunComplete('backfillPostClassificationScores', {
      failed: result.failed,
    });
  } catch (error) {
    logger.error('[backfillPostClassificationScores] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect().catch((disconnectError) => {
      logger.warn('[backfillPostClassificationScores] error during mongoose.disconnect()', disconnectError);
    });
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[backfillPostClassificationScores] unhandled failure', error);
      process.exit(1);
    });
}
