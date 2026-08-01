/**
 * One-shot REPAIR: re-resolve @mentions on ALREADY-STORED federated posts.
 *
 * WHY
 *   Two inbound-@mention bugs were fixed in the ingest paths, and BOTH fixes are
 *   forward-only:
 *     1. Mastodon writes a `Mention` tag's `name` RELATIVE TO THE AUTHOR, so a
 *        mention of someone on the author's OWN instance arrives as the bare
 *        `@user` with no `@domain`. The reconstructed `https://<domain>/@<user>`
 *        anchor candidate was therefore never built, the in-content anchor
 *        matched nothing, and `htmlToPlainText` stripped it to dead `@user` text
 *        — the single most common mention shape of all (two users of the same
 *        remote instance talking to each other).
 *     2. An anchor whose child is PLAIN TEXT (Bridgy Fed and friends) hits
 *        `htmlToPlainText`'s link-to-URL rule instead, so an unresolved mention
 *        degrades to the raw `https://<domain>/@<user>` profile URL in the body.
 *
 *   Posts imported before those fixes keep the damage, and they CANNOT be
 *   repaired offline: the stored body is PLAIN TEXT (`htmlToPlainText` runs at
 *   ingest and the anchor `href` is discarded), so the anchor→actor mapping only
 *   exists in the origin's HTML. Each post has to be re-fetched from its origin.
 *
 * SELECTION FILTER (stated explicitly — the candidate count is logged up front)
 *   A post is a candidate when ALL of the following hold:
 *     - `federation.activityId` is present (it is a federated import);
 *     - `type !== 'boost'` (a boost body is intentionally empty and carries no
 *       mentions of its own — see the boost-hydration contract);
 *     - the `mentions` allowlist is ABSENT, null, or EMPTY (nothing resolved);
 *     - some stored body variant matches `/@[A-Za-z0-9_]/` — an `@` followed by a
 *       username character. That ONE regex covers both damage shapes above: the
 *       bare `@user` text AND the raw `https://host/@user` profile URL.
 *   Optionally narrowed to one origin actor via `REPAIR_ACTOR_URI`.
 *
 *   Deliberately narrow, with two known trade-offs:
 *     - a PARTIALLY-resolved post (some mentions stored, one anchor still raw) is
 *       NOT selected. Widening to "any federated post with an `@` in the body"
 *       would re-fetch essentially the whole federated corpus to catch a small
 *       tail; run this sweep first and revisit that tail with evidence.
 *     - the regex also matches ordinary text (an email address, an `@` used as a
 *       word). Those cost one re-fetch and resolve to zero mentions, so they are
 *       counted `unresolved` and written to nothing.
 *
 * WHAT IT DOES PER CANDIDATE
 *   Re-fetches the source Note over the project's SIGNED, SSRF-safe transport
 *   (`signedFetch` — DNS-pinned, per-hop re-signed, deadline-bounded; never a
 *   bare `fetch`), then re-runs the SHARED ingest helpers on the returned HTML:
 *   `resolveInboundMentionsExisting` → `applyMentionPlaceholders` →
 *   `buildFederatedNoteVariants`. The re-derived body text is applied onto the
 *   STORED variants via `repairVariantText`, so the language tags / `source` a
 *   variant already carries survive the repair. Body and `mentions` are written
 *   together in ONE `$set` so they can never drift apart, exactly like the live
 *   outbox self-heal (`OutboxSyncService.healExistingMentions`).
 *
 *   Mentions resolve LOOKUP-ONLY (`resolveInboundMentionsExisting`): a bulk
 *   sweep must never fetch or MINT a `FederatedActor` for a mentioned account, or
 *   it would pollute the federated index with thousands of 0-post ghost users for
 *   the deleted/spam accounts a legacy post happened to mention. An actor with no
 *   stored row is simply skipped and its anchor stays raw text.
 *
 * OUTCOMES (per post)
 *   `repaired`          a field changed — written (or, under DRY_RUN, would be)
 *   `unchanged`         re-mapping matched what is stored; nothing written
 *   `unresolved`        no mention resolved to an already-known identity
 *   `gone`              origin answered 404/410 — SKIPPED, never deleted
 *   `fetchFailed`       transient failure / timeout — left for a later re-run
 *   `skippedNoSource`   no `federation.url` or `federation.activityId` to fetch
 *   `skippedEmptyBody`  re-derive produced no body; an existing body is NEVER blanked
 *
 * SAFETY / SHAPE
 *   - Idempotent + re-runnable: a repaired post gains a non-empty `mentions`
 *     array and so leaves the candidate set entirely; even if it were re-scanned,
 *     an unchanged re-mapping stages no write at all.
 *   - Stable ASCENDING `_id` cursor. The repair only ever REMOVES posts from the
 *     matching set, so no page is revisited and none is skipped.
 *   - Writes are explicit `$set` field whitelists (`content.variants`, `mentions`)
 *     through `bulkWrite({ ordered: false })` — never a document spread.
 *   - Bounded concurrency per page, and a per-note wall-clock timeout around the
 *     READ-ONLY fetch only (a live write is never raced against a timer it cannot
 *     cancel). A slow, dead, deleted or unreachable origin skips ONE post and
 *     never aborts the run.
 *   - A completed run with unresolved work exits NON-ZERO (`assertAdminRunComplete`)
 *     so a partial sweep is never reported as a success.
 *
 * ENV
 *   DRY_RUN=true              resolve + report, write NOTHING. Collects a sample
 *                             of before/after bodies on the RETURNED summary (the
 *                             run logs only how many — see {@link RepairSample}).
 *   REPAIR_BATCH_SIZE=500     posts per `_id` page
 *   REPAIR_CONCURRENCY=8      posts re-fetched in parallel (clamped to 32)
 *   REPAIR_LIMIT=<n>          cap total posts scanned (canary budget)
 *   REPAIR_ACTOR_URI=<uri>    restrict to one `federation.actorUri`
 *   REPAIR_NOTE_TIMEOUT_MS    per-note fetch budget (default 20000)
 *   REPAIR_SAMPLE_SIZE=5      before/after samples collected under DRY_RUN
 *
 * RUN AS A FARGATE ONE-SHOT (dry run FIRST):
 *   DRY_RUN=true REPAIR_LIMIT=50 \
 *     bun packages/backend/dist/src/scripts/repairFederatedMentions.js
 *   CONFIRM_ADMIN_MUTATION=repairFederatedMentions \
 *     bun packages/backend/dist/src/scripts/repairFederatedMentions.js
 *
 * REVIEW THE ACTUAL BEFORE/AFTER BODIES (they are returned, never logged):
 *   bun -e "const m=require('./packages/backend/dist/src/scripts/repairFederatedMentions');\
 *   const g=require('mongoose');(async()=>{await g.connect(process.env.MONGODB_URI);\
 *   console.dir((await m.repairFederatedMentions({dryRun:true,limit:20})).samples,{depth:null});\
 *   await g.disconnect();})()"
 */

import mongoose from 'mongoose';
import { PostType, type MediaItem, type PostContentVariant } from '@mention/shared-types';
import { Post } from '../models/Post';
import { logger } from '../utils/logger';
import { applyMentionPlaceholders, resolveInboundMentionsExisting } from '../connectors/activitypub/apMentions';
import { buildFederatedNoteVariants } from '../connectors/activitypub/apPostContent';
import { runWithTimeout, signedFetch } from '../connectors/activitypub/helpers';
import { AP_CONTENT_TYPE } from '../connectors/activitypub/constants';
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, mapWithConcurrency } from '../utils/concurrency';
import { repairVariantText } from './lib/variantTextRepair';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import {
  assertAdminRunComplete,
  closeAdminScriptResources,
} from './lib/adminScriptLifecycle';

/** Posts scanned per `_id` page when the caller supplies no batch size. */
const DEFAULT_PAGE_SIZE = 500;

/** Staged updates flushed per `bulkWrite` chunk. */
const BULK_CHUNK_SIZE = 500;

/** Per-note wall-clock budget for the READ-ONLY source re-fetch. */
const DEFAULT_NOTE_TIMEOUT_MS = 20_000;

/** Before/after samples a DRY RUN collects. */
const DEFAULT_SAMPLE_SIZE = 5;

/** HTTP statuses that mean the remote object is permanently gone. */
const GONE_STATUS_CODES = new Set([404, 410]);

/**
 * An `@` followed by a username character — the residue BOTH pre-fix damage
 * shapes leave in a stored body: the bare `@user` a stripped Mastodon anchor
 * degrades to, and the `/@user` inside the raw `https://host/@user` profile URL a
 * plain-text-child anchor degrades to.
 */
const UNLINKED_MENTION_TEXT_REGEX = /@[A-Za-z0-9_]/;

/** Per-post repair outcome. */
type RepairOutcome =
  | 'repaired'
  | 'unchanged'
  | 'unresolved'
  | 'gone'
  | 'fetch-failed'
  | 'skipped-no-source'
  | 'skipped-empty-body';

/** The lean Post fields the repair reads. */
interface CandidatePostRow {
  _id: mongoose.Types.ObjectId;
  mentions?: string[] | null;
  content?: {
    variants?: PostContentVariant[];
    media?: MediaItem[];
  } | null;
  federation?: {
    activityId?: string;
    actorUri?: string;
    url?: string;
  } | null;
}

/** The projection the page cursor reads — nothing else is needed to repair. */
const CANDIDATE_PROJECTION: Record<string, 1> = {
  _id: 1,
  mentions: 1,
  'content.variants': 1,
  'content.media': 1,
  federation: 1,
};

/**
 * One reviewed before/after pair, collected under DRY_RUN.
 *
 * RETURNED, never LOGGED. The backend logging policy forbids putting post ids or
 * bodies into a log record (enforced by `__tests__/utils/loggerPolicy.test.ts`),
 * and a bulk sweep is exactly the shape that would dump a corpus into CloudWatch.
 * The run logs only how many samples it collected; an operator reviews the actual
 * rewrite by calling the exported function in-process — see the header docblock.
 */
export interface RepairSample {
  id: string;
  /** The PRIMARY stored body, JSON-quoted so placeholders/whitespace are visible. */
  before: string;
  /** The PRIMARY body the repair would write, JSON-quoted. */
  after: string;
  /** The `mentions` allowlist the repair would write. */
  mentions: string[];
}

export interface RepairFederatedMentionsOptions {
  /** Resolve + report, write nothing. */
  dryRun?: boolean;
  /** Posts per `_id` page. */
  batchSize?: number;
  /** Posts re-fetched in parallel (clamped to {@link MAX_CONCURRENCY}). */
  concurrency?: number;
  /** Cap the total number of posts scanned. */
  limit?: number;
  /** Restrict the sweep to one `federation.actorUri`. */
  actorUri?: string;
  /** Per-note wall-clock budget for the read-only source re-fetch. */
  noteTimeoutMs?: number;
  /** How many before/after samples a dry run collects. */
  sampleSize?: number;
}

export interface RepairFederatedMentionsSummary {
  dryRun: boolean;
  /** Candidates the selection filter matched, counted before the sweep started. */
  candidates: number;
  scanned: number;
  repaired: number;
  unchanged: number;
  unresolved: number;
  gone: number;
  fetchFailed: number;
  skippedNoSource: number;
  skippedEmptyBody: number;
  /** Documents Mongo reported as modified (always 0 under DRY_RUN). */
  written: number;
  samples: RepairSample[];
}

/** Outcome of re-fetching a post's source AP object. */
type ApFetchOutcome =
  | { kind: 'ok'; object: Record<string, unknown> }
  | { kind: 'gone' }
  | { kind: 'error' };

/**
 * Re-fetch a post's source AP object over the signed, SSRF-safe transport,
 * classifying the result so the caller can tell a permanently-removed object
 * (`gone`, skip forever) from a transient failure (`error`, retry on a later
 * run). Never throws — mirrors `reingestEmptyFederatedPosts` / `reingestBlueskyPosts`.
 */
async function fetchApObject(url: string): Promise<ApFetchOutcome> {
  let res: Response;
  try {
    res = await signedFetch(url, AP_CONTENT_TYPE);
  } catch (err) {
    logger.warn('[repairFederatedMentions] ActivityPub fetch failed', { error: err });
    return { kind: 'error' };
  }

  if (GONE_STATUS_CODES.has(res.status)) return { kind: 'gone' };
  if (!res.ok) {
    logger.warn('[repairFederatedMentions] ActivityPub fetch returned an error status', {
      status: res.status,
    });
    return { kind: 'error' };
  }

  try {
    // `res.json()` is typed `any`; keep it `unknown` and narrow after validation
    // so no `any` leaks into the caller.
    const object: unknown = await res.json();
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      logger.warn('[repairFederatedMentions] ActivityPub fetch returned a non-object payload');
      return { kind: 'error' };
    }
    return { kind: 'ok', object: object as Record<string, unknown> };
  } catch (err) {
    logger.warn('[repairFederatedMentions] ActivityPub payload parsing failed', { error: err });
    return { kind: 'error' };
  }
}

/**
 * Build the candidate filter documented at the top of this file. Kept separate
 * (and exported) so the exact selection can be asserted by a test rather than
 * re-described in prose.
 */
export function buildCandidateFilter(actorUri?: string): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    'federation.activityId': { $exists: true, $ne: null },
    type: { $ne: PostType.BOOST },
    // Nothing resolved: absent, null, or an empty array.
    $or: [
      { mentions: { $exists: false } },
      { mentions: null },
      { mentions: { $size: 0 } },
    ],
    // Some stored body still carries the residue of an unlinked mention.
    'content.variants.text': { $regex: UNLINKED_MENTION_TEXT_REGEX },
  };
  if (actorUri) filter['federation.actorUri'] = actorUri;
  return filter;
}

/** Order-independent equality of two string arrays (treated as sets/bags). */
function sortedStringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, i) => value === right[i]);
}

/** JSON-quote a body so placeholders and whitespace are actually visible. */
function renderBody(value: string | undefined): string {
  return JSON.stringify(value ?? '');
}

/** A prepared repair: the outcome, plus the staged write when there is one. */
interface PreparedRepair {
  outcome: RepairOutcome;
  op?: mongoose.AnyBulkWriteOperation<typeof Post>;
  sample?: RepairSample;
}

/**
 * Re-fetch ONE post's source Note and stage its mention repair. Performs NO
 * write itself: the caller flushes the returned op through `bulkWrite`, so every
 * mutation is batched and every counter is tallied on a single call stack.
 */
async function prepareRepair(
  post: CandidatePostRow,
  noteTimeoutMs: number,
): Promise<PreparedRepair> {
  const sourceUrl = post.federation?.url || post.federation?.activityId;
  if (!sourceUrl) return { outcome: 'skipped-no-source' };

  // The fetch is READ-ONLY, so abandoning it on the deadline is safe. The live
  // write below is never raced against a timer it could not cancel.
  const fetched = await runWithTimeout(fetchApObject(sourceUrl), noteTimeoutMs);
  if (fetched === null) {
    logger.warn('[repairFederatedMentions] source re-fetch timed out; skipping', {
      durationMs: noteTimeoutMs,
    });
    return { outcome: 'fetch-failed' };
  }
  if (fetched.kind === 'error') return { outcome: 'fetch-failed' };
  // Content-bearing: the local copy still renders and may carry local
  // engagement, so a removed upstream is never a reason to touch it.
  if (fetched.kind === 'gone') return { outcome: 'gone' };

  // LOOKUP-ONLY resolution: never fetches, never mints a `FederatedActor`.
  const resolved = await resolveInboundMentionsExisting(fetched.object);
  if (resolved.ids.length === 0) return { outcome: 'unresolved' };

  const noteObject = applyMentionPlaceholders(fetched.object, resolved.anchorMap);
  const hasMedia = (post.content?.media?.length ?? 0) > 0;
  // Re-derive the body ONLY (no media I/O — the stored media state is reused via
  // `hasMedia`), exactly like the live outbox self-heal.
  const freshVariants = buildFederatedNoteVariants(noteObject, hasMedia);
  if (freshVariants.length === 0) return { outcome: 'skipped-empty-body' };

  const storedVariants = post.content?.variants;
  const repairedVariants = repairVariantText(
    freshVariants.map((variant) => variant.text),
    storedVariants,
  );

  const setOps: Record<string, unknown> = {};
  if (repairedVariants) setOps['content.variants'] = repairedVariants;
  if (!sortedStringArrayEqual(resolved.ids, post.mentions ?? [])) {
    setOps.mentions = resolved.ids;
  }

  // Nothing to change: the stored state already matches a fresh re-map. An empty
  // `$set` is also an illegal update, so this must stay a guard rather than an
  // optimization. Idempotency for the SHIPPED filter comes one level up (a
  // repaired post no longer matches it); this branch is what keeps an in-process
  // caller with a wider filter from churning `updatedAt` across the corpus.
  if (Object.keys(setOps).length === 0) return { outcome: 'unchanged' };

  return {
    outcome: 'repaired',
    op: {
      updateOne: {
        filter: { _id: post._id },
        // Explicit field whitelist — never a spread of a re-mapped document.
        update: { $set: setOps },
      },
    },
    sample: {
      id: post._id.toString(),
      before: renderBody(storedVariants?.[0]?.text),
      after: renderBody((repairedVariants ?? storedVariants)?.[0]?.text),
      mentions: resolved.ids,
    },
  };
}

/**
 * Re-resolve @mentions across the already-stored federated corpus.
 *
 * Operates on the `Post` model only — the caller owns the Mongo connection
 * lifecycle — so it is unit-testable against a mocked model and reusable from an
 * in-process caller.
 */
export async function repairFederatedMentions(
  options: RepairFederatedMentionsOptions = {},
): Promise<RepairFederatedMentionsSummary> {
  const dryRun = options.dryRun ?? false;
  const pageSize = options.batchSize ?? DEFAULT_PAGE_SIZE;
  const concurrency = Math.min(Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY), MAX_CONCURRENCY);
  const noteTimeoutMs = options.noteTimeoutMs ?? DEFAULT_NOTE_TIMEOUT_MS;
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;

  const baseFilter = buildCandidateFilter(options.actorUri);
  const candidates = await Post.countDocuments(baseFilter);
  logger.info('[repairFederatedMentions] candidate posts selected', {
    count: candidates,
    dryRun,
    concurrency,
    narrowedScope: Boolean(options.actorUri),
  });

  const summary: RepairFederatedMentionsSummary = {
    dryRun,
    candidates,
    scanned: 0,
    repaired: 0,
    unchanged: 0,
    unresolved: 0,
    gone: 0,
    fetchFailed: 0,
    skippedNoSource: 0,
    skippedEmptyBody: 0,
    written: 0,
    samples: [],
  };
  if (candidates === 0) {
    logger.info('[repairFederatedMentions] nothing to do');
    return summary;
  }

  let remaining = options.limit;
  let lastId: mongoose.Types.ObjectId | null = null;
  let pendingOps: mongoose.AnyBulkWriteOperation<typeof Post>[] = [];

  // A dry run stages every operation exactly as a real one does — it just never
  // hands them to Mongo. That is the guarantee: what it reports is what a real
  // run would write, computed by the same code.
  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    if (dryRun) {
      pendingOps = [];
      return;
    }
    const result = await Post.bulkWrite(pendingOps, { ordered: false });
    summary.written += result.modifiedCount ?? 0;
    pendingOps = [];
  };

  // Forward-only cursor. The repair only ever removes a post from the matching
  // set (it fills in `mentions`, which the filter selects on), so no page is
  // revisited and none is skipped.
  for (;;) {
    if (remaining !== undefined && remaining <= 0) break;

    const pageFilter: Record<string, unknown> = { ...baseFilter };
    if (lastId) pageFilter._id = { $gt: lastId };

    const pageLimit = remaining !== undefined ? Math.min(pageSize, remaining) : pageSize;
    const page = await Post.find(pageFilter, CANDIDATE_PROJECTION)
      .sort({ _id: 1 })
      .limit(pageLimit)
      .lean<CandidatePostRow[]>();

    if (page.length === 0) break;

    // The page is already sliced to at most the remaining budget, so repairing
    // the WHOLE page in a bounded pool can never overshoot the limit.
    const settled = await mapWithConcurrency(page, concurrency, (post) =>
      prepareRepair(post, noteTimeoutMs),
    );

    // Tally sequentially in `_id` order AFTER the pool drains: every counter and
    // the shared budget is mutated exactly once per post on a single call stack.
    for (let i = 0; i < page.length; i++) {
      summary.scanned += 1;
      if (remaining !== undefined) remaining -= 1;

      const result = settled[i];
      let prepared: PreparedRepair;
      if (result.status === 'fulfilled') {
        prepared = result.value;
      } else {
        // One bad post never aborts the run; classify it as transient so a later
        // run can still recover it.
        logger.warn('[repairFederatedMentions] post repair failed; skipping', {
          error: result.reason,
        });
        prepared = { outcome: 'fetch-failed' };
      }

      switch (prepared.outcome) {
        case 'repaired':
          summary.repaired += 1;
          if (prepared.sample && summary.samples.length < sampleSize) {
            summary.samples.push(prepared.sample);
          }
          if (prepared.op) {
            pendingOps.push(prepared.op);
            if (pendingOps.length >= BULK_CHUNK_SIZE) await flush();
          }
          break;
        case 'unchanged':
          summary.unchanged += 1;
          break;
        case 'unresolved':
          summary.unresolved += 1;
          break;
        case 'gone':
          summary.gone += 1;
          break;
        case 'fetch-failed':
          summary.fetchFailed += 1;
          break;
        case 'skipped-no-source':
          summary.skippedNoSource += 1;
          break;
        case 'skipped-empty-body':
          summary.skippedEmptyBody += 1;
          break;
      }
    }

    lastId = page[page.length - 1]._id;
    // Counters ride in the structured CONTEXT, never interpolated into the
    // message — the backend logging policy (and its test,
    // `__tests__/utils/loggerPolicy.test.ts`) forbids the latter.
    logger.info('[repairFederatedMentions] progress', {
      dryRun,
      total: candidates,
      scanned: summary.scanned,
      repaired: summary.repaired,
      unchanged: summary.unchanged,
      unresolved: summary.unresolved,
      gone: summary.gone,
      fetchFailed: summary.fetchFailed,
      skippedNoSource: summary.skippedNoSource,
      skippedEmptyBody: summary.skippedEmptyBody,
    });
  }

  await flush();
  return summary;
}

/** Parse a strictly-positive integer env value, falling back on absent/invalid input. */
function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/mention';
  const dbName = `mention-${process.env.NODE_ENV || 'development'}`;
  const dryRun = process.env.DRY_RUN === 'true';

  try {
    assertAdminMutationAllowed({ scriptName: 'repairFederatedMentions', dryRun });
    await mongoose.connect(mongoUri, { dbName });
    logger.info('[repairFederatedMentions] connected to MongoDB', { dryRun });

    const summary = await repairFederatedMentions({
      dryRun,
      batchSize: parsePositiveInt(process.env.REPAIR_BATCH_SIZE, DEFAULT_PAGE_SIZE),
      concurrency: parsePositiveInt(process.env.REPAIR_CONCURRENCY, DEFAULT_CONCURRENCY),
      limit: process.env.REPAIR_LIMIT ? parsePositiveInt(process.env.REPAIR_LIMIT, 0) : undefined,
      actorUri: process.env.REPAIR_ACTOR_URI?.trim() || undefined,
      noteTimeoutMs: parsePositiveInt(process.env.REPAIR_NOTE_TIMEOUT_MS, DEFAULT_NOTE_TIMEOUT_MS),
      sampleSize: parsePositiveInt(process.env.REPAIR_SAMPLE_SIZE, DEFAULT_SAMPLE_SIZE),
    });

    // ONE machine-readable summary record for a Fargate one-shot's log scrape:
    // pino emits exactly one JSON line per call, so the structured context IS
    // the scrapeable line. The before/after samples are deliberately NOT logged
    // (see {@link RepairSample}); only how many were collected.
    logger.info('[repairFederatedMentions] summary', {
      dryRun: summary.dryRun,
      total: summary.candidates,
      scanned: summary.scanned,
      repaired: summary.repaired,
      unchanged: summary.unchanged,
      unresolved: summary.unresolved,
      gone: summary.gone,
      fetchFailed: summary.fetchFailed,
      skippedNoSource: summary.skippedNoSource,
      skippedEmptyBody: summary.skippedEmptyBody,
      written: summary.written,
      sampled: summary.samples.length,
      durationMs: Date.now() - startedAt,
    });

    // A sweep that could not read some origins is INCOMPLETE, not successful —
    // exit non-zero so the operator re-runs it rather than assuming it is done.
    // `gone` and `unresolved` are terminal, expected states and are not failures.
    assertAdminRunComplete('repairFederatedMentions', {
      fetchFailed: summary.fetchFailed,
      skippedNoSource: summary.skippedNoSource,
      skippedEmptyBody: summary.skippedEmptyBody,
    });
  } catch (error) {
    logger.error('[repairFederatedMentions] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect().catch((disconnectError) => {
      logger.warn('[repairFederatedMentions] error during mongoose.disconnect()', disconnectError);
    });
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis connections, media
  // cache workers) keep the event loop alive, so the process would otherwise sit
  // RUNNING after the work completes. Mirrors the other federation one-shots.
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error('[repairFederatedMentions] unhandled failure', error);
      process.exit(1);
    });
}

export default repairFederatedMentions;
