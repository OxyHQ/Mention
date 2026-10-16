/**
 * One-shot admin backfill: put back the links X wrapped in `t.co` inside
 * ALREADY-STORED federated post bodies.
 *
 * Ingest now stores the link a `t.co` wrapper points to (`tcoLinks.ts`), but a
 * post body is written once, so everything imported before that keeps
 * `https://t.co/…`. This rewrites those bodies with the SAME expander the ingest
 * path uses, so the backfill and the live path cannot disagree.
 *
 * SELECTION: renditions of FEDERATED posts whose body contains `t.co/`, walked in
 * ascending id order. A local author's body is their own text and is never
 * touched. Only bodies the expander actually CHANGES are written, so a re-run is
 * a no-op except for wrappers that still do not resolve.
 *
 * PACE: one rendition at a time, {@link PAUSE_MS} apart, so t.co sees a steady
 * trickle rather than a burst. Every resolved link lands in the shared Redis
 * cache, so the dry run warms it and the write run costs almost no requests.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `'true'`: it reports what WOULD change, with
 *     before/after samples, and writes nothing.
 *  2. A write needs `CONFIRM_ADMIN_MUTATION=expandFederatedTcoLinks`.
 *  3. `BACKFILL_MAX` (default 5000) caps the renditions one run scans. The
 *     summary reports `lastId`; `BACKFILL_AFTER_ID` resumes from it.
 *  4. {@link MAX_UNRESOLVED_STREAK} renditions in a row with nothing resolved
 *     stops the run with exit 75: t.co is refusing us, and pushing on would only
 *     make that worse.
 *  5. Every write is one variant row by its own primary key, counted from what
 *     Postgres reports updating.
 *
 * Runnable as a Fargate one-shot:
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=expandFederatedTcoLinks \
 *   bun packages/backend/dist/src/scripts/expandFederatedTcoLinks.js
 */

import { and, asc, eq, gt, ilike, inArray, isNotNull } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { expandTcoLinks } from '../connectors/activitypub/tcoLinks';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';

const SCRIPT_NAME = 'expandFederatedTcoLinks';
const PAGE_SIZE = 200;
const PAUSE_MS = 100;
const MAX_UNRESOLVED_STREAK = 50;
/** Exit code the one-shot runners read as "finished with work left". */
const EXIT_WORK_LEFT = 75;

export interface TcoBackfillResult {
  scanned: number;
  /** Bodies the expander rewrote (or, dry, would rewrite). */
  changed: number;
  /** Rows Postgres REPORTED updating. Always 0 on a dry run. */
  written: number;
  /** Bodies with a `t.co` link the expander could not resolve. */
  unresolved: number;
  /** Stopped early: t.co stopped answering. */
  stopped: boolean;
  /** Resume point for the next run. */
  lastId: string | null;
  samples: Array<{ postId: string; before: string; after: string }>;
}

export async function expandFederatedTcoLinks(
  opts: {
    dryRun?: boolean;
    max?: number;
    afterId?: string;
    pauseMs?: number;
    /** Limits the run to these posts. Production runs leave it unset. */
    postIds?: string[];
  } = {},
): Promise<TcoBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const max = opts.max ?? 5000;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;
  const db = getDb();
  const result: TcoBackfillResult = {
    scanned: 0,
    changed: 0,
    written: 0,
    unresolved: 0,
    stopped: false,
    lastId: opts.afterId ?? null,
    samples: [],
  };
  let unresolvedStreak = 0;

  while (result.scanned < max && !result.stopped) {
    const rows = await db
      .select({
        id: postContentVariants.id,
        postId: postContentVariants.postId,
        body: postContentVariants.body,
      })
      .from(postContentVariants)
      .innerJoin(posts, eq(posts.id, postContentVariants.postId))
      .where(
        and(
          isNotNull(posts.federationActorUri),
          ilike(postContentVariants.body, '%t.co/%'),
          result.lastId ? gt(postContentVariants.id, result.lastId) : undefined,
          opts.postIds ? inArray(posts.id, opts.postIds) : undefined,
        ),
      )
      .orderBy(asc(postContentVariants.id))
      .limit(Math.min(PAGE_SIZE, max - result.scanned));
    if (rows.length === 0) break;

    for (const row of rows) {
      result.scanned += 1;
      result.lastId = row.id;
      const next = await expandTcoLinks(row.body);
      if (pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));

      if (next === row.body) {
        // `t.co/` also matches text that is not a wrapper (`at.co/x`); only a
        // real wrapper left in place counts as unresolved.
        if (/https?:\/\/t\.co\/[A-Za-z0-9]/i.test(row.body)) {
          result.unresolved += 1;
          unresolvedStreak += 1;
          if (unresolvedStreak >= MAX_UNRESOLVED_STREAK) {
            result.stopped = true;
            break;
          }
        }
        continue;
      }

      unresolvedStreak = 0;
      result.changed += 1;
      if (result.samples.length < 10) {
        result.samples.push({
          postId: row.postId,
          before: row.body.slice(0, 200),
          after: next.slice(0, 200),
        });
      }
      if (!dryRun) {
        const updated = await db
          .update(postContentVariants)
          .set({ body: next })
          .where(eq(postContentVariants.id, row.id))
          .returning({ id: postContentVariants.id });
        result.written += updated.length;
      }
    }
  }

  logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
  return result;
}

async function main(): Promise<number> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  const max = Number(process.env.BACKFILL_MAX ?? 5000);
  const afterId = process.env.BACKFILL_AFTER_ID || undefined;
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  const result = await expandFederatedTcoLinks({ dryRun, max, afterId });
  return result.stopped ? EXIT_WORK_LEFT : 0;
}

if (require.main === module) {
  main()
    .then(async (code) => {
      await closeAdminScriptResources();
      process.exit(code);
    })
    .catch(async (error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      await closeAdminScriptResources().catch(() => undefined);
      process.exit(1);
    });
}
