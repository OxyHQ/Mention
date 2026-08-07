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
 *   REPAIR_AFTER_ID=<oid>     shard lower bound, EXCLUSIVE — where this shard's
 *                             territory STARTS. Resuming does not use it: that is
 *                             automatic (see RESUMING below). A malformed value
 *                             ABORTS — never a silent rescan.
 *   REPAIR_BEFORE_ID=<oid>    shard upper bound, INCLUSIVE. Only needed for
 *                             PARALLEL shards; a single sequential sweep has none.
 *   REPAIR_RESET_CURSOR=true  forget this shard's recorded progress and start
 *                             again at the declared bound (see RESUMING below)
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
 * RESUMING (why the cursor lives in the database)
 *   The candidate filter only stops matching a post once it is REPAIRED. An
 *   `unresolved`, `gone` or `fetchFailed` post writes nothing and keeps matching
 *   forever — and those sit at the LOWEST ids. So a run that restarts at the
 *   beginning re-fetches the entire stuck head of the previous one: thousands of
 *   requests to other people's servers that cannot produce a repair. Measured in
 *   production on 2026-08-01: a `REPAIR_LIMIT=20000` chunk left 9,466 stuck, and
 *   the unbounded run that followed re-walked all of it — 9,500 posts scanned for
 *   51 repairs (0.5%), against 70% for that run overall.
 *
 *   So the cursor has to survive the run, and this script is only ever executed
 *   as a ONE-SHOT FARGATE TASK: the container filesystem dies with the task, so
 *   a cursor written to a path is gone exactly when it is needed. It cannot go
 *   to CloudWatch either — the backend logger rewrites every 24-hex ObjectId to
 *   `[REDACTED]` and redacts any key ending in `id` (see
 *   `__tests__/utils/loggerSanitization.test.ts`), so a logged cursor is
 *   unreadable whatever it is called, and evading that would mean defeating a
 *   privacy control on purpose. It is therefore persisted to PostgreSQL, the
 *   one durable place this script already holds a connection to, after EVERY
 *   page — see {@link AdminScriptCursor}.
 *
 *   Resuming is consequently AUTOMATIC and needs no operator bookkeeping: run
 *   the same command again and it continues past everything the previous run
 *   visited, stuck posts included.
 *
 *     REPAIR_LIMIT=20000 CONFIRM_ADMIN_MUTATION=repairFederatedMentions \
 *       bun .../repairFederatedMentions.js
 *     # the SAME command again — it resumes, it does not restart:
 *     REPAIR_LIMIT=20000 CONFIRM_ADMIN_MUTATION=repairFederatedMentions \
 *       bun .../repairFederatedMentions.js
 *
 *   Progress is recorded per SHARD SCOPE — the range and actor a run declares —
 *   so parallel shards never read or overwrite each other's cursor, and a
 *   deliberate re-sweep of a scope is `REPAIR_RESET_CURSOR=true`. A DRY RUN reads
 *   the cursor (so a preview shows what the next live run would do) but never
 *   writes one, so previewing 50 posts can never make a live run skip them.
 *
 * RETRYING THE TRANSIENT TAIL (what the failure log is for)
 *   The candidate filter cannot tell a post whose origin was briefly unreachable
 *   from one whose mentioned actor is not in our index, or whose origin answered
 *   410. Measured on 2026-08-01, the completed sweep left 46,291 candidates of
 *   which only 5,691 were transient failures — so retrying them THROUGH THE
 *   FILTER means ~40,600 requests to other people's servers that cannot produce a
 *   repair, and the right call was to not retry at all.
 *
 *   So every failed re-fetch is recorded per post, with its reason and HTTP
 *   status, to {@link RepairFetchFailure} (`repairfetchfailures`, upserted on
 *   `(script, postId)`, so it stays bounded by the number of distinct failing
 *   posts). The retryable set is one indexed query:
 *
 *     db.repairfetchfailures.find({
 *       script: 'repairFederatedMentions',
 *       reason: { $in: ['timeout', 'transport', 'httpStatus'] },
 *     })
 *
 *   Two things a consumer must do, neither of which this script does for it.
 *   INTERSECT the ids with the live candidate filter — a row records that a fetch
 *   failed at `failedAt`, not that the post is still broken, and a later run or
 *   the live outbox self-heal may have fixed it since. And READ THE STATUS before
 *   going back: 429 and 5xx are worth retrying, 401/403 are a server telling you
 *   not to return.
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
 *   const d=require('./packages/backend/dist/src/db/postgres');\
 *   (async()=>{await d.connectPostgres();\
 *   const s=await m.repairFederatedMentions({dryRun:true,limit:50});\
 *   console.dir({samples:s.samples,failures:s.failures},{depth:null});\
 *   await d.closePostgres();})()"
 */

import { and, asc, count, eq, exists, gt, inArray, lte, ne, not, sql, type SQL } from 'drizzle-orm';
import { type PostContentVariant } from '@mention/shared-types';
import { connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { postContentVariants, postMedia, postMentions } from '../db/schema/postContent';
import { isLiveEntityId } from '@oxyhq/db';
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
import {
  clearAdminScriptCursor,
  readAdminScriptCursor,
  recordAdminScriptCursor,
} from './lib/adminScriptCursor';
import {
  recordRepairFetchFailures,
  type RepairFetchFailureRecord,
} from './lib/repairFetchFailureLog';

/** This sweep's own name — the mutation-guard token and the cursor's key. */
export const SCRIPT_NAME = 'repairFederatedMentions';

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

/**
 * One stored variant, as the repair needs it.
 *
 * Carries the ROW id beside the shared-types shape, because the write is an
 * UPDATE of `body` on this exact row. The Mongo original `$set` the whole
 * `content.variants` array; here the array is a child table, and replacing it
 * wholesale would delete and re-insert rows that `post_variant_media` and
 * `post_variant_alt_texts` reference by id. A body repair must not disturb
 * either — so it updates in place and the links never move.
 */
interface CandidateVariantRow {
  id: string;
  variant: PostContentVariant;
}

/** The Post fields the repair reads. */
export interface CandidatePostRow {
  id: string;
  mentions: string[];
  variants: CandidateVariantRow[];
  /**
   * Whether the post has stored media — the ONE thing the re-derived body needs
   * to know about it. Reused rather than re-fetched, exactly as the Mongo
   * version did: a body repair performs no media I/O.
   */
  hasMedia: boolean;
  federation: {
    activityId?: string;
    actorUri?: string;
    url?: string;
  };
}

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
   * Shard lower bound, EXCLUSIVE: only posts with `_id > afterId`. Where this
   * shard's TERRITORY starts, together with {@link beforeId} — not where the run
   * picks up, which the stored cursor decides on its own.
   *
   * It is also half of the cursor's scope key, so two shards can record their
   * progress independently and re-running one shard's exact command resumes THAT
   * shard.
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
   * under them. A single sequential sweep has no upper bound at all.
   */
  beforeId?: string;
  /**
   * Forget this shard's recorded progress and start again at `afterId`.
   *
   * Resuming is otherwise automatic, which is what makes a died-mid-sweep run
   * recoverable in a one-shot task. A deliberate re-sweep of ground already
   * covered therefore has to be asked for, and it is worth asking twice: every
   * post re-walked is another request to somebody else's server.
   */
  resetCursor?: boolean;
  /** Resolve + report, write nothing — including no cursor. */
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
  /** Posts a write actually landed on (always 0 under DRY_RUN). */
  written: number;
  /** `fetchFailed` split by cause — the first thing to read after a bad run. */
  fetchFailedByReason: Record<FetchFailureReason, number>;
  /**
   * The `id` of the LAST post this run scanned, or `null` if it scanned none.
   *
   * The resume cursor. Persisted to PostgreSQL under {@link cursorScope} after
   * every page and RETURNED here — never logged, because the backend logger
   * redacts a 24-hex ObjectId under every key.
   */
  lastScannedId: string | null;
  /**
   * The shard territory this run recorded its progress under, derived from the
   * DECLARED bounds so it is stable across resumes of the same shard.
   */
  cursorScope: string;
  /** Whether the lower bound came from a stored cursor rather than `afterId`. */
  resumed: boolean;
  /**
   * Posts this scope had already scanned before this invocation. Added to
   * {@link scanned} it gives the shard's running total.
   */
  resumedFromScanned: number;
  /**
   * Cursor writes that did not land. STRICT: any at all fails the run, because a
   * sweep whose cursor stopped persisting is a sweep that cannot be resumed —
   * the failure this whole mechanism exists to prevent.
   */
  cursorWriteFailures: number;
  /**
   * Failed re-fetches this run could not record for a later targeted retry.
   * STRICT for the same reason as {@link cursorWriteFailures}: losing them costs
   * this run nothing and the next one everything, since the only way back to
   * those posts is then re-walking the whole corpus.
   */
  failuresNotRecorded: number;
  samples: RepairSample[];
  /**
   * A BOUNDED sample of failures, for in-process review. Every failure is
   * recorded in full to {@link RepairFetchFailure}; this is the reading copy.
   */
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
export function buildCandidateFilter(actorUri?: string): SQL {
  const clauses: SQL[] = [
    sql`${posts.federationActivityId} is not null`,
    ne(posts.type, 'boost'),
    /**
     * Nothing resolved. In Mongo this was a three-branch `$or` over absent /
     * null / empty-array, because one document field carried all three states.
     * As a junction table there is exactly ONE state that means it: no row.
     */
    not(
      exists(
        getDb()
          .select({ one: sql`1` })
          .from(postMentions)
          .where(eq(postMentions.postId, posts.id)),
      ),
    ),
    /**
     * Some stored body still carries the residue of an unlinked mention.
     *
     * `~` is Postgres' POSIX regex match, and the pattern is the SOURCE of the
     * same JavaScript literal the in-memory checks use — declared once so the
     * two can never drift into selecting different corpora.
     */
    exists(
      getDb()
        .select({ one: sql`1` })
        .from(postContentVariants)
        .where(
          and(
            eq(postContentVariants.postId, posts.id),
            sql`${postContentVariants.body} ~ ${UNLINKED_MENTION_TEXT_REGEX.source}`,
          ),
        ),
    ),
  ];
  if (actorUri) clauses.push(eq(posts.federationActorUri, actorUri));
  return and(...clauses) as SQL;
}

/**
 * The key a run records its progress under: the territory it DECLARED, never the
 * position it has reached.
 *
 * Built from the CANONICAL parsed bounds rather than the raw strings, so
 * `REPAIR_AFTER_ID=" 65FD… "` and `65fd…` are one shard rather than two that
 * silently re-walk each other's ground. Every component is always present, so no
 * two different shards can spell the same scope.
 */
export function buildCursorScope(scope: {
  afterId?: string;
  beforeId?: string;
  actorUri?: string;
}): string {
  return [
    `after:${scope.afterId ?? ''}`,
    `before:${scope.beforeId ?? ''}`,
    `actor:${scope.actorUri?.trim() ?? ''}`,
  ].join('|');
}

/**
 * Parse an `id` range bound, or THROW.
 *
 * Deliberately fails fast and loudly rather than falling back to "no bound":
 * a typo'd cursor that silently degraded to scanning from the beginning would
 * look exactly like a successful run while re-fetching the entire stuck head —
 * the precise failure this option exists to prevent, made invisible. That is
 * also why this accepts BOTH live id shapes rather than staying on 24-hex: a
 * uuid v7 bound is a legitimate shard boundary now, and rejecting it would turn
 * a valid command into a refusal.
 *
 * Normalised to LOWERCASE, because the column is `text` and compares
 * byte-for-byte: an uppercased ObjectId bound would sort before every stored id
 * (`'A' < 'a'`) and silently select the whole corpus.
 *
 * ## What a bound MEANS changed, and it is not a time range
 *
 * Ids are ordered as TEXT here, and the two shapes do not interleave: a uuid v7
 * begins with a hex timestamp and a `0` nibble, an ObjectId with a unix seconds
 * value currently starting `6`/`7`, so EVERY post-cutover id sorts before EVERY
 * pre-cutover one. Sharding stays correct — the order is total and stable, so
 * `(b[k-1], b[k]]` still partitions the corpus with no gap and no overlap, and
 * that is the property the resume cursor and the parallel shards actually rely
 * on. But an operator reading `REPAIR_AFTER_ID` as "posts newer than this" is
 * wrong across the boundary. Say so rather than let the run look narrower than
 * it is.
 */
function parseIdBound(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (!isLiveEntityId(trimmed)) {
    throw new Error(
      `${name} must be a 24-character hex ObjectId or a uuid v7 (got ${trimmed.length} `
        + 'characters). Refusing to run: an unparsed bound would silently rescan from the '
        + 'beginning.',
    );
  }
  return trimmed;
}

/**
 * Whether an id sits in the half-open range `(after, before]` a run declared.
 *
 * Compared as lowercase text, which is exactly how Postgres orders the `id`
 * column — `parseIdBound` lowercases every bound, so this predicate and the SQL
 * range can never disagree about which side of a bound an id falls on.
 */
function isWithinRange(
  id: string,
  after: string | undefined,
  before: string | undefined,
): boolean {
  if (after && id <= after) return false;
  if (before && id > before) return false;
  return true;
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

/**
 * A staged write for ONE post.
 *
 * `variantBodies` is keyed by variant ROW id, so the flush updates exactly the
 * rows the candidate query read — never a positional guess. `mentions` is the
 * full replacement set, mirroring the Mongo `$set` of the whole array.
 */
interface StagedRepair {
  postId: string;
  variantBodies?: Map<string, string>;
  mentions?: string[];
}

/** A prepared repair: the outcome, plus the staged write when there is one. */
interface PreparedRepair {
  outcome: RepairOutcome;
  op?: StagedRepair;
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
        id: post.id,
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
  // Re-derive the body ONLY (no media I/O — the stored media state is reused via
  // `hasMedia`), exactly like the live outbox self-heal.
  const freshVariants = buildFederatedNoteVariants(noteObject, post.hasMedia);
  if (freshVariants.length === 0) return { outcome: 'skipped-empty-body' };

  const storedVariants = post.variants.map((row) => row.variant);
  const repairedVariants = repairVariantText(
    freshVariants.map((variant) => variant.text),
    storedVariants,
  );

  const staged: StagedRepair = { postId: post.id };
  if (repairedVariants) {
    /**
     * Only the rows whose body actually changed. `repairVariantText` aligns by
     * index and returns the stored entry untouched where nothing moved, so
     * comparing against the stored text keeps the write to the rows that need
     * it — an UPDATE that sets a column to the value it already holds is still
     * a row version, and this sweep runs across the whole corpus.
     */
    const changed = new Map<string, string>();
    repairedVariants.forEach((variant, index) => {
      const row = post.variants[index];
      if (row && variant.text !== row.variant.text) changed.set(row.id, variant.text);
    });
    if (changed.size > 0) staged.variantBodies = changed;
  }
  if (!sortedStringArrayEqual(resolved.ids, post.mentions)) {
    staged.mentions = resolved.ids;
  }

  // Nothing to change: the stored state already matches a fresh re-map.
  // Idempotency for the SHIPPED filter comes one level up (a repaired post no
  // longer matches it); this branch is what keeps an in-process caller with a
  // wider filter from churning row versions across the corpus.
  if (!staged.variantBodies && !staged.mentions) return { outcome: 'unchanged' };

  return {
    outcome: 'repaired',
    op: staged,
    sample: {
      id: post.id,
      before: renderBody(storedVariants[0]?.text),
      after: renderBody((repairedVariants ?? storedVariants)[0]?.text),
      mentions: resolved.ids,
    },
  };
}

/**
 * One page of candidates, assembled from `posts` plus its two child tables.
 *
 * Three queries rather than a join, because the children are one-to-many and a
 * join would multiply the parent row by `variants × mentions` — the shape that
 * makes a page of 500 silently become a page of thousands and the `limit` stop
 * meaning what it says. The parent page is fetched FIRST and bounded, then the
 * children are loaded for exactly those ids.
 *
 * Ordered by `position` so the variant array matches the order the federated
 * ingest wrote it in — `repairVariantText` aligns by INDEX, so a page that
 * returned them in physical-row order would apply the primary body onto a
 * translation.
 */
async function loadCandidatePage(match: SQL, limit: number): Promise<CandidatePostRow[]> {
  const db = getDb();
  const parents = await db
    .select({
      id: posts.id,
      federationActivityId: posts.federationActivityId,
      federationActorUri: posts.federationActorUri,
      federationUrl: posts.federationUrl,
    })
    .from(posts)
    .where(match)
    .orderBy(asc(posts.id))
    .limit(limit);
  if (parents.length === 0) return [];

  const ids = parents.map((row) => row.id);
  const [variantRows, mentionRows, mediaRows] = await Promise.all([
    db
      .select()
      .from(postContentVariants)
      .where(inArray(postContentVariants.postId, ids))
      .orderBy(asc(postContentVariants.postId), asc(postContentVariants.position)),
    db
      .select({ postId: postMentions.postId, oxyUserId: postMentions.oxyUserId })
      .from(postMentions)
      .where(inArray(postMentions.postId, ids)),
    db
      .select({ postId: postMedia.postId })
      .from(postMedia)
      .where(inArray(postMedia.postId, ids)),
  ]);

  const variantsByPost = new Map<string, CandidateVariantRow[]>();
  for (const row of variantRows) {
    const list = variantsByPost.get(row.postId) ?? [];
    list.push({ id: row.id, variant: toStoredVariant(row) });
    variantsByPost.set(row.postId, list);
  }
  const mentionsByPost = new Map<string, string[]>();
  for (const row of mentionRows) {
    const list = mentionsByPost.get(row.postId) ?? [];
    list.push(row.oxyUserId);
    mentionsByPost.set(row.postId, list);
  }
  const postsWithMedia = new Set(mediaRows.map((row) => row.postId));

  return parents.map((row) => ({
    id: row.id,
    mentions: mentionsByPost.get(row.id) ?? [],
    variants: variantsByPost.get(row.id) ?? [],
    hasMedia: postsWithMedia.has(row.id),
    federation: {
      activityId: row.federationActivityId ?? undefined,
      actorUri: row.federationActorUri ?? undefined,
      url: row.federationUrl ?? undefined,
    },
  }));
}

/**
 * A stored variant row as the shared-types shape `repairVariantText` preserves.
 *
 * `tag` and `source` are carried through untouched — a body repair does not
 * re-decide what language a body is in, and dropping either here would let the
 * repair reset a classifier-detected tag on every post it touches.
 */
function toStoredVariant(row: typeof postContentVariants.$inferSelect): PostContentVariant {
  return {
    text: row.body,
    ...(row.tag === null ? {} : { tag: row.tag }),
    source: row.source,
    ...(row.variantCreatedAt === null ? {} : { createdAt: row.variantCreatedAt.toISOString() }),
  };
}

/**
 * Re-resolve @mentions across the already-stored federated corpus.
 *
 * Operates on the `posts` tables only — the caller owns the connection
 * lifecycle — so it is testable against real rows and reusable from an
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

  // Keyed on the DECLARED territory, so the same shard command always addresses
  // the same recorded progress however far into its range it has got.
  const cursorScope = buildCursorScope({ afterId, beforeId, actorUri: options.actorUri });
  if (options.resetCursor) await clearAdminScriptCursor(SCRIPT_NAME, cursorScope);
  const resumeFrom = options.resetCursor
    ? null
    : await readAdminScriptCursor(SCRIPT_NAME, cursorScope);

  // A stored cursor is only ever written from a post this scope actually
  // scanned, so it must lie inside the declared range. If it does not, the state
  // and the bounds disagree and resuming would either skip a stretch of the
  // corpus or re-walk somebody else's shard — both invisible. Abort instead.
  const resumeId = resumeFrom ? parseIdBound('storedCursor', resumeFrom.cursor) : undefined;
  if (resumeId && !isWithinRange(resumeId, afterId, beforeId)) {
    throw new Error(
      "the stored resume cursor lies outside this run's declared _id range. "
        + 'Refusing to run: resuming from it would skip or duplicate a stretch of the corpus. '
        + 'Re-run with resetCursor to start this shard again.',
    );
  }

  // `afterId` is EXCLUSIVE and `beforeId` INCLUSIVE, so a resume is exactly
  // `$gt = <last scanned id>` — no gap, no overlap — and parallel shards
  // partition as (b[k-1], b[k]].
  const lowerBound = resumeId ?? afterId;

  const candidateMatch = buildCandidateFilter(options.actorUri);
  /** The declared range, rebuilt per query — `lastId` narrows it, never replaces it. */
  const rangeClauses = (from: string | undefined): SQL[] => {
    const clauses: SQL[] = [];
    if (from) clauses.push(gt(posts.id, from));
    if (beforeId) clauses.push(lte(posts.id, beforeId));
    return clauses;
  };

  // Counted WITHIN the range, so a shard reports the work it has LEFT rather
  // than the whole corpus or ground it has already covered.
  const [candidateRow] = await getDb()
    .select({ total: count() })
    .from(posts)
    .where(and(candidateMatch, ...rangeClauses(lowerBound)));
  const candidates = candidateRow?.total ?? 0;
  logger.info('[repairFederatedMentions] candidate posts selected', {
    count: candidates,
    dryRun,
    concurrency,
    narrowedScope: Boolean(options.actorUri),
    // The cursor itself cannot be logged (24-hex ObjectIds are redacted under
    // every key), so what rides here is where the bound CAME FROM and how far
    // this scope had already got. Both are on the returned summary too.
    resumed: Boolean(resumeId),
    resumedFromScanned: resumeFrom?.scanned ?? 0,
    scopeCompletedEarlier: Boolean(resumeFrom?.completedAt),
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
    cursorScope,
    resumed: Boolean(resumeId),
    resumedFromScanned: resumeFrom?.scanned ?? 0,
    cursorWriteFailures: 0,
    failuresNotRecorded: 0,
    samples: [],
    failures: [],
  };
  if (candidates === 0) {
    logger.info('[repairFederatedMentions] nothing to do');
    return summary;
  }

  let remaining = options.limit;
  let lastId: string | null = null;
  let pendingOps: StagedRepair[] = [];
  // EVERY failure of the current page, unlike `summary.failures`, which is a
  // bounded reading sample. A targeted retry needs all of them or it is not
  // targeting the tail, it is targeting twenty posts.
  let pendingFailures: RepairFetchFailureRecord[] = [];

  // A dry run stages every operation exactly as a real one does — it just never
  // opens the transaction. That is the guarantee: what it reports is what a real
  // run would write, computed by the same code.
  const flush = async (): Promise<void> => {
    if (pendingOps.length === 0) return;
    if (dryRun) {
      pendingOps = [];
      return;
    }
    const batch = pendingOps;
    pendingOps = [];
    /**
     * ONE transaction per flush, so a post's body and its mention set can never
     * land apart — a half-applied repair leaves a body whose anchors point at
     * mentions the post does not record, which is the state this sweep exists to
     * remove. Mongo's `bulkWrite` gave per-document atomicity and nothing wider;
     * this is strictly stronger.
     */
    await getDb().transaction(async (tx) => {
      for (const op of batch) {
        /**
         * Counted from rows that actually came back, never from the size of the
         * batch. A post deleted between the page read and this flush leaves its
         * variant rows cascaded away, so the update matches nothing — and a
         * sweep that reported it as repaired would be overstating its own work
         * on the one number an operator reads to decide whether to re-run.
         */
        let touched = false;
        if (op.variantBodies) {
          for (const [variantId, body] of op.variantBodies) {
            const updated = await tx
              .update(postContentVariants)
              .set({ body })
              .where(eq(postContentVariants.id, variantId))
              .returning({ id: postContentVariants.id });
            if (updated.length > 0) touched = true;
          }
        }
        if (op.mentions && op.mentions.length > 0) {
          /**
           * Replace the set. The candidate filter selects only posts with NO
           * mention rows, so this is an insert in practice — the delete is what
           * keeps an in-process caller with a wider filter correct.
           *
           * A post deleted mid-sweep would make the insert violate the foreign
           * key and abort the whole flush, which is the right failure: it is
           * loud, and the batch is re-derivable by re-running.
           */
          await tx.delete(postMentions).where(eq(postMentions.postId, op.postId));
          const inserted = await tx
            .insert(postMentions)
            .values(op.mentions.map((oxyUserId) => ({ postId: op.postId, oxyUserId })))
            .returning({ id: postMentions.id });
          if (inserted.length > 0) touched = true;
        }
        if (touched) summary.written += 1;
      }
    });
  };

  /**
   * Record where this scope has got to, so a task that is killed mid-sweep can
   * be resumed rather than restarted.
   *
   * A DRY RUN never writes one. A preview that advanced the real cursor would
   * make the next live run skip exactly the posts it previewed — the invisible
   * kind of wrong, and the reason this is a guard rather than an optimization.
   */
  const persistCursor = async (cursor: string, completed: boolean): Promise<void> => {
    if (dryRun) return;
    const persisted = await recordAdminScriptCursor(SCRIPT_NAME, cursorScope, {
      cursor,
      scanned: summary.resumedFromScanned + summary.scanned,
      completed,
    });
    if (!persisted) summary.cursorWriteFailures += 1;
  };

  /**
   * Record this page's failed re-fetches, so the transient tail is reachable
   * later without re-walking the corpus.
   *
   * A DRY RUN writes nothing here either — it promises to write NOTHING, and a
   * preview quietly leaving rows behind would be the same broken promise as one
   * quietly advancing the cursor.
   */
  const recordFailures = async (): Promise<void> => {
    if (pendingFailures.length === 0) return;
    if (dryRun) {
      pendingFailures = [];
      return;
    }
    if (!(await recordRepairFetchFailures(SCRIPT_NAME, pendingFailures))) {
      summary.failuresNotRecorded += pendingFailures.length;
    }
    pendingFailures = [];
  };

  // Forward-only cursor. The repair only ever removes a post from the matching
  // set (it fills in `mentions`, which the filter selects on), so no page is
  // revisited and none is skipped.
  for (;;) {
    if (remaining !== undefined && remaining <= 0) break;

    const pageLimit = remaining !== undefined ? Math.min(pageSize, remaining) : pageSize;
    // The in-run cursor NARROWS the declared range rather than replacing it — a
    // bare `id > lastId` would silently drop a shard's upper bound after the
    // first page and let it run into the next shard's territory.
    const page = await loadCandidatePage(
      and(candidateMatch, ...rangeClauses(lastId ?? lowerBound)) as SQL,
      pageLimit,
    );

    // An empty page means this scope's range is exhausted — the one exit that
    // means FINISHED, as opposed to stopping on a limit or dying mid-page. Stamp
    // it so a later run can tell the difference.
    if (page.length === 0) {
      if (lastId) await persistCursor(lastId, true);
      break;
    }

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
            id: page[i].id,
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
            pendingFailures.push({
              postId: prepared.failure.id,
              reason: prepared.failure.reason,
              status: prepared.failure.status,
            });
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

    lastId = page[page.length - 1].id;
    // Persisted after EVERY page, not once at the end: the case that most needs a
    // resume cursor is a run that DIES mid-sweep, and a dying run never reaches
    // its final summary.
    summary.lastScannedId = lastId;
    // Failures BEFORE the cursor, and the order is not cosmetic. If the cursor
    // advanced first and the process died, a resumed run would start past posts
    // whose failures were never recorded — losing them from the targeting set
    // permanently. This way the worst case is a page re-walked, which the repair
    // is idempotent against.
    await recordFailures();
    await persistCursor(summary.lastScannedId, false);

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
 *
 * A cursor that did not persist is likewise never tolerated, nor is a failed
 * re-fetch this run could not record. Both cost the run nothing at the time —
 * every post it scanned was still repaired — which is exactly why they have to
 * fail here: the damage lands on the NEXT run, which either restarts at the
 * beginning or can no longer find the transient tail, and in both cases pays for
 * it in requests to other people's servers.
 */
export function assertRepairRunComplete(summary: RepairFederatedMentionsSummary): void {
  const byReason = summary.fetchFailedByReason;
  const remoteUnavailable = byReason.timeout + byReason.transport + byReason.httpStatus;
  const malformedPayload = byReason.nonObjectPayload + byReason.malformedJson;

  assertAdminRunComplete(
    SCRIPT_NAME,
    {
      remoteUnavailable,
      malformedPayload,
      skippedNoSource: summary.skippedNoSource,
      skippedEmptyBody: summary.skippedEmptyBody,
      cursorNotPersisted: summary.cursorWriteFailures,
      failuresNotRecorded: summary.failuresNotRecorded,
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
  const dryRun = process.env.DRY_RUN === 'true';

  try {
    assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
    // ONE store now. The posts, the resume cursor and the re-fetch failure log
    // are all Postgres, so the Mongo connection this used to open alongside is
    // gone rather than left dangling — a sweep that connects to a store it never
    // reads is how the next reader concludes the corpus still lives there.
    await connectPostgres();
    logger.info('[repairFederatedMentions] connected to PostgreSQL', { dryRun });

    const summary = await repairFederatedMentions({
      dryRun,
      afterId: process.env.REPAIR_AFTER_ID,
      beforeId: process.env.REPAIR_BEFORE_ID,
      resetCursor: process.env.REPAIR_RESET_CURSOR === 'true',
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
      // ObjectId under every key (verified empirically), so a pre-cutover id
      // would read `[REDACTED]`. What CAN be reported is whether more work
      // remains and how far this shard has now got in total — the id is in
      // `admin_script_cursors`, which is where the next run reads it from
      // without an operator in the loop.
      hasMore: summary.scanned < summary.candidates,
      resumed: summary.resumed,
      shardScannedTotal: summary.resumedFromScanned + summary.scanned,
      cursorWriteFailures: summary.cursorWriteFailures,
      failuresNotRecorded: summary.failuresNotRecorded,
      durationMs: Date.now() - startedAt,
    });

    assertRepairRunComplete(summary);
  } catch (error) {
    logger.error('[repairFederatedMentions] failed', error);
    throw error;
  } finally {
    await closeAdminScriptResources();
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
