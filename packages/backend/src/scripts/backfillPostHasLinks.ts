/**
 * One-shot repair: recompute `posts.has_links` from the stored renditions, for
 * every row where the column and the bodies disagree.
 *
 * THE BUG (fixed going forward in `db/posts/postRepository.ts`): `has_links` was
 * an optional field on `PostRecordInput` that `toPostInsert` defaulted to
 * `false`, and exactly ONE writer supplied it — the ActivityPub outbox backfill.
 * `PostCreationService` (which serves native creates AND the single-post
 * federated imports: the inbox `Create`, the atproto author-feed import), the
 * reply and boost paths in `feed.controller`, and `PostMaterializer` all omitted
 * it. So a post full of URLs stored `has_links = false`, and the `filter:links`
 * search operator — `eq(posts.hasLinks, true)` in `routes/search.ts` — matched
 * none of them. Nothing errored: the query was valid, returned rows, and simply
 * omitted everything those paths wrote.
 *
 * There was no edit-side derivation either, so a post edited to add or remove a
 * link kept whatever the column said at creation. Both halves now derive at the
 * repository seam (`toPostInsert`, `replacePostContent`), which is why this
 * script has nothing to keep doing: it repairs the rows written before that.
 *
 * THE REPAIR is symmetric and is a recomputation, not a one-way fill:
 *
 *  - `has_links = false` while a rendition carries an http(s) URL  -> set true;
 *  - `has_links = true`  while NO rendition carries one            -> set false.
 *
 * The second direction is not hypothetical residue-hunting. Two one-shot repair
 * scripts write `post_content_variants.body` with direct SQL and therefore
 * bypass `replacePostContent` entirely — `normalizeFederatedText` and, more to
 * the point, `repairFederatedMentions`, which folds a profile URL in a body into
 * a `[mention:<id>]` placeholder and so REMOVES a link from text that had one.
 * A fill-only repair would leave those rows permanently claiming a link they no
 * longer contain.
 *
 * THE PREDICATE IS THE SAME ONE THE WRITE PATH USES, re-expressed in SQL:
 * `postTextHasHttpLink` is `/https?:\/\//i` over EVERY stored rendition, so this
 * is `~*` (case-insensitive) against `'https?://'` over every
 * `post_content_variants` row of the post. A rendition is a rendition whether an
 * author or a machine wrote it — `source` is deliberately not filtered, exactly
 * as the detector does not filter it. Widening this to article bodies or
 * `content.sources` would be a different column with a different meaning; do
 * that at the derivation, never here, or the two drift.
 *
 * SAFETY:
 *  1. `DRY_RUN` defaults to `true`; only `DRY_RUN=false` writes.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. Batched by id, so no single statement locks a large fraction of `posts`.
 *  4. Written counts come from what POSTGRES REPORTS MODIFYING (`returning`),
 *     never from "we called update".
 *  5. Each batch's UPDATE re-states the full disagreement predicate in its own
 *     WHERE, so a row another writer fixed between the SELECT and the UPDATE is
 *     not counted as this run's work.
 *  6. Idempotent: a repaired row no longer disagrees, so a second run finds it
 *     in neither direction and reports zero.
 *
 * Runnable as a Fargate one-shot (DRY_RUN first):
 *   bun packages/backend/dist/src/scripts/backfillPostHasLinks.js
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillPostHasLinks \
 *     bun packages/backend/dist/src/scripts/backfillPostHasLinks.js
 */

import { and, eq, exists, inArray, isNull, not, sql } from 'drizzle-orm';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

const SCRIPT_NAME = 'backfillPostHasLinks';

/** Rows repaired per statement. */
const BATCH_SIZE = 1000;

/** Batches between progress lines. */
const PROGRESS_EVERY_BATCHES = 20;

/**
 * The SQL twin of `postTextHasHttpLink`: does ANY rendition of this post carry
 * an http(s) URL?
 *
 * A correlated `EXISTS` rather than a join, because a post with three renditions
 * each containing a link must be one candidate row, not three — a join would
 * make every count in the summary a multiple of the truth for exactly the posts
 * the repair cares most about.
 *
 * Built per call rather than held in a module constant: `getDb()` throws before
 * `connectPostgres()`, and a constant would make that throw happen at IMPORT,
 * taking down any test or tool that merely loads this module.
 */
function bodyHasLink() {
  return exists(
    getDb()
      .select({ one: sql`1` })
      .from(postContentVariants)
      .where(and(
        eq(postContentVariants.postId, posts.id),
        sql`${postContentVariants.body} ~* 'https?://'`,
      )),
  );
}

/** One direction of the disagreement between the column and the bodies. */
type Direction = 'set-true' | 'set-false';

function disagreement(direction: Direction) {
  return direction === 'set-true'
    ? and(eq(posts.hasLinks, false), bodyHasLink())
    : and(eq(posts.hasLinks, true), not(bodyHasLink()));
}

export interface HasLinksBackfillCounts {
  /** Rows whose column disagrees with their bodies, per direction. */
  candidates: number;
  /** Of those, the ones with no `federation_activity_id` — written natively. */
  nativeCandidates: number;
  /** Rows Postgres reported modifying. Always 0 on a dry run. */
  written: number;
}

export interface HasLinksBackfillResult {
  setTrue: HasLinksBackfillCounts;
  setFalse: HasLinksBackfillCounts;
  /**
   * Candidates were found and the run wrote none. Carried on the result rather
   * than inferred by the reader: a live run that repaired nothing and a run that
   * had nothing to repair both end with `written: 0`, and only one of them is a
   * bug.
   */
  noOpWrites: boolean;
}

/** Count the disagreeing rows, in total and restricted to natively-written ones. */
async function countCandidates(direction: Direction): Promise<{ total: number; native: number }> {
  const [row] = await getDb()
    .select({
      total: sql<number>`count(*)::int`,
      native: sql<number>`count(*) filter (where ${isNull(posts.federationActivityId)})::int`,
    })
    .from(posts)
    .where(disagreement(direction));
  return { total: row?.total ?? 0, native: row?.native ?? 0 };
}

async function repairDirection(
  direction: Direction,
  dryRun: boolean,
): Promise<HasLinksBackfillCounts> {
  const counted = await countCandidates(direction);
  const counts: HasLinksBackfillCounts = {
    candidates: counted.total,
    nativeCandidates: counted.native,
    written: 0,
  };
  if (dryRun || counted.total === 0) return counts;

  const target = direction === 'set-true';
  let batches = 0;

  // Re-selected every iteration rather than paged with an OFFSET: a repaired row
  // leaves the candidate set, so an offset would step PAST the rows that shifted
  // down into the window it already read.
  for (;;) {
    const batch = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(disagreement(direction))
      .limit(BATCH_SIZE);
    if (batch.length === 0) break;

    const updated = await getDb()
      .update(posts)
      .set({ hasLinks: target })
      .where(and(
        inArray(posts.id, batch.map((row) => row.id)),
        // The predicate again, so a row somebody else already fixed is not
        // counted as this run's work.
        disagreement(direction),
      ))
      .returning({ id: posts.id });
    counts.written += updated.length;

    batches += 1;
    if (batches % PROGRESS_EVERY_BATCHES === 0) {
      logger.info(`[${SCRIPT_NAME}] progress`, {
        direction,
        written: counts.written,
        candidates: counts.candidates,
      });
    }

    // Every candidate in the batch was already disagreeing when selected, so a
    // batch that changed nothing means the predicate no longer removes rows from
    // the candidate set — which would loop forever. Stop and say so.
    if (updated.length === 0) {
      logger.error(`[${SCRIPT_NAME}] a batch of candidates wrote nothing; stopping`, {
        direction,
        batchSize: batch.length,
        written: counts.written,
      });
      break;
    }
  }

  return counts;
}

/**
 * The backfill itself. The CALLER owns the connection lifecycle, so a test can
 * run it in-process against real rows.
 */
export async function backfillPostHasLinks(
  opts: { dryRun?: boolean } = {},
): Promise<HasLinksBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  const startedAt = Date.now();

  const setTrue = await repairDirection('set-true', dryRun);
  const setFalse = await repairDirection('set-false', dryRun);

  const candidates = setTrue.candidates + setFalse.candidates;
  const written = setTrue.written + setFalse.written;
  const result: HasLinksBackfillResult = {
    setTrue,
    setFalse,
    noOpWrites: !dryRun && candidates > 0 && written === 0,
  };

  logger.info(`[${SCRIPT_NAME}] complete`, {
    dryRun,
    setTrueCandidates: setTrue.candidates,
    setTrueNativeCandidates: setTrue.nativeCandidates,
    setTrueWritten: setTrue.written,
    setFalseCandidates: setFalse.candidates,
    setFalseNativeCandidates: setFalse.nativeCandidates,
    setFalseWritten: setFalse.written,
    noOpWrites: result.noOpWrites,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
  });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.DRY_RUN ?? 'true') !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  logger.info(`[${SCRIPT_NAME}] starting`, { dryRun });
  await backfillPostHasLinks({ dryRun });
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
