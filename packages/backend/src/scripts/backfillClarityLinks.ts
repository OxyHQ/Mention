/**
 * One-shot: ask Clarity to index the links of posts that were stored before
 * every storage route warmed them, newest first.
 *
 * Every NEW post is warmed at store time (`services/postEnrichment`), and an
 * older one is warmed the first time anybody reads it (hydration enqueues the
 * crawl). This fills in the rest, so an old post's link card does not wait for
 * its first reader.
 *
 * It uses the SAME function the storage routes use ({@link
 * warmClarityDocumentsForPosts}), so what counts as a previewable link cannot
 * drift from the live path. A link Clarity already has costs nothing: `resolve`
 * answers from its documents and enqueues no crawl.
 *
 * GENTLE BY CONSTRUCTION. Clarity has one crawl queue that new posts share, and
 * a bulk enqueue once held its `active_crawls` lock for twenty minutes and
 * stalled every Mention preview. So the run is small and slow: `BATCH_POSTS`
 * posts (at most ~4 links each) per call, `PAUSE_MS` between calls, and at most
 * `MAX_POSTS` posts per run. Re-run to continue: pass `BEFORE` (the
 * `createdAt` the previous run printed as `resumeBefore`).
 *
 * SAFETY: `DRY_RUN` defaults to true and only counts; a live run needs
 * `CONFIRM_ADMIN_MUTATION=backfillClarityLinks`.
 *
 *   bun packages/backend/dist/src/scripts/backfillClarityLinks.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillClarityLinks \
 *     bun packages/backend/dist/src/scripts/backfillClarityLinks.js
 */

import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { findPostRecords } from '../db/posts/postRepository';
import { connectPostgres } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { warmClarityDocumentsForPosts } from '../services/postEnrichment/clarityDocumentStep';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'backfillClarityLinks';

export interface ClarityLinksBackfillResult {
  scanned: number;
  /** `createdAt` of the oldest post reached, to resume from with `BEFORE`. */
  resumeBefore: string | null;
}

export async function backfillClarityLinks(
  opts: {
    dryRun?: boolean;
    days?: number;
    batchPosts?: number;
    pauseMs?: number;
    maxPosts?: number;
    before?: Date;
  } = {},
): Promise<ClarityLinksBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const batchPosts = opts.batchPosts ?? 25;
  const pauseMs = opts.pauseMs ?? 6_000;
  const maxPosts = opts.maxPosts ?? 5_000;
  const since = new Date(Date.now() - (opts.days ?? 30) * 24 * 60 * 60 * 1000);

  let scanned = 0;
  let cursor: { createdAt: Date; id: string } | null = null;
  let resumeBefore: Date | undefined = opts.before;

  while (scanned < maxPosts) {
    const where = and(
      eq(posts.hasLinks, true),
      sql`${posts.createdAt} >= ${since}`,
      resumeBefore && !cursor ? lt(posts.createdAt, resumeBefore) : undefined,
      cursor
        ? or(
            lt(posts.createdAt, cursor.createdAt),
            and(eq(posts.createdAt, cursor.createdAt), lt(posts.id, cursor.id)),
          )
        : undefined,
    );
    const rows = await findPostRecords(where, {
      orderBy: [desc(posts.createdAt), desc(posts.id)],
      limit: Math.min(batchPosts, maxPosts - scanned),
    });
    if (rows.length === 0) break;

    if (!dryRun) {
      await warmClarityDocumentsForPosts(rows.map((row) => ({ id: row.id, content: row.content })));
    }
    scanned += rows.length;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.createdAt, id: last.id };
    resumeBefore = last.createdAt;

    if (scanned % (batchPosts * 20) === 0) {
      logger.info(`[${SCRIPT_NAME}] progress`, {
        scanned,
        resumeBefore: resumeBefore.toISOString(),
      });
    }
    if (!dryRun && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  const result = { scanned, resumeBefore: resumeBefore?.toISOString() ?? null };
  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
  return result;
}

function envNumber(name: string): number | undefined {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  const before = process.env.BEFORE ? new Date(process.env.BEFORE) : undefined;
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  await backfillClarityLinks({
    dryRun,
    days: envNumber('DAYS'),
    batchPosts: envNumber('BATCH_POSTS'),
    pauseMs: envNumber('PAUSE_MS'),
    maxPosts: envNumber('MAX_POSTS'),
    before: before && !Number.isNaN(before.getTime()) ? before : undefined,
  });
}

if (require.main === module) {
  main()
    .then(async () => {
      await closeAdminScriptResources();
      process.exit(0);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
