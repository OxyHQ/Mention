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

const SCRIPT_NAME = 'backfillQuotedPosts';
const DRY_RUN = (process.env.BACKFILL_DRY_RUN ?? 'true') !== 'false';
const MAX = Number(process.env.BACKFILL_MAX ?? 2000);
const AP_CONTENT_TYPE = 'application/activity+json';
/** How often to report progress. A per-candidate network fetch makes this slow. */
const PROGRESS_EVERY = 500;

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

  for await (const post of cursor) {
    scanned += 1;
    // A backfill that fetches per candidate can run for an hour, and one that
    // only logs at its start and end is indistinguishable from one that hung —
    // which is exactly how the first attempt at this had to be killed. Progress
    // is reported as it goes.
    if (scanned % PROGRESS_EVERY === 0) {
      logger.info('[Backfill] quoted posts progress', {
        scanned,
        candidates,
        linked,
        fetchFailures,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
      });
    }
    // Re-checked here too: the query filter is anchored at the raw value while
    // this trims first, so a body with leading whitespace reaches JS unmatched
    // by Mongo. Keeping both means the selection rule has ONE definition that
    // the database merely pre-filters against.
    const body = post.content?.variants?.[0]?.text ?? '';
    if (!RENDERED_QUOTE_PREFIX.test(body.trim())) continue;
    candidates += 1;

    const activityId = post.federation?.activityId;
    if (!activityId) continue;

    let object: Record<string, unknown> | null = null;
    try {
      const res = await signedFetch(activityId, AP_CONTENT_TYPE);
      if (res.ok) object = (await res.json()) as Record<string, unknown>;
    } catch {
      // Fail-soft by design: an unreachable origin leaves the post untouched.
      fetchFailures += 1;
      continue;
    }
    if (!object) continue;

    // THE decision, and it is structural — the body only got us here.
    const quoteUri = extractApQuoteUri(object);
    if (!quoteUri) continue;
    withQuoteField += 1;

    const quotedId = (await resolvePostIdFromObjectUri(quoteUri))
      ?? (await outboxSyncService.ensureQuotedNote(quoteUri));
    if (!quotedId) continue;
    linked += 1;

    if (!DRY_RUN) {
      const result = await Post.updateOne({ _id: post._id }, { $set: { quoteOf: quotedId } });
      written += result.modifiedCount;
    }
  }

  logger.info('[Backfill] quoted posts complete', {
    dryRun: DRY_RUN,
    scanned,
    candidates,
    fetchFailures,
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
