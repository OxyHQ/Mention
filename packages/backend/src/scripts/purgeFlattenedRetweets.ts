/**
 * One-shot repair: DELETE the bridge-flattened retweets that were stored before
 * every ingest path applied the gate.
 *
 * A reviewed bridge does not emit an `Announce` for a retweet. It publishes a
 * plain Note authored by the RETWEETER whose body opens `RT: @original`, and the
 * object carries nothing else — `inReplyTo` null, `tag` empty, no `quoteUrl`, no
 * id of any kind. So the post appears under a byline that did not write it, with
 * a dead `@handle` and no route to the real author. `apPostContent` has refused
 * those since the gate shipped.
 *
 * It refused them ONLY when the caller asked, and until #936 `handleCreate` was
 * the only caller that did — so a Note pulled through the outbox backfill or
 * fetched as a boost original / reply ancestor / quoted note was stored anyway.
 * Measured: 934 posts whose body opens `RT:`, 794 of them from a single
 * registered bridge that `findBridge` already knew about.
 *
 * THIS DELETES, and that is deliberate parity with ingest rather than an
 * escalation: ingest DROPS such a Note, so the row would not exist had it
 * arrived by any other route. Withholding was considered and rejected — a
 * flattened retweet carries no reference to anything, so `incomplete` would
 * promise a promotion that can never happen.
 *
 * IT REUSES THE INGEST PREDICATE RATHER THAN RESTATING IT. `isBridgeFlattenedRetweet`
 * and `FEDERATION_BRIDGE_POLICY` are the same two things the ingest gate
 * consults, so this pass is provably the same decision applied to rows already
 * stored — not a regex that happens to look similar. The SQL `^RT:` term is only
 * a cheap prefilter to keep the scan off bodies that cannot match; what DECIDES
 * is the function.
 *
 * THE HOST GATE IS THE SAFETY. A human on an ordinary instance writing "RT:" is
 * never selected, because the join restricts candidates to actors on a REVIEWED
 * bridge. That is the same asymmetry the predicate's own docblock states: a
 * missed retweet stores what we store today, a false match destroys a real post.
 *
 * Deletion goes through `deletePostRecord`, the repository's one deletion path,
 * so the child rows and the parent's reply counter are handled exactly as any
 * other delete — this script does not know how a post is taken apart and must
 * not learn.
 *
 * Runnable as a Fargate one-shot:
 *   PURGE_DRY_RUN=false CONFIRM_ADMIN_MUTATION=purgeFlattenedRetweets \
 *   bun packages/backend/dist/src/scripts/purgeFlattenedRetweets.js
 *
 * Env:
 *   DATABASE_URL      the Postgres database (injected by ECS from SSM)
 *   PURGE_DRY_RUN     defaults to `true`; only `=false` deletes
 *   PURGE_MAX         candidate cap (default 5000)
 *   CONFIRM_ADMIN_MUTATION=purgeFlattenedRetweets  required for a real apply
 */

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { federatedActors } from '../db/schema/federation';
import { deletePostRecord } from '../db/posts/postRepository';
import { isBridgeFlattenedRetweet } from '../connectors/activitypub/flattenedRetweet';
import { FEDERATION_BRIDGE_POLICY } from '../connectors/activitypub/federationBridgePolicy';

export interface PurgeFlattenedRetweetResult {
  /** Rows on a reviewed bridge whose body opens `RT:` — the cheap prefilter. */
  candidates: number;
  /** Of those, the ones the INGEST PREDICATE actually calls a flattened retweet. */
  matched: number;
  /** Posts `deletePostRecord` reported removing. */
  deleted: number;
  /** True when work was identified and none of it landed. */
  noOpWrites: boolean;
}

export async function purgeFlattenedRetweets(
  opts: { dryRun?: boolean; max?: number } = {},
): Promise<PurgeFlattenedRetweetResult> {
  const DRY_RUN = opts.dryRun ?? true;
  const MAX = opts.max ?? 5000;
  const db = getDb();

  /** Every host the ingest gate treats as a reviewed bridge — one source, not a copy. */
  const bridgeHosts = FEDERATION_BRIDGE_POLICY.map((entry) => entry.host);
  if (bridgeHosts.length === 0) {
    return { candidates: 0, matched: 0, deleted: 0, noOpWrites: false };
  }

  const rows = await db
    .select({ id: posts.id, body: postContentVariants.body })
    .from(posts)
    .innerJoin(
      postContentVariants,
      and(eq(postContentVariants.postId, posts.id), eq(postContentVariants.position, 0)),
    )
    .innerJoin(federatedActors, eq(federatedActors.oxyUserId, posts.oxyUserId))
    .where(and(
      isNotNull(posts.federationActivityId),
      inArray(federatedActors.domain, bridgeHosts),
      sql`${postContentVariants.body} ~ '^RT:'`,
    ))
    .limit(MAX);

  let matched = 0;
  let deleted = 0;

  for (const row of rows) {
    // THE decision, and it is the ingest function — not a restatement of it.
    if (!isBridgeFlattenedRetweet(row.body.trim())) continue;
    matched += 1;
    if (DRY_RUN) continue;

    const record = await deletePostRecord(row.id, undefined);
    if (record) deleted += 1;
  }

  return {
    candidates: rows.length,
    matched,
    deleted,
    noOpWrites: !DRY_RUN && matched > 0 && deleted === 0,
  };
}

const SCRIPT_NAME = 'purgeFlattenedRetweets';

async function main(): Promise<void> {
  const dryRun = process.env.PURGE_DRY_RUN !== 'false';
  // Refuses a destructive run until the operator names the script back. This one
  // DELETES production posts and there is no soft-delete to undo it with.
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });

  await connectPostgres();
  const max = Number.parseInt(process.env.PURGE_MAX ?? '', 10);

  try {
    const result = await purgeFlattenedRetweets({
      dryRun,
      ...(Number.isFinite(max) && max > 0 ? { max } : {}),
    });
    logger.info('[Purge] flattened retweets complete', { dryRun, ...result });
    if (result.noOpWrites) {
      logger.error('[Purge] identified work but deleted nothing');
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error('[Purge] flattened retweets failed', {
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
      logger.error('[Purge] flattened retweets failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
