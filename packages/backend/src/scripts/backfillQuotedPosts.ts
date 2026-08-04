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
 *  1. Federated posts (`federation.activityId` present) with `quoteOf` unset.
 *  2. Whose primary body opens with `RE:` followed by an http(s) URL.
 *
 * SAFETY:
 *  1. `BACKFILL_DRY_RUN` defaults to `'true'`; only `=false` writes.
 *  2. `assertAdminMutationAllowed` refuses a mutating run until the operator
 *     names the script back.
 *  3. `BACKFILL_MAX` (default 2000) caps the run; overflow is reported.
 *  4. Writes are counted from Mongo's `modifiedCount`, never from "we called
 *     update" — the distinction that hid a whole no-op run of the sibling
 *     backfill until its third execution.
 *  5. Every network fetch goes through the same signed, SSRF-safe, depth-capped
 *     import ingest uses. A failure leaves the post exactly as it is.
 *
 * Runnable as a Fargate one-shot:
 *   BACKFILL_DRY_RUN=false CONFIRM_ADMIN_MUTATION=backfillQuotedPosts \
 *   bun packages/backend/dist/src/scripts/backfillQuotedPosts.js
 */

import mongoose from 'mongoose';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import Post from '../models/Post';
import { extractApQuoteUri, resolvePostIdFromObjectUri, signedFetch } from '../connectors/activitypub/helpers';
import { outboxSyncService } from '../connectors/activitypub/outbox.service';
import { mapWithConcurrency, DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from '../utils/concurrency';

const SCRIPT_NAME = 'backfillQuotedPosts';
const DRY_RUN = (process.env.BACKFILL_DRY_RUN ?? 'true') !== 'false';
const MAX = Number(process.env.BACKFILL_MAX ?? 2000);
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

/** How Mastodon renders a quote when the client cannot show one. A FILTER only. */
const RENDERED_QUOTE_PREFIX = /^RE:\s*https?:\/\//;

async function main(): Promise<void> {
  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun: DRY_RUN });
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  await mongoose.connect(mongoUri, { dbName: `mention-${process.env.NODE_ENV || 'development'}` });
  logger.info('[Backfill] quoted posts starting', { dryRun: DRY_RUN, max: MAX });

  let scanned = 0;
  let candidates = 0;
  let withQuoteField = 0;
  let linked = 0;
  let written = 0;
  let fetchFailures = 0;
  const startedAt = Date.now();

  // THE PREFIX FILTER RUNS IN MONGO, NOT IN JAVASCRIPT, AND THAT IS THE WHOLE
  // DIFFERENCE BETWEEN MINUTES AND HOURS.
  //
  // Measured in production: `federation.activityId` present AND `quoteOf` unset
  // describes 611,100 of 611,607 posts — 99.9% of the collection, because almost
  // nothing is a quote. Testing the body in JS meant streaming every one of those
  // documents, `content.variants` included, over the wire to discard 98.5% of
  // them: 8.5 hours at the rate the first run was managing. With the prefix in
  // the query it is 10,446 documents.
  const cursor = Post
    .find(
      {
        'federation.activityId': { $exists: true },
        quoteOf: { $in: [null, undefined] },
        'content.variants.0.text': { $regex: RENDERED_QUOTE_PREFIX },
      },
      { 'federation.activityId': 1, 'content.variants': 1 },
    )
    .limit(MAX)
    .lean<Array<{ _id: unknown; federation?: { activityId?: string }; content?: { variants?: Array<{ text?: string }> } }>>()
    .cursor();

  /** One candidate: re-fetch its object, read the STRUCTURED quote, link it. */
  async function processCandidate(post: {
    _id: unknown;
    federation?: { activityId?: string };
    content?: { variants?: Array<{ text?: string }> };
  }): Promise<void> {
    // Re-checked here too: the query filter is anchored at the raw value while
    // this trims first, so a body with leading whitespace reaches JS unmatched
    // by Mongo. Keeping both means the selection rule has ONE definition that
    // the database merely pre-filters against.
    const body = post.content?.variants?.[0]?.text ?? '';
    if (!RENDERED_QUOTE_PREFIX.test(body.trim())) return;
    candidates += 1;

    const activityId = post.federation?.activityId;
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

    const quotedId = (await resolvePostIdFromObjectUri(quoteUri))
      ?? (await outboxSyncService.ensureQuotedNote(quoteUri));
    if (!quotedId) return;
    linked += 1;

    if (!DRY_RUN) {
      const result = await Post.updateOne({ _id: post._id }, { $set: { quoteOf: quotedId } });
      written += result.modifiedCount;
    }
  }

  let batch: Array<Parameters<typeof processCandidate>[0]> = [];
  let batches = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const pending = batch;
    batch = [];
    batches += 1;
    // Rejections are settled, never thrown: one bad origin must not end the run.
    await mapWithConcurrency(pending, CONCURRENCY, (post) => processCandidate(post));
    if (batches % PROGRESS_EVERY_BATCHES === 0) {
      logger.info('[Backfill] quoted posts progress', {
        scanned,
        candidates,
        linked,
        fetchFailures,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }
  };

  for await (const post of cursor) {
    scanned += 1;
    batch.push(post);
    if (batch.length >= BATCH_SIZE) await flush();
  }
  await flush();

  logger.info('[Backfill] quoted posts complete', {
    dryRun: DRY_RUN,
    scanned,
    candidates,
    fetchFailures,
    concurrency: CONCURRENCY,
    elapsedSec: Math.round((Date.now() - startedAt) / 1000),
    withQuoteField,
    linked,
    written,
    noOpWrites: !DRY_RUN && linked > 0 && written === 0,
  });
  await mongoose.disconnect();
}

main().catch((error) => {
  logger.error('[Backfill] quoted posts failed', {
    reason: error instanceof Error ? error.message : 'unknown',
  });
  process.exit(1);
});
