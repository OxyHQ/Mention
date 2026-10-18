/**
 * One-shot repair: delete every MACHINE translation that still carries the
 * `<text>` wrapper the translation prompt put around its source.
 *
 * Since Mention's text features route across many models, some of them echoed
 * the wrapper back (`<text>\nVal. Això pot explicar…\n</text>`), and the
 * translation path cached the answer as given. Translation output is now
 * unwrapped and validated before anything is stored
 * (`services/translationOutputGuard.ts`); this removes what was cached before.
 *
 * DELETE, not rewrite. A machine variant is a cache: the next reader who asks
 * for that language gets a fresh, validated translation. Stripping the wrapper
 * in place would keep translations that never passed the entity check.
 *
 * SELECTION IS THE SAFETY:
 *  - only `source = 'machine'` rows are candidates, and the repository helper
 *    never offers an author rendition to the predicate — an author variant is
 *    never touched;
 *  - a post whose AUTHOR text itself contains `<text>`/`</text>` is skipped, so
 *    a translation of a post that really is about the tag survives.
 *
 * Idempotent: a deleted row is not found again. Logs counts only.
 *
 * Runnable as a Fargate one-shot:
 *   DRY_RUN=false CONFIRM_ADMIN_MUTATION=purgeWrappedMachineTranslations \
 *   bun packages/backend/dist/src/scripts/purgeWrappedMachineTranslations.js
 *
 * Env:
 *   DATABASE_URL       the Postgres database (injected by ECS from SSM)
 *   DRY_RUN            defaults to `true`; only `=false` writes
 *   PURGE_MAX          candidate cap (default 50000)
 *   CONFIRM_ADMIN_MUTATION=purgeWrappedMachineTranslations  required for a real apply
 */

import { sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { connectPostgres, getDb } from '../db/postgres';
import { deleteMachineVariants } from '../db/posts/postRepository';

const WRAPPER_OPEN = '<text>';
const WRAPPER_CLOSE = '</text>';

export interface PurgeWrappedTranslationsResult {
  /** Machine variants whose body still contains the wrapper. */
  candidates: number;
  /** Posts those variants belong to. */
  posts: number;
  /** Rows actually deleted. Always 0 on a dry run. */
  deleted: number;
  /** True when work was identified and none of it landed. */
  noOpWrites: boolean;
}

function carriesWrapper(body: string): boolean {
  return body.includes(WRAPPER_OPEN) || body.includes(WRAPPER_CLOSE);
}

export async function purgeWrappedMachineTranslations(
  opts: { dryRun?: boolean; max?: number } = {},
): Promise<PurgeWrappedTranslationsResult> {
  const dryRun = opts.dryRun ?? true;
  const max = opts.max ?? 50_000;

  // Aliased on both sides: the correlated subquery reads the same table.
  const rows = await getDb().execute<{ id: string; post_id: string }>(sql`
    select machine.id, machine.post_id
    from post_content_variants machine
    where machine.source = 'machine'
      and (strpos(machine.body, ${WRAPPER_OPEN}) > 0 or strpos(machine.body, ${WRAPPER_CLOSE}) > 0)
      and not exists (
        select 1 from post_content_variants author
        where author.post_id = machine.post_id
          and author.source = 'author'
          and (strpos(author.body, ${WRAPPER_OPEN}) > 0 or strpos(author.body, ${WRAPPER_CLOSE}) > 0)
      )
    order by machine.post_id
    limit ${max}
  `);

  const idsByPost = new Map<string, Set<string>>();
  for (const row of rows) {
    const ids = idsByPost.get(row.post_id) ?? new Set<string>();
    ids.add(row.id);
    idsByPost.set(row.post_id, ids);
  }

  let deleted = 0;
  if (!dryRun) {
    for (const [postId, ids] of idsByPost) {
      // Re-checked under the post's content lock: a row re-translated since the
      // select has a new id and is left alone.
      deleted += await deleteMachineVariants(
        postId,
        (variant) => ids.has(variant.id) && carriesWrapper(variant.body),
      );
    }
  }

  return {
    candidates: rows.length,
    posts: idsByPost.size,
    deleted,
    noOpWrites: !dryRun && rows.length > 0 && deleted === 0,
  };
}

const SCRIPT_NAME = 'purgeWrappedMachineTranslations';

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN !== 'false';
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });

  await connectPostgres();
  const max = Number.parseInt(process.env.PURGE_MAX ?? '', 10);

  try {
    const result = await purgeWrappedMachineTranslations({
      dryRun,
      ...(Number.isFinite(max) && max > 0 ? { max } : {}),
    });
    logger.info(`[${SCRIPT_NAME}] complete`, { dryRun, ...result });
    if (result.noOpWrites) {
      logger.error(`[${SCRIPT_NAME}] identified work but deleted nothing`);
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error(`[${SCRIPT_NAME}] failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(process.exitCode ?? 0))
    .catch((error) => {
      logger.error(`[${SCRIPT_NAME}] failed`, {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
