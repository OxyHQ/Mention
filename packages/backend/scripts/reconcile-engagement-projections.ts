/**
 * MANUAL convergence task for engagement-derived read models.
 *
 * It closes a migration window: it repairs what writers OTHER than today's
 * transactional ones left behind in `posts.stats_saves_count` and
 * `post_recent_repliers`. On an ordinary day there is no such window —
 * `PostEngagementCommandService` and `recordRecentReplierForPost` maintain both
 * projections inside the same transaction as the write they derive from, and the
 * backfill loads both — so this recomputes correct values into themselves.
 *
 * ## Run it when a window actually opened, not on a schedule
 *
 * After a restore, after a bulk import that bypassed the writers, or after any
 * incident where something else wrote `posts` or `bookmarks`. Two properties make
 * that safe: it derives everything from the authoritative rows (`bookmarks`, and
 * the replies themselves), and each batch of `RECONCILIATION_BATCH_SIZE` posts is
 * one transaction, so an interrupted run leaves every post either fully repaired
 * or untouched and a re-run converges.
 *
 * **It must not run against a half-restored database.** "Authoritative" is read
 * as of NOW: if a post's replies or a post's bookmarks have not been copied back
 * yet, the authoritative answer is "none", and this task will faithfully delete
 * the correct projection rows and zero the correct counters. Measured: with
 * `bookmarks` empty, 500 posts carrying a total of 3,500 saves went to 0. A later
 * run over the complete data repairs it, but nothing else will.
 *
 * ## It is NOT wired into the deploy, on purpose
 *
 * `deploy-aws.yml` used to pass this file as `POST_DEPLOY_TASK_COMMAND_JSON`.
 * That variable is now deliberately unset, and the removal site there carries the
 * four reasons. The short one: a failing post-deploy one-shot rolls the service
 * back, and this task's cost is O(distinct reply parents) with no watermark and
 * no incremental mode, so it grows with the table until it outlives any timeout —
 * which is what rolled back a healthy release on 2026-08-05.
 *
 * ## Launching it
 *
 * A Fargate one-shot on the live service's own task definition, network
 * configuration and secrets. Take all of them from the RUNNING service rather
 * than naming a task definition here: a pinned name is a claim about
 * infrastructure this repo does not own, and it goes stale silently.
 * `.github/workflows/run-federated-text-backfill.yml` is the worked example —
 * `describe-services` -> `taskDefinition` + `networkConfiguration` -> `run-task`
 * with a container override whose command is:
 *
 *     bun packages/backend/dist/scripts/reconcile-engagement-projections.js
 *
 * `dist/scripts/`, not `dist/src/scripts/`: `tsconfig.json` sets `rootDir: ./`,
 * so this file (outside `src/`) compiles to a sibling of it. The runtime image is
 * `oven/bun:*-alpine` and has no `node`.
 *
 * Postgres-only, because `reconcileEngagementProjections` reads and writes
 * exclusively through Drizzle. A one-shot gets none of `server.ts`'s startup,
 * so it must open the pool itself: without `connectPostgres()` the service's
 * first `getDb()` throws `PostgreSQL is not connected` and this task exits 1.
 */

import { closePostgres, connectPostgres } from '../src/db/postgres';
import { reconcileEngagementProjections } from '../src/services/EngagementProjectionReconciliationService';
import { logger } from '../src/utils/logger';

async function main(): Promise<void> {
  await connectPostgres();
  await reconcileEngagementProjections();
}

void main()
  .then(async () => {
    await closePostgres();
    process.exit(0);
  })
  .catch(async (error) => {
    logger.error('[EngagementProjectionReconciliation] task failed', error);
    await closePostgres().catch(() => undefined);
    process.exit(1);
  });
