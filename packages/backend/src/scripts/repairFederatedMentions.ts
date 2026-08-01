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
 *   bare `fetch`) at `federation.activityId`, the ActivityPub OBJECT ID — never
 *   preferring `federation.url`, the human web page (see {@link resolveSourceUrl}
 *   for why: the first production dry run had 40 of 50 fetches rejected on
 *   content-type because the web page answers HTML). Then it re-runs the SHARED
 *   ingest helpers on the returned HTML:
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
 *   `fetchFailed`       transient failure / timeout — left for a later re-run,
 *                       split by cause in `fetchFailedByReason` (`timeout`,
 *                       `transport`, `httpStatus`, `nonObjectPayload`,
 *                       `malformedJson`) and detailed per post in `failures[]`
 *   `skippedNoSource`   no `federation.activityId` or `federation.url` to fetch
 *   `skippedEmptyBody`  re-derive produced no body; an existing body is NEVER blanked
 *
 * DIAGNOSING A RUN
 *   Every failed re-fetch emits ONE structured warn carrying the attempted URL,
 *   which `federation` field it came from, the failure class, the HTTP status and
 *   the media type the origin actually served. The backend logger reduces a URL
 *   to its host (path redacted) and redacts a 24-hex ObjectId outright, so the
 *   LOG identifies the failing instance and the RETURNED `failures[]` identifies
 *   the exact post and URL — see the review command at the bottom.
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
 *   - A completed run with unresolved work exits NON-ZERO
 *     (`assertRepairRunComplete`), so a partial sweep is never reported as a
 *     success — but with an EXPLICIT tolerance, because across ~165,000 posts on
 *     the open fediverse some origins are always down. Unreachable origins are
 *     tolerated below a stated rate; a payload we could not parse, a candidate
 *     with no source URL, or an unclassified failure fail the run at ANY count.
 *     Nothing is hidden either way: the per-reason breakdown is always reported
 *     and a tolerated-but-non-zero rate is logged as a warning.
 *
 * ENV
 *   DRY_RUN=true              resolve + report, write NOTHING. Collects a sample
 *                             of before/after bodies on the RETURNED summary (the
 *                             run logs only how many — see {@link RepairSample}).
 *   REPAIR_BATCH_SIZE=500     posts per `_id` page
 *   REPAIR_CONCURRENCY=8      posts re-fetched in parallel (clamped to 32)
 *   REPAIR_LIMIT=<n>          cap total posts scanned (canary budget)
 *   REPAIR_AFTER_ID=<oid>     resume/shard lower bound, EXCLUSIVE. Set it to the
 *                             previous run's `lastScannedId` to chain chunks;
 *                             without it EVERY run restarts at the lowest `_id`
 *                             and re-fetches the whole stuck head (see below).
 *                             A malformed value ABORTS — never a silent rescan.
 *   REPAIR_BEFORE_ID=<oid>    shard upper bound, INCLUSIVE. Only needed for
 *                             PARALLEL shards; sequential chaining does not use it.
 *   REPAIR_CURSOR_FILE=<path> persist the resume cursor here after every page, so
 *                             a run that dies mid-sweep is resumable
 *   REPAIR_ACTOR_URI=<uri>    restrict to one `federation.actorUri`
 *   REPAIR_NOTE_TIMEOUT_MS    per-note fetch budget (default 20000; note the
 *                             transport's own `ACTIVITYPUB_FETCH_DEADLINE_MS` of
 *                             15000 is the tighter, inner bound)
 *   REPAIR_SAMPLE_SIZE=5      before/after samples collected under DRY_RUN
 *   REPAIR_FAILURE_SAMPLE_SIZE=20  failure records collected on the summary
 *
 * RUN AS A FARGATE ONE-SHOT (dry run FIRST):
 *   DRY_RUN=true REPAIR_LIMIT=50 \
 *     bun packages/backend/dist/src/scripts/repairFederatedMentions.js
 *   CONFIRM_ADMIN_MUTATION=repairFederatedMentions \
 *     bun packages/backend/dist/src/scripts/repairFederatedMentions.js
 *
 * CHAINING BOUNDED CHUNKS (the reason `REPAIR_AFTER_ID` exists)
 *   The candidate filter only stops matching a post once it is REPAIRED. An
 *   `unresolved`, `gone` or `fetchFailed` post writes nothing and keeps matching
 *   forever — and those sit at the LOWEST ids. So without a resume cursor, chunk
 *   N+1 re-fetches the entire stuck head of chunk N: thousands of requests to
 *   other people's servers that cannot produce a repair. Measured: chunk 1
 *   scanned 20,000 and left 9,466 stuck (47%), so chunk 2's yield would have
 *   halved while still spending its full fetch budget.
 *
 *     CURSOR=/var/run/repair.cursor
 *     REPAIR_CURSOR_FILE=$CURSOR REPAIR_LIMIT=20000 \
 *       CONFIRM_ADMIN_MUTATION=repairFederatedMentions \
 *       bun .../repairFederatedMentions.js
 *     REPAIR_AFTER_ID=$(cat $CURSOR) REPAIR_CURSOR_FILE=$CURSOR REPAIR_LIMIT=20000 \
 *       CONFIRM_ADMIN_MUTATION=repairFederatedMentions \
 *       bun .../repairFederatedMentions.js
 *
 * PARALLEL SHARDS
 *   Compute the boundary ids ONCE, then give each task a half-open range. The
 *   upper bound is what makes shards safe: `REPAIR_LIMIT` bounds WORK, not RANGE,
 *   so a shard whose range holds fewer candidates than its limit would keep
 *   walking into the next shard's territory.
 *     // boundary k (repeat for k = 1..N-1)
 *     db.posts.find(<candidate filter>).sort({_id:1}).skip(k*20000).limit(1)
 *     // then, per task:
 *     REPAIR_AFTER_ID=<b[k-1]> REPAIR_BEFORE_ID=<b[k]> bun .../repairFederatedMentions.js
 *
 * REVIEW THE BODIES AND THE FAILING URLS (returned in full, never logged in full):
 *   bun -e "const m=require('./packages/backend/dist/src/scripts/repairFederatedMentions');\
 *   const g=require('mongoose');(async()=>{await g.connect(process.env.MONGODB_URI);\
 *   const s=await m.repairFederatedMentions({dryRun:true,limit:50});\
 *   console.dir({samples:s.samples,failures:s.failures},{depth:null});\
 *   await g.disconnect();})()"
 */

import { renameSync, writeFileSync } from 'node:fs';
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

/**
 * Failure records collected on the returned summary. Higher than the body
 * sample budget on purpose: a sweep is diagnosed from its failures, and the
 * first production dry run failed 40 of 50 posts.
 */
const DEFAULT_FAILURE_SAMPLE_SIZE = 20;

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
export interface CandidatePostRow {
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

/** Which `federation` field the attempted source URL came from. */
export type SourceKind = 'activityId' | 'url';

/** How a source re-fetch failed. Reported per post and tallied per run. */
export type FetchFailureReason =
  | 'timeout'
  | 'transport'
  | 'httpStatus'
  | 'nonObjectPayload'
  | 'malformedJson';

/**
 * One failed re-fetch, collected on the returned summary.
 *
 * RETURNED in full; the run also emits ONE structured warn per failure, but the
 * backend logger redacts a URL down to its host and redacts a 24-hex ObjectId
 * outright, so the log tells you WHICH INSTANCE is failing and this tells you
 * exactly WHICH POST and WHICH URL. Reviewed in-process — see the header docblock.
 */
export interface RepairFailure {
  id: string;
  /** The URL that was attempted, unredacted. */
  source: string;
  sourceKind: SourceKind;
  reason: FetchFailureReason;
  /** HTTP status, when the transport got far enough to see one. */
  status?: number;
  /** The media-type family the origin actually served, when observable. */
  contentType?: string;
  /** Short human detail (the transport error message, etc.). */
  detail: string;
}

export interface RepairFederatedMentionsOptions {
  /**
   * Resume/shard lower bound, EXCLUSIVE: only posts with `_id > afterId`.
   *
   * Without it every invocation restarts at the lowest `_id`. That matters
   * because the candidate filter only stops matching a post once it is REPAIRED
   * — an `unresolved`, `gone` or `fetchFailed` post writes nothing and keeps
   * matching forever, at the lowest ids. So a second bounded chunk re-fetches the
   * whole stuck head of the previous one: thousands of requests to other people's
   * servers that cannot produce a repair. Measured on the real corpus: chunk 1
   * scanned 20,000 and left 9,466 stuck (47%).
   */
  afterId?: string;
  /**
   * Shard upper bound, INCLUSIVE: only posts with `_id <= beforeId`.
   *
   * `afterId` + `limit` alone does NOT partition safely for parallel shards:
   * `limit` bounds WORK, not RANGE, so a shard whose range holds fewer candidates
   * than its limit keeps walking forward into the next shard's range and
   * re-fetches it. Bounding the range makes a shard's territory a property of the
   * range itself, so N tasks can never overlap however the candidate set shifts
   * under them. Sequential chaining does not need it.
   */
  beforeId?: string;
  /**
   * Where to persist the resume cursor, rewritten after EVERY page.
   *
   * A cursor reported only in the final summary cannot survive the case that
   * needs it most — a run that DIES mid-sweep never prints a summary at all. And
   * the cursor cannot go in the log: the backend logger redacts a 24-hex
   * ObjectId under every key (verified), so a logged cursor reads `[REDACTED]`.
   * A file is durable, survives the process, and keeps the id out of CloudWatch.
   */
  cursorFile?: string;
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
  /** How many failure records the run collects. */
  failureSampleSize?: number;
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
  /** `fetchFailed` split by cause — the first thing to read after a bad run. */
  fetchFailedByReason: Record<FetchFailureReason, number>;
  /**
   * The `_id` of the LAST post this run scanned, or `null` if it scanned none.
   *
   * The resume cursor: pass it as the next run's `afterId` and the next chunk
   * starts past everything this one already visited, stuck posts included.
   * RETURNED (and written to `cursorFile` when set) rather than logged — the
   * backend logger redacts a 24-hex ObjectId under every key.
   */
  lastScannedId: string | null;
  samples: RepairSample[];
  failures: RepairFailure[];
}

/** Everything known about a failed re-fetch, before a post id is attached. */
interface ApFetchFailure {
  kind: 'error';
  reason: FetchFailureReason;
  status?: number;
  contentType?: string;
  detail: string;
}

/** Outcome of re-fetching a post's source AP object. */
type ApFetchOutcome =
  | { kind: 'ok'; object: Record<string, unknown> }
  | { kind: 'gone'; status: number }
  | ApFetchFailure;

/** The message of an unknown thrown value, without leaking a stack into a field. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The media-type family a response declared, for diagnostics (parameters dropped). */
function responseContentType(res: Response): string | undefined {
  const raw = res.headers.get('content-type');
  return raw ? raw.split(';', 1)[0].trim().toLowerCase() : undefined;
}

/**
 * Re-fetch a post's source AP object over the signed, SSRF-safe transport,
 * classifying the result so the caller can tell a permanently-removed object
 * (`gone`, skip forever) from a failure (retry on a later run) — and, when it is
 * a failure, WHY.
 *
 * Never throws, and never logs: the caller owns the single structured warn, so
 * the attempted URL (which only it knows) rides in the same record as the cause.
 */
async function fetchApObject(url: string): Promise<ApFetchOutcome> {
  let res: Response;
  try {
    res = await signedFetch(url, AP_CONTENT_TYPE);
  } catch (err) {
    // Includes the transport's own content-type rejection, whose message names
    // the offending media type (see `singleHopToResponse`).
    return { kind: 'error', reason: 'transport', detail: describeError(err) };
  }

  if (GONE_STATUS_CODES.has(res.status)) return { kind: 'gone', status: res.status };
  if (!res.ok) {
    return {
      kind: 'error',
      reason: 'httpStatus',
      status: res.status,
      contentType: responseContentType(res),
      detail: `origin answered HTTP ${res.status}`,
    };
  }

  try {
    // `res.json()` is typed `any`; keep it `unknown` and narrow after validation
    // so no `any` leaks into the caller.
    const object: unknown = await res.json();
    if (!object || typeof object !== 'object' || Array.isArray(object)) {
      return {
        kind: 'error',
        reason: 'nonObjectPayload',
        status: res.status,
        contentType: responseContentType(res),
        detail: 'payload parsed but was not a JSON object',
      };
    }
    return { kind: 'ok', object: object as Record<string, unknown> };
  } catch (err) {
    return {
      kind: 'error',
      reason: 'malformedJson',
      status: res.status,
      contentType: responseContentType(res),
      detail: describeError(err),
    };
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

/**
 * Write the resume cursor to `path`, atomically, if the caller asked for one.
 *
 * Written via a temp file plus `rename` so a run killed mid-write leaves the
 * PREVIOUS cursor intact rather than a truncated id — resuming from a torn value
 * would either skip a stretch of the corpus or throw on the next parse.
 *
 * Best-effort by design: an unwritable path must not abort a sweep that is
 * otherwise repairing posts correctly. It is logged as a warning, and the cursor
 * is still on the returned summary.
 */
function persistCursor(path: string | undefined, cursor: string): void {
  if (!path) return;
  try {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${cursor}\n`, 'utf8');
    renameSync(temporary, path);
  } catch (err) {
    logger.warn('[repairFederatedMentions] could not persist the resume cursor', {
      error: err,
    });
  }
}

/** A 24-character hex ObjectId — the only shape a range bound may take. */
const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * Parse an `_id` range bound, or THROW.
 *
 * Deliberately fails fast and loudly rather than falling back to "no bound":
 * a typo'd cursor that silently degraded to scanning from the beginning would
 * look exactly like a successful run while re-fetching the entire stuck head —
 * the precise failure this option exists to prevent, made invisible.
 *
 * `mongoose.Types.ObjectId.isValid` is NOT sufficient on its own: it also accepts
 * any 12-character string and any integer, so `'abc'.padEnd(12)` would sail
 * through and silently mean a different id than the operator typed.
 */
function parseIdBound(name: string, value: string | undefined): mongoose.Types.ObjectId | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!OBJECT_ID_REGEX.test(trimmed)) {
    throw new Error(
      `${name} must be a 24-character hex ObjectId (got ${trimmed.length} characters). `
        + 'Refusing to run: an unparsed bound would silently rescan from the beginning.',
    );
  }
  return new mongoose.Types.ObjectId(trimmed);
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
  failure?: RepairFailure;
}

/**
 * Choose which URL to dereference for a post's source Note.
 *
 * `federation.activityId` FIRST: it IS the ActivityPub object id — the URL
 * federation itself delivers against and the one an AP server is obliged to
 * serve as `application/activity+json`. `federation.url` is the HUMAN web page
 * (Mastodon's `/@user/<id>` permalink); a great many servers serve HTML there
 * whatever the `Accept` header says, which is exactly how the first production
 * dry run had 40 of 50 fetches rejected on content-type.
 *
 * The candidate filter already REQUIRES `federation.activityId`, so `url` is a
 * pure fallback for a row whose id is somehow unusable, never the normal path.
 */
export function resolveSourceUrl(
  post: CandidatePostRow,
): { url: string; kind: SourceKind } | null {
  const activityId = post.federation?.activityId;
  if (activityId) return { url: activityId, kind: 'activityId' };
  const url = post.federation?.url;
  if (url) return { url, kind: 'url' };
  return null;
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
  const source = resolveSourceUrl(post);
  if (!source) return { outcome: 'skipped-no-source' };

  // The fetch is READ-ONLY, so abandoning it on the deadline is safe. The live
  // write below is never raced against a timer it could not cancel.
  const fetched: ApFetchOutcome = (await runWithTimeout(
    fetchApObject(source.url),
    noteTimeoutMs,
  )) ?? {
    kind: 'error',
    reason: 'timeout',
    detail: `re-fetch exceeded ${noteTimeoutMs}ms`,
  };

  if (fetched.kind === 'error') {
    // ONE structured warn, carrying everything a production sweep needs to
    // diagnose itself WITHOUT a code change and a redeploy: which URL was
    // attempted, which federation field it came from, the failure class, the
    // HTTP status, and the media type the origin actually served. The logger
    // reduces the URL to its host (path redacted), which is the right
    // granularity — the failing INSTANCE — and the untouched URL plus the post
    // id ride on `summary.failures` for in-process review.
    logger.warn('[repairFederatedMentions] source re-fetch failed', {
      source: source.url,
      sourceKind: source.kind,
      reason: fetched.reason,
      status: fetched.status,
      contentType: fetched.contentType,
      detail: fetched.detail,
    });
    return {
      outcome: 'fetch-failed',
      failure: {
        id: post._id.toString(),
        source: source.url,
        sourceKind: source.kind,
        reason: fetched.reason,
        status: fetched.status,
        contentType: fetched.contentType,
        detail: fetched.detail,
      },
    };
  }

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
  const failureSampleSize = options.failureSampleSize ?? DEFAULT_FAILURE_SAMPLE_SIZE;

  // Parsed BEFORE any query: a malformed bound must abort the run, never degrade
  // into an unbounded rescan that looks like success.
  const afterId = parseIdBound('afterId', options.afterId);
  const beforeId = parseIdBound('beforeId', options.beforeId);

  // `afterId` is EXCLUSIVE and `beforeId` INCLUSIVE, so chaining is exactly
  // `afterId = <previous run's lastScannedId>` — no gap, no overlap — and
  // parallel shards partition as (b[k-1], b[k]].
  const idRange: Record<string, mongoose.Types.ObjectId> = {};
  if (afterId) idRange.$gt = afterId;
  if (beforeId) idRange.$lte = beforeId;
  const hasIdRange = Object.keys(idRange).length > 0;

  const baseFilter = buildCandidateFilter(options.actorUri);
  if (hasIdRange) baseFilter._id = { ...idRange };

  // Counted WITHIN the range, so a shard reports its own territory rather than
  // the whole corpus.
  const candidates = await Post.countDocuments(baseFilter);
  logger.info('[repairFederatedMentions] candidate posts selected', {
    count: candidates,
    dryRun,
    concurrency,
    narrowedScope: Boolean(options.actorUri),
    resumed: Boolean(afterId),
    rangeBounded: Boolean(beforeId),
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
    fetchFailedByReason: {
      timeout: 0,
      transport: 0,
      httpStatus: 0,
      nonObjectPayload: 0,
      malformedJson: 0,
    },
    lastScannedId: null,
    samples: [],
    failures: [],
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
    // Merge the in-run cursor INTO the range rather than replacing it — a bare
    // `_id = { $gt: lastId }` would silently drop a shard's upper bound after the
    // first page and let it run into the next shard's territory.
    if (lastId || hasIdRange) {
      pageFilter._id = { ...idRange, ...(lastId ? { $gt: lastId } : {}) };
    }

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
        const source = resolveSourceUrl(page[i]);
        prepared = {
          outcome: 'fetch-failed',
          failure: {
            id: page[i]._id.toString(),
            source: source?.url ?? '',
            sourceKind: source?.kind ?? 'activityId',
            reason: 'transport',
            detail: describeError(result.reason),
          },
        };
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
          if (prepared.failure) {
            summary.fetchFailedByReason[prepared.failure.reason] += 1;
            if (summary.failures.length < failureSampleSize) {
              summary.failures.push(prepared.failure);
            }
          }
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
    // Persisted after EVERY page, not once at the end: the case that most needs a
    // resume cursor is a run that DIES mid-sweep, and a dying run never reaches
    // its final summary.
    summary.lastScannedId = lastId.toString();
    persistCursor(options.cursorFile, summary.lastScannedId);

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

/**
 * The share of scanned posts that may fail because the REMOTE WORLD is imperfect
 * before the sweep counts as broken.
 *
 * Measured baseline: a 600-post production dry run failed 12 (2.00%) — 9 HTTP
 * statuses and 3 transport errors, zero timeouts. Across ~165,000 posts spanning
 * the whole open fediverse there will always be dead hosts, rate limits and 5xx,
 * and the tail of the corpus (oldest posts, longest-dead instances) will be worse
 * than a sample taken from the head, so the ceiling has to sit above the measured
 * rate rather than on it.
 *
 * 10% is 5x the measured baseline: comfortably above ordinary instance churn and
 * a worse tail, yet far below anything systemic. Every breakage of this kind seen
 * so far was not a few points worse — it was catastrophic (the pre-fix run, which
 * dereferenced the human web page instead of the AP object id, failed 80%), and a
 * broken signing key or a dead egress path would read as ~100%. The rate is
 * logged on EVERY run whether or not it passes, so a drift from 2% to 9% is
 * visible long before it reaches this ceiling.
 */
const REMOTE_UNAVAILABLE_TOLERANCE = 0.1;

/**
 * Decide whether the sweep completed, separating the two things a single
 * `fetchFailed` counter conflates.
 *
 * TOLERATED (below {@link REMOTE_UNAVAILABLE_TOLERANCE}): the origin could not be
 * reached or refused us — `timeout`, `transport`, `httpStatus`. Nothing on our
 * side is wrong and re-running later is the remedy.
 *
 * NEVER TOLERATED, at any count: `nonObjectPayload` and `malformedJson` — we
 * reached the origin, it answered, and we could not make sense of what came back.
 * That is a mapping or contract failure on OUR side and a rate is not the point.
 * `skippedNoSource` likewise: the candidate filter REQUIRES `federation.activityId`,
 * so a candidate with no source URL means the filter and the reader disagree.
 * `skippedEmptyBody` too: the filter requires a stored body variant, so a re-derive
 * that produces none is a mapping mismatch worth reading, not remote weather.
 *
 * `gone` (404/410) and `unresolved` (no already-known identity for the mentioned
 * actor — the lookup-only resolver working as designed) are TERMINAL, EXPECTED
 * outcomes, not failures. They are reported in the summary and deliberately never
 * handed to the guard at all.
 */
export function assertRepairRunComplete(summary: RepairFederatedMentionsSummary): void {
  const byReason = summary.fetchFailedByReason;
  const remoteUnavailable = byReason.timeout + byReason.transport + byReason.httpStatus;
  const malformedPayload = byReason.nonObjectPayload + byReason.malformedJson;

  assertAdminRunComplete(
    'repairFederatedMentions',
    {
      remoteUnavailable,
      malformedPayload,
      skippedNoSource: summary.skippedNoSource,
      skippedEmptyBody: summary.skippedEmptyBody,
      // Vacuity guard: every `fetchFailed` must land in exactly one reason
      // bucket. If a future path ever increments the total without classifying
      // it, the difference surfaces here and fails the run STRICTLY, rather than
      // disappearing into a tolerated bucket it was never measured against.
      unclassifiedFetchFailure:
        summary.fetchFailed - remoteUnavailable - malformedPayload,
    },
    {
      scanned: summary.scanned,
      tolerate: {
        remoteUnavailable: {
          maxFraction: REMOTE_UNAVAILABLE_TOLERANCE,
          reason:
            'remote origins that are down, rate-limiting or answering 5xx — unavoidable '
            + 'across the open fediverse and fixed by re-running, not by a code change',
        },
      },
    },
  );
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
      afterId: process.env.REPAIR_AFTER_ID,
      beforeId: process.env.REPAIR_BEFORE_ID,
      cursorFile: process.env.REPAIR_CURSOR_FILE?.trim() || undefined,
      batchSize: parsePositiveInt(process.env.REPAIR_BATCH_SIZE, DEFAULT_PAGE_SIZE),
      concurrency: parsePositiveInt(process.env.REPAIR_CONCURRENCY, DEFAULT_CONCURRENCY),
      limit: process.env.REPAIR_LIMIT ? parsePositiveInt(process.env.REPAIR_LIMIT, 0) : undefined,
      actorUri: process.env.REPAIR_ACTOR_URI?.trim() || undefined,
      noteTimeoutMs: parsePositiveInt(process.env.REPAIR_NOTE_TIMEOUT_MS, DEFAULT_NOTE_TIMEOUT_MS),
      sampleSize: parsePositiveInt(process.env.REPAIR_SAMPLE_SIZE, DEFAULT_SAMPLE_SIZE),
      failureSampleSize: parsePositiveInt(
        process.env.REPAIR_FAILURE_SAMPLE_SIZE,
        DEFAULT_FAILURE_SAMPLE_SIZE,
      ),
    });

    // ONE machine-readable summary record for a Fargate one-shot's log scrape:
    // pino emits exactly one JSON line per call, so the structured context IS
    // the scrapeable line. `fetchFailedByReason` is what turns a bad run into a
    // diagnosis without a redeploy. The before/after samples are deliberately
    // NOT logged (see {@link RepairSample}); only how many were collected.
    logger.info('[repairFederatedMentions] summary', {
      dryRun: summary.dryRun,
      total: summary.candidates,
      scanned: summary.scanned,
      repaired: summary.repaired,
      unchanged: summary.unchanged,
      unresolved: summary.unresolved,
      gone: summary.gone,
      fetchFailed: summary.fetchFailed,
      fetchFailedByReason: summary.fetchFailedByReason,
      skippedNoSource: summary.skippedNoSource,
      skippedEmptyBody: summary.skippedEmptyBody,
      written: summary.written,
      sampled: summary.samples.length,
      // The cursor ITSELF cannot go here: the backend logger redacts a 24-hex
      // ObjectId under every key (verified empirically), so it would read
      // `[REDACTED]`. What CAN be reported is whether more work remains and
      // whether a resume cursor was persisted — read the id from `cursorFile`
      // or from the returned summary.
      hasMore: summary.scanned < summary.candidates,
      cursorPersisted: Boolean(process.env.REPAIR_CURSOR_FILE?.trim() && summary.lastScannedId),
      durationMs: Date.now() - startedAt,
    });

    assertRepairRunComplete(summary);
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
