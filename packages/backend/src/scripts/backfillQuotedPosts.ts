/**
 * One-shot admin backfill: link federated posts that QUOTE another post but were
 * stored without the link.
 *
 * Ingest reads the quote URI from the standard AP surfaces and now fetches a
 * quoted post it does not hold. Before that, `quoteOf` resolved only against
 * posts already imported and was left null otherwise — so a quote of any account
 * we did not already hold rendered as a bare `RE: <url>` and stayed that way. A
 * post body is written once, so nothing repairs those on its own.
 *
 * THE `RE:` PREFIX IS A CANDIDATE FILTER, NEVER THE SOURCE OF TRUTH. It is how
 * Mastodon RENDERS a quote for clients that cannot show one, so it is a cheap
 * way to avoid re-fetching every federated post ever stored — but what actually
 * decides is `extractApQuoteUri` reading the STRUCTURED fields off the re-fetched
 * object, exactly as ingest does. A candidate whose object carries no quote field
 * is left alone, however its body opens.
 *
 * The consequence of that split is the one worth knowing: a quote whose body was
 * NOT rendered with `RE:` is missed by this run. That is a coverage limit, not a
 * wrong link — and the script is idempotent and re-runnable, so a better filter
 * later costs nothing.
 *
 * SELECTION:
 *  1. Federated posts (`federation_activity_id` present) with `quote_of` null.
 *  2. Whose PRIMARY body (`post_content_variants` at `position = 0`) opens with
 *     `RE:` followed by an http(s) URL.
 *
 * SAFETY:
 *  1. `BACKFILL_DRY_RUN` defaults to `'true'`; only `=false` writes.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. `BACKFILL_MAX` (default 2000) caps the run; overflow is reported.
 *  4. Writes are counted from what POSTGRES REPORTS MODIFYING, never from "we
 *     called update" — the distinction that hid a whole no-op run of the sibling
 *     backfill until its third execution.
 *  5. Every network fetch goes through the same signed, SSRF-safe, depth-capped
 *     import ingest uses. A failure leaves the post exactly as it is.
 *
 * ── WHY THIS FILE IS POSTGRES ────────────────────────────────────────────────
 *
 * It arrived from `main` writing Mongo (`import mongoose`, `models/Post`) and
 * merged into the port with ZERO conflicts and ZERO type errors, because
 * `models/Post` is among the models the port KEPT — the second instance of that
 * shape in as many absorbs. Post-cutover it would have reported a truthful write
 * count about a table nothing reads, which is strictly worse than a wrong one:
 * a fabricated number invites suspicion and a correct number about the wrong
 * subject does not.
 *
 * ── THREE DELIBERATE DIVERGENCES FROM THE MONGO ORIGINAL ─────────────────────
 *
 * 1. THE `RE:` FILTER IS IN SQL, NOT IN JS AFTER THE LIMIT. Mongo fetched `MAX`
 *    arbitrary federated posts and then filtered them in the loop, so `MAX`
 *    bounded the SCAN rather than the candidates: at 2,000 against a corpus of
 *    federated posts it would have examined a near-empty sample, and because the
 *    limit was unordered a re-run would have examined the SAME sample — the
 *    docblock's "idempotent and re-runnable" was true and useless. Filtering in
 *    the query makes `MAX` bound real candidates, and a linked post drops out of
 *    `quote_of is null` so successive runs make progress.
 *
 * 2. THE DRY RUN NO LONGER IMPORTS. `ensureQuotedNote` STORES the post it
 *    fetches — so the Mongo version's default, token-free `BACKFILL_DRY_RUN=true`
 *    invocation created rows while claiming "only `=false` writes". A dry run
 *    here resolves only against what we already hold and reports the ones it
 *    declined to fetch as `notHeldLocally`, so the under-count is stated rather
 *    than silent.
 *
 * 3. `written` COMES FROM A GUARDED UPDATE. Mongo's `modifiedCount` distinguishes
 *    "matched the row" from "changed the value"; `returning()` does not, and
 *    returns the row either way. Carrying `quote_of is null` into the UPDATE's
 *    own WHERE restores exactly that distinction — a zero there means nothing
 *    changed, which is what `noOpWrites` exists to catch.
 *
 * Runnable as a Fargate one-shot:
 *   BACKFILL_DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillQuotedPosts \
 *   bun packages/backend/dist/src/scripts/backfillQuotedPosts.js
 */

import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { registerAdminScriptServices } from './lib/adminScriptLifecycle';
import { posts } from '../db/schema/posts';
import { postContentVariants } from '../db/schema/postContent';
import { extractApQuoteUri, resolvePostIdFromObjectUri, signedFetch } from '../connectors/activitypub/helpers';
import { outboxSyncService } from '../connectors/activitypub/outbox.service';
import { mapWithConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '../utils/concurrency';

const SCRIPT_NAME = 'backfillQuotedPosts';
const AP_CONTENT_TYPE = 'application/activity+json';
/** How often to report progress, in BATCHES — every row here costs a network fetch. */
const PROGRESS_EVERY_BATCHES = 5;
/**
 * Candidates processed per batch, each batch fanned out at {@link CONCURRENCY}.
 *
 * Every candidate costs a signed fetch of a remote object, so this ran serially
 * at under 0.5 rows/sec — six hours for the 10,446 candidates, dominated by
 * waiting on origins rather than by any work of ours. Bounded fan-out, using the
 * SAME helper the sibling federation scripts use, not a private pool.
 */
const BATCH_SIZE = 200;
const CONCURRENCY = Math.min(
  Math.max(Number(process.env.BACKFILL_CONCURRENCY ?? DEFAULT_CONCURRENCY), 1),
  MAX_CONCURRENCY,
);

export interface QuotedPostBackfillResult {
  /** Bodies matching the rendered-quote filter — the cheap candidate set. */
  candidates: number;
  /**
   * Candidates whose object could not be fetched at all.
   *
   * Carried on the RESULT, not only in a log line, and that is `main`'s point
   * rather than a flourish: a run that reaches the end having failed EVERY fetch
   * is otherwise indistinguishable from one that found nothing to link — both
   * report `linked: 0` and exit clean.
   */
  fetchFailures: number;
  /** Of those, objects whose STRUCTURED fields actually carry a quote URI. */
  withQuoteField: number;
  /**
   * Quote targets we do not already hold. A live run fetches these; a dry run
   * does not, which is why it is reported rather than folded into `linked`.
   */
  notHeldLocally: number;
  /** Quote URIs that resolved to a local post id. */
  linked: number;
  /** Rows Postgres reported MODIFYING — never "we called update". */
  written: number;
  /** Linked rows but wrote none: the silent no-op this reporting exists for. */
  noOpWrites: boolean;
}

/**
 * The backfill itself. The CALLER owns the connection lifecycle, which is what
 * makes this runnable in-process from a test against real rows — the property
 * the Mongo original never had, and the reason its wrong-store bug could only
 * have been caught by reading the file.
 */
export async function backfillQuotedPosts(
  opts: { dryRun?: boolean; max?: number } = {},
): Promise<QuotedPostBackfillResult> {
  const DRY_RUN = opts.dryRun ?? true;
  const MAX = opts.max ?? 2000;

  const db = getDb();

  // `~` is case-sensitive, matching the JS `/^RE:\s*https?:\/\//` this replaces;
  // `[[:space:]]` covers the newline a real Mastodon render puts after the URL.
  const rows = await db
    .select({ id: posts.id, activityId: posts.federationActivityId })
    .from(posts)
    .innerJoin(
      postContentVariants,
      and(eq(postContentVariants.postId, posts.id), eq(postContentVariants.position, 0)),
    )
    .where(and(
      isNotNull(posts.federationActivityId),
      isNull(posts.quoteOf),
      sql`btrim(${postContentVariants.body}) ~ '^RE:[[:space:]]*https?://'`,
    ))
    .limit(MAX);

  let candidates = 0;
  let withQuoteField = 0;
  let notHeldLocally = 0;
  let linked = 0;
  let written = 0;
  let fetchFailures = 0;
  let batches = 0;
  const startedAt = Date.now();

  /**
   * One candidate: re-fetch its object, read the STRUCTURED quote, link it.
   *
   * Extracted so a batch can be fanned out. Every early exit is a `return` rather
   * than a `continue` for the same reason.
   */
  async function processCandidate(row: (typeof rows)[number]): Promise<void> {
    candidates += 1;
    const activityId = row.activityId;
    if (!activityId) return;

    let object: Record<string, unknown> | null = null;
    try {
      const res = await signedFetch(activityId, AP_CONTENT_TYPE);
      if (res.ok) object = (await res.json()) as Record<string, unknown>;
    } catch {
      // Fail-soft by design: an unreachable origin leaves the post untouched.
      fetchFailures += 1;
      return;
    }
    if (!object) return;

    // THE decision, and it is structural — the body only got us here.
    const quoteUri = extractApQuoteUri(object);
    if (!quoteUri) return;
    withQuoteField += 1;

    let quotedId = await resolvePostIdFromObjectUri(quoteUri);
    if (!quotedId) {
      notHeldLocally += 1;
      // OURS, and it survives the fan-out unchanged: `ensureQuotedNote` STORES
      // what it fetches, so a dry run that called it would create rows while the
      // docblock promised "only `=false` writes". `main`'s version reaches it
      // unconditionally.
      if (DRY_RUN) return;
      quotedId = await outboxSyncService.ensureQuotedNote(quoteUri);
    }
    if (!quotedId) return;
    linked += 1;

    if (!DRY_RUN) {
      const updated = await db
        .update(posts)
        .set({ quoteOf: quotedId })
        .where(and(eq(posts.id, row.id), isNull(posts.quoteOf)))
        .returning({ id: posts.id });
      written += updated.length;
    }
  }

  /**
   * BOUNDED FAN-OUT, from `main`, on our own row set.
   *
   * Every candidate costs a signed fetch of a remote object, so serially this ran
   * at under 0.5 rows/sec — `main` measured six hours for 10,446 candidates,
   * dominated by waiting on origins rather than by any work of ours. The helper
   * is the shared `mapWithConcurrency` the sibling federation scripts use, not a
   * private pool.
   *
   * Batched over an ARRAY rather than driven from a cursor: the candidate set is
   * already bounded by `MAX` and filtered in SQL, so there is nothing to stream.
   *
   * Progress is reported per BATCH and counts candidates only. `main` carries a
   * separate `scanned` because its query is unfiltered and the `RE:` test runs in
   * JS, so "rows examined" and "rows that matched" differ there; here the filter
   * is in the query, so the two would be equal by construction and an operator
   * comparing them would read a bug into them.
   */
  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const pending = rows.slice(offset, offset + BATCH_SIZE);
    // Rejections are settled, never thrown: one bad origin must not end the run.
    await mapWithConcurrency(pending, CONCURRENCY, (row) => processCandidate(row));
    batches += 1;
    if (batches % PROGRESS_EVERY_BATCHES === 0) {
      logger.info('[Backfill] quoted posts progress', {
        candidates,
        linked,
        written,
        fetchFailures,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }
  }

  const result: QuotedPostBackfillResult = {
    candidates,
    fetchFailures,
    withQuoteField,
    notHeldLocally,
    linked,
    written,
    noOpWrites: !DRY_RUN && linked > 0 && written === 0,
  };

  logger.info('[Backfill] quoted posts complete', {
    dryRun: DRY_RUN,
    ...result,
    concurrency: CONCURRENCY,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    cappedAt: candidates >= MAX ? MAX : undefined,
  });
  return result;
}

async function main(): Promise<void> {
  const dryRun = (process.env.BACKFILL_DRY_RUN ?? 'true') !== 'false';
  const max = Number(process.env.BACKFILL_MAX ?? 2000);

  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  // Without this, every quoted post we do not already hold fails to import with
  // "PostCreator not registered", is counted as un-importable, and is
  // indistinguishable in the tally from a remote instance refusing us. It cost a
  // full live run: 908 with a quote field, 908 reported un-importable, 0 linked.
  await registerAdminScriptServices();
  logger.info('[Backfill] quoted posts starting', { dryRun, max });
  try {
    await backfillQuotedPosts({ dryRun, max });
  } finally {
    await closePostgres();
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[Backfill] quoted posts failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
