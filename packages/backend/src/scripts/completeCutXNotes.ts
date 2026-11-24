/**
 * One-shot repair: complete the body of every bridged X post that is a note
 * tweet the bridge delivered cut.
 *
 * A tweet over 280 characters reached Mention as its classic prefix, cut at
 * ~277 characters mid-sentence, and a body is written once, so those posts stay
 * cut. Ingest now completes them (`connectors/activitypub/xFullText.ts`); this
 * does the same for the rows stored before. Measured in production on 120
 * recent bridged posts: 8 cut, every one a note tweet.
 *
 * SELECTION IS THE SAFETY. Only the primary author body of a post whose
 * federation id is a keyed X bridge status (`bird.makeup/users/<h>/statuses/<id>`)
 * and that is long enough to be a cut note ({@link mayBeCutNote}) is read; the
 * text is replaced only when FxTwitter says that tweet IS a note tweet and its
 * text is longer, by the same {@link completeBridgedBody} ingest uses.
 *
 * A machine translation of the cut body is deleted with it, so readers get a fresh
 * one of the full text.
 *
 * Idempotent: a completed body is longer than any cut, and the write is guarded
 * on the body that was read, so a concurrent edit is never overwritten.
 *
 * Runnable as a Fargate one-shot:
 *   COMPLETE_DRY_RUN=false CONFIRM_ADMIN_MUTATION=completeCutXNotes \
 *   bun packages/backend/dist/src/scripts/completeCutXNotes.js
 *
 * Env:
 *   DATABASE_URL        the Postgres database (injected by ECS from SSM)
 *   COMPLETE_DRY_RUN    defaults to `true`; only `=false` writes
 *   COMPLETE_MAX        candidate cap (default 20000)
 *   CONFIRM_ADMIN_MUTATION=completeCutXNotes  required for a real apply
 */

import { and, eq, sql } from 'drizzle-orm';
import { completeBridgedBody, CUT_NOTE_MIN_LENGTH } from '../connectors/activitypub/xFullText';
import { connectPostgres, getDb } from '../db/postgres';
import { postContentVariants } from '../db/schema/postContent';
import { posts } from '../db/schema/posts';
import { mapWithConcurrency } from '../utils/concurrency';
import { logger } from '../utils/logger';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';

/** FxTwitter allows 1,000 requests a minute per IP; this stays far under it. */
const CONCURRENCY = 4;

export interface CompleteCutXNotesResult {
  /** Primary bodies of bridged X posts long enough to be a cut note. */
  candidates: number;
  /** Of those, the ones that were cut and have a longer full text. */
  completed: number;
  /** Rows Postgres reported modifying. Zero with `completed > 0` is a defect. */
  written: number;
  noOpWrites: boolean;
}

export async function completeCutXNotes(
  opts: { dryRun?: boolean; max?: number } = {},
): Promise<CompleteCutXNotesResult> {
  const dryRun = opts.dryRun ?? true;
  const db = getDb();

  const rows = await db
    .select({
      variantId: postContentVariants.id,
      postId: postContentVariants.postId,
      body: postContentVariants.body,
      activityId: posts.federationActivityId,
    })
    .from(postContentVariants)
    .innerJoin(posts, eq(posts.id, postContentVariants.postId))
    .where(
      and(
        eq(postContentVariants.position, 0),
        eq(postContentVariants.source, 'author'),
        sql`${posts.federationActivityId} ~ '^https://bird\.makeup/users/[^/]+/statuses/[0-9]+$'`,
        sql`length(${postContentVariants.body}) >= ${CUT_NOTE_MIN_LENGTH}`,
      ),
    )
    .orderBy(postContentVariants.id)
    .limit(opts.max ?? 20_000);

  let completed = 0;
  let written = 0;
  const settled = await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    const body = await completeBridgedBody(row.activityId, row.body);
    if (body === row.body) return;
    completed += 1;
    if (dryRun) return;
    // A machine translation is a translation of the body it was made from, so the
    // cut ones go with it (as an inbound edit does), in the same transaction and
    // only when the guarded update landed.
    written += await db.transaction(async (tx) => {
      const updated = await tx
        .update(postContentVariants)
        .set({ body })
        .where(
          and(eq(postContentVariants.id, row.variantId), eq(postContentVariants.body, row.body)),
        )
        .returning({ id: postContentVariants.id });
      if (updated.length > 0) {
        await tx
          .delete(postContentVariants)
          .where(
            and(
              eq(postContentVariants.postId, row.postId),
              eq(postContentVariants.source, 'machine'),
            ),
          );
      }
      return updated.length;
    });
  });

  const failure = settled.find((slot) => slot.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;

  return {
    candidates: rows.length,
    completed,
    written,
    noOpWrites: !dryRun && completed > 0 && written === 0,
  };
}

const SCRIPT_NAME = 'completeCutXNotes';

async function main(): Promise<void> {
  const dryRun = process.env.COMPLETE_DRY_RUN !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });

  await connectPostgres();
  const max = Number.parseInt(process.env.COMPLETE_MAX ?? '', 10);

  try {
    const result = await completeCutXNotes({
      dryRun,
      ...(Number.isFinite(max) && max > 0 ? { max } : {}),
    });
    logger.info('[CompleteCutX] complete', { dryRun, ...result });
    if (result.noOpWrites) {
      logger.error('[CompleteCutX] identified work but wrote nothing');
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error('[CompleteCutX] failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[CompleteCutX] failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
