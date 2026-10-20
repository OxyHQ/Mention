/**
 * One-shot admin backfill: stored federated post bodies that still name the host
 * a copy arrived through (`bird.makeup`, `mastox.eu`, `kilogram.makeup`) now name
 * the network it came from.
 *
 * Ingest writes the upstream form (`rewriteMirrorUrls`); a body is written once,
 * so everything imported before that keeps the mirror's. This applies the SAME
 * rewrite, so the backfill and the live path cannot disagree. It is offline: the
 * stored text carries everything the rewrite needs.
 *
 * SELECTION: renditions of FEDERATED posts whose body names a mirror host, walked
 * in ascending id order. Only bodies the rewrite actually CHANGES are written, so
 * a re-run is a no-op.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `'true'`: it reports what WOULD change, with
 *     before/after samples, and writes nothing.
 *  2. A write needs `CONFIRM_ADMIN_MUTATION=rewriteMirrorHostsInBodies`.
 *  3. `BACKFILL_MAX` (default 20000) caps the renditions one run scans. The
 *     summary reports `lastId`; `BACKFILL_AFTER_ID` resumes from it.
 *  4. Every write is one variant row by its own primary key, counted from what
 *     Postgres reports updating.
 *
 * Runnable as a Fargate one-shot:
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=rewriteMirrorHostsInBodies \
 *   bun packages/backend/dist/src/scripts/rewriteMirrorHostsInBodies.js
 */

import { and, asc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { MIRROR_HOSTS, rewriteMirrorUrls } from '../utils/federation/mirrorTransports';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';

const SCRIPT_NAME = 'rewriteMirrorHostsInBodies';
const PAGE_SIZE = 500;

/** A body that names any mirror host. Host dots are escaped; Postgres runs the same source. */
const MIRROR_HOST_BODY_REGEX = `(${MIRROR_HOSTS.map((host) => host.replace(/\./g, '\\.')).join('|')})`;

export interface MirrorBackfillResult {
  scanned: number;
  /** Bodies the rewrite changed (or, dry, would change). */
  changed: number;
  /** Rows Postgres REPORTED updating. Always 0 on a dry run. */
  written: number;
  /** Resume point for the next run. */
  lastId: string | null;
  samples: Array<{ postId: string; before: string; after: string }>;
}

export async function rewriteMirrorHostsInBodies(
  opts: {
    dryRun?: boolean;
    max?: number;
    afterId?: string;
    /** Limits the run to these posts. Production runs leave it unset. */
    postIds?: string[];
  } = {},
): Promise<MirrorBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const max = opts.max ?? 20000;
  const db = getDb();
  const result: MirrorBackfillResult = {
    scanned: 0,
    changed: 0,
    written: 0,
    lastId: opts.afterId ?? null,
    samples: [],
  };

  while (result.scanned < max) {
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
          sql`${postContentVariants.body} ~ ${MIRROR_HOST_BODY_REGEX}`,
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
      const next = rewriteMirrorUrls(row.body);
      if (next === row.body) continue;

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

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  const max = Number(process.env.BACKFILL_MAX ?? 20000);
  const afterId = process.env.BACKFILL_AFTER_ID || undefined;
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  await rewriteMirrorHostsInBodies({ dryRun, max, afterId });
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
