/**
 * One-shot repair: DELETE the bridge-flattened retweets stored before the
 * ingest gate decided on the bridge's own text.
 *
 * A reviewed bridge (mastox.eu) does not emit an `Announce` for a retweet. It
 * publishes a plain Note authored by the RETWEETER whose body opens
 * `RT: @original`, carrying no reference to the original: no quote field, no
 * upstream link, no tweet id. So the post appears under a byline that did not
 * write it, with no route to the real author, and ingest drops such Notes
 * (`flattenedRetweet.ts`).
 *
 * It missed every one whose author the bridge tagged as a mention: the gate read
 * the body after the mention had become a `[mention:<id>]` placeholder, and
 * `RT: [mention:…]` does not open `RT: @`. Those rows are what this removes. A
 * flattened retweet carries nothing that could ever be resolved into the boost it
 * is, so there is nothing to repair and withholding would only hide a row that
 * can never be shown. The same retweets arrive correctly — as a boost of the
 * original under its real author — only through a bridge that sends `Announce`.
 *
 * THE DECISION IS THE INGEST'S. `isStoredBridgeFlattenedRetweet` reads a stored
 * mention back as the `@` it was and tests the same marker on the same reviewed
 * hosts, so this pass applies the ingest decision to rows already stored. The
 * SQL `^RT:` term is only a cheap prefilter; the function decides.
 *
 * THE HOST GATE IS THE SAFETY. A row is a candidate only when the transport that
 * stored it — its actor URI, or for the rows the dependency import once stored
 * without one, its own activity id — is a REVIEWED bridge. A human on an ordinary
 * instance writing "RT:" is never selected.
 *
 * Deletion goes through `deleteFederatedPostSubtree`, the path an inbound
 * `Delete` takes, so the cascade, the surviving counters and the recent-replier
 * projection are handled exactly as for any other removed federated post.
 *
 * Runnable as a Fargate one-shot:
 *   PURGE_DRY_RUN=false CONFIRM_ADMIN_MUTATION=purgeFlattenedRetweets \
 *   bun packages/backend/dist/src/scripts/purgeFlattenedRetweets.js
 *
 * Env:
 *   DATABASE_URL       the Postgres database (injected by ECS from SSM)
 *   PURGE_DRY_RUN      defaults to `true`; only `=false` deletes
 *   PURGE_MAX          candidate cap (default 5000)
 *   PURGE_OXY_USER_ID  optional: only this author's posts
 *   CONFIRM_ADMIN_MUTATION=purgeFlattenedRetweets  required for a real apply
 */

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { deleteFederatedPostSubtree } from '../services/FederatedPostDeletionService';
import { isStoredBridgeFlattenedRetweet } from '../connectors/activitypub/flattenedRetweet';
import { REVIEWED_REPOST_TRANSPORT_HOSTS } from '../connectors/activitypub/repostTransportPolicy';
import { getRemoteHost } from '../connectors/shared/url';

export interface PurgeFlattenedRetweetResult {
  /** Rows on a reviewed bridge whose body opens `RT:` — the cheap prefilter. */
  candidates: number;
  /** Of those, the ones the INGEST DECISION calls a flattened retweet. */
  matched: number;
  /** `matched` per transport host. */
  matchedByHost: Record<string, number>;
  /** Posts the deletion path removed. */
  deleted: number;
  /** Matched posts whose subtree the cascade refused as too large. */
  tooLarge: number;
  /** True when work was identified and none of it landed. */
  noOpWrites: boolean;
}

export async function purgeFlattenedRetweets(
  opts: { dryRun?: boolean; max?: number; oxyUserId?: string } = {},
): Promise<PurgeFlattenedRetweetResult> {
  const DRY_RUN = opts.dryRun ?? true;
  const MAX = opts.max ?? 5000;

  /** The transport that stored the row: its actor, else its own activity id. */
  const transport = sql<string>`coalesce(${posts.federationActorUri}, ${posts.federationActivityId})`;
  const rows = await getDb()
    .select({
      id: posts.id,
      actorUri: posts.federationActorUri,
      transport,
      body: postContentVariants.body,
    })
    .from(posts)
    .innerJoin(
      postContentVariants,
      and(eq(postContentVariants.postId, posts.id), eq(postContentVariants.position, 0)),
    )
    .where(
      and(
        isNotNull(posts.federationActivityId),
        opts.oxyUserId ? eq(posts.oxyUserId, opts.oxyUserId) : undefined,
        inArray(sql`lower(split_part(${transport}, '/', 3))`, [...REVIEWED_REPOST_TRANSPORT_HOSTS]),
        sql`${postContentVariants.body} ~ '^\\s*RT:'`,
      ),
    )
    .orderBy(asc(posts.id))
    .limit(MAX);

  const matchedByHost: Record<string, number> = {};
  let matched = 0;
  let deleted = 0;
  let tooLarge = 0;

  for (const row of rows) {
    if (!isStoredBridgeFlattenedRetweet(row.body, row.transport)) continue;
    matched += 1;
    const host = getRemoteHost(row.transport) ?? 'unknown';
    matchedByHost[host] = (matchedByHost[host] ?? 0) + 1;
    if (DRY_RUN) continue;

    const result = await deleteFederatedPostSubtree(row.id, row.actorUri);
    if (result === 'deleted') deleted += 1;
    else if (result === 'too-large') tooLarge += 1;
  }

  return {
    candidates: rows.length,
    matched,
    matchedByHost,
    deleted,
    tooLarge,
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
  const oxyUserId = process.env.PURGE_OXY_USER_ID?.trim();

  try {
    const result = await purgeFlattenedRetweets({
      dryRun,
      ...(Number.isFinite(max) && max > 0 ? { max } : {}),
      ...(oxyUserId ? { oxyUserId } : {}),
    });
    logger.info('[Purge] flattened retweets complete', { dryRun, ...result });
    if (result.noOpWrites || result.tooLarge > 0) {
      logger.error('[Purge] flattened retweets incomplete');
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
