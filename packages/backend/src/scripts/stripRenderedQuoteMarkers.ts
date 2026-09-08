/**
 * One-shot repair: take the remote server's `RE: <url>` fallback out of the body
 * of every federated post whose quote we ALREADY render.
 *
 * `RE: <url>` is not the author's prose. It is what a server writes into the
 * body so that clients unable to display a quote still surface the reference.
 * Ingest now removes it the moment the quote links, but a body is written once
 * and nothing revisits it, so every row stored before that keeps showing the
 * quote card AND a raw duplicate of the same link. Measured in production:
 *
 *     linked federated quotes        16,324
 *     …still carrying the marker     16,158   (99%)
 *       marker leading  (Mastodon)   14,186
 *       marker trailing (Misskey…)    1,973
 *
 * Reported live on https://mention.earth/p/01a0784a-b5e7-7861-aaa7-f9ad5bbb57b5
 * and https://mention.earth/p/01a07c48-ed74-7965-9ec7-ee294a1b6390, both of
 * which link their quote correctly and show the duplicate anyway.
 *
 * SELECTION IS THE SAFETY, not a regex over the corpus. Only posts with
 * `quote_of` set are considered, and a marker is removed only when it names the
 * URL of the post we actually linked — `federation_url` or
 * `federation_activity_id`, values we wrote ourselves. Both are needed: the
 * declared quote is usually the AP id (`…/users/getkirby/statuses/…`) while the
 * marker renders the WEB url (`…/@getkirby/…`).
 *
 * A POST WITH NO QUOTE IS NEVER TOUCHED. There the marker is the reader's only
 * pointer at the quoted post, and taking it out would destroy the reference —
 * which is also why the withheld (`incomplete`) rows are excluded by the same
 * `quote_of is not null` term.
 *
 * EVERY rendition, not just the primary: a `contentMap` carries one body per
 * language and the remote renders the marker into each.
 *
 * NO NETWORK. Unlike `backfillQuotedPosts` this fetches nothing — it reads rows
 * it can already join and rewrites text — so it is fast, cheap, and safe to run
 * on the service's own task definition.
 *
 * Idempotent: a cleaned body no longer contains the marker, so a second run
 * writes nothing. Writes are counted from what POSTGRES REPORTS MODIFYING.
 *
 * Runnable as a Fargate one-shot:
 *   STRIP_DRY_RUN=false CONFIRM_ADMIN_MUTATION=stripRenderedQuoteMarkers \
 *   bun packages/backend/dist/src/scripts/stripRenderedQuoteMarkers.js
 *
 * Env:
 *   DATABASE_URL       the Postgres database (injected by ECS from SSM)
 *   STRIP_DRY_RUN      defaults to `true`; only `=false` writes
 *   STRIP_MAX          candidate cap (default 50000)
 *   CONFIRM_ADMIN_MUTATION=stripRenderedQuoteMarkers  required for a real apply
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources } from './lib/adminScriptLifecycle';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { stripRenderedQuoteMarker } from '../connectors/activitypub/helpers';

export interface StripQuoteMarkerResult {
  /** Variant rows joined to a linked quote whose body still mentions `RE:`. */
  candidates: number;
  /** Of those, the ones whose marker actually named the linked post. */
  matched: number;
  /** Rows Postgres reported modifying. Zero with `matched > 0` is a defect. */
  written: number;
  /** True when work was identified and none of it landed. */
  noOpWrites: boolean;
}

export async function stripRenderedQuoteMarkers(
  opts: { dryRun?: boolean; max?: number } = {},
): Promise<StripQuoteMarkerResult> {
  const DRY_RUN = opts.dryRun ?? true;
  const MAX = opts.max ?? 50_000;
  const db = getDb();

  /**
   * The join does the narrowing, so the loop only sees rows that could change.
   *
   * `quote_of is not null` is the safety term and is stated first: a post whose
   * quote we did NOT resolve keeps its marker, always. The `~ 'RE:'` term is
   * only there to keep the scan off the bodies that cannot possibly match.
   */
  const quoted = db.$with('quoted').as(
    db
      .select({
        variantId: postContentVariants.id,
        body: postContentVariants.body,
        quotedUrl: sql<string | null>`quoted.federation_url`.as('quoted_url'),
        quotedActivityId: sql<string | null>`quoted.federation_activity_id`.as('quoted_activity_id'),
      })
      .from(postContentVariants)
      .innerJoin(posts, eq(posts.id, postContentVariants.postId))
      .innerJoin(sql`posts as quoted`, sql`quoted.id = ${posts.quoteOf}`)
      .where(and(
        isNotNull(posts.quoteOf),
        isNotNull(posts.federationActivityId),
        sql`${postContentVariants.body} ~ '(^|[[:space:]])RE:[[:space:]]*https?://'`,
      ))
      .limit(MAX),
  );

  const rows = await db.with(quoted).select().from(quoted);

  let matched = 0;
  let written = 0;

  for (const row of rows) {
    const urls = [row.quotedUrl, row.quotedActivityId].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const cleaned = stripRenderedQuoteMarker(row.body, urls);
    if (cleaned === row.body) continue;
    matched += 1;
    if (DRY_RUN) continue;

    // Guarded on the body we READ, so a concurrent edit is not overwritten and a
    // second run cannot double-count: the update matches nothing once the body
    // has already been cleaned.
    const updated = await db
      .update(postContentVariants)
      .set({ body: cleaned })
      .where(and(
        eq(postContentVariants.id, row.variantId),
        eq(postContentVariants.body, row.body),
      ))
      .returning({ id: postContentVariants.id });
    written += updated.length;
  }

  return {
    candidates: rows.length,
    matched,
    written,
    noOpWrites: !DRY_RUN && matched > 0 && written === 0,
  };
}

const SCRIPT_NAME = 'stripRenderedQuoteMarkers';

async function main(): Promise<void> {
  const dryRun = process.env.STRIP_DRY_RUN !== 'false';
  // Refuses a mutating run until the operator names the script back, exactly as
  // its siblings do — this rewrites the body of tens of thousands of posts.
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });

  await connectPostgres();
  const max = Number.parseInt(process.env.STRIP_MAX ?? '', 10);

  try {
    const result = await stripRenderedQuoteMarkers({
      dryRun,
      ...(Number.isFinite(max) && max > 0 ? { max } : {}),
    });
    logger.info('[Strip] rendered quote markers complete', { dryRun, ...result });
    if (result.noOpWrites) {
      logger.error('[Strip] identified work but wrote nothing');
      process.exitCode = 1;
    }
  } catch (error) {
    logger.error('[Strip] rendered quote markers failed', {
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
      logger.error('[Strip] rendered quote markers failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
