/**
 * Drive the PLATFORM half of a blocked-domain purge: ask Oxy to remove what IT
 * holds for every instance the committed policy blocks.
 *
 * WHY THIS SCRIPT EXISTS AT ALL
 *   Blocking an instance produced a half-clean. `purgeBlockedDomainContent`
 *   removes what MENTION holds — posts, actors, engagement, our media cache —
 *   and stops there, because that is all Mention's database can reach. The
 *   federated identities themselves are Oxy rows: `type:'federated'` users, the
 *   avatars Oxy fetched, the media Mention mirrored into Oxy's file store, and
 *   the follow edges between them. Measured against production when the
 *   capability was built: 61,113 federated user rows across 3,977 domains and
 *   ~225 GiB of mirrored remote media, none of it reachable from here.
 *
 *   Oxy exposes `POST /federation/domain-purge` for exactly this and holds NO
 *   blocklist of its own — it is handed ONE domain per call by an authenticated
 *   caller and removes what it holds for that domain. THIS script is the other
 *   half of that contract: the policy owner, walking its own committed list.
 *   Without it the capability sits there with nothing driving it.
 *
 * MENTION DRIVES, OXY OBEYS
 *   Every domain sent here comes from {@link getBlockedDomainPolicy} — the same
 *   accessor the enforcement predicate and the public transparency page read.
 *   There is no list in this file and no second parse of the policy file.
 *
 *   `FEDERATION_BLOCKED_DOMAINS` is deliberately NOT unioned in, which is where
 *   this differs from `purgeBlockedDomainContent`'s reviewed manual run. That
 *   script deletes rows only Mention can see; this one asks a shared platform to
 *   delete identities and files, and an environment string can be changed by one
 *   person in a console with no diff, no author and no review. The emergency
 *   lever stops new content instantly and always will; removing an instance's
 *   history from the platform waits for the reviewed entry to be committed.
 *   Same argument, same boundary as {@link ../services/federation/blockedDomainPolicySource}.
 *
 * SAFE BY DEFAULT, AND THE PLAN IS THE EXECUTE
 *   `DRY_RUN` defaults to TRUE here (unlike its sibling, whose default is a
 *   mutating run gated on the confirmation token). The endpoint's own default is
 *   `dryRun:true` and the safe value should be the one you get by omission.
 *   {@link buildPurgeRequest} builds the request body, and `dryRun` is the ONLY
 *   field it derives from the mode — so the numbers a plan reports are the
 *   numbers the execute will act on, request for request, cursor for cursor.
 *   A live run additionally requires `CONFIRM_ADMIN_MUTATION` AND
 *   `FEDERATION_DOMAIN_PURGE_ENABLED=true` on the Oxy deployment (which answers
 *   409 otherwise — arming is an operator decision made over there, not here).
 *
 * BOUNDED, RESUMABLE, AND EXPECTED TO BE RE-RUN
 *   Ingest is live: the federated corpus grows while a purge runs, so this is
 *   not a one-shot that gets ticked off. Each domain is walked in `limit`-sized
 *   passes, `nextCursor` echoed back as `afterId`, until the endpoint reports
 *   `done`. Progress is recorded in Mongo per domain after every pass — a
 *   Fargate one-shot's filesystem dies with the task — so a run that is killed
 *   resumes where it stopped, and a re-run costs one short pass per finished
 *   domain while still catching actors ingested since (an `_id` cursor advances
 *   into new arrivals by construction).
 *
 *   `done` is THE loop condition, never `remaining`: retained rows keep matching
 *   forever and a dry run deletes nothing, so a caller looping on "anything
 *   left?" would never terminate. The endpoint had that exact livelock and fixed
 *   it; {@link purgeDomainOnPlatform} refuses to reintroduce the caller-side
 *   twin by treating a cursor that does not advance as a hard stop.
 *
 * WHAT THE REPORT LEADS WITH
 *   `localFollowersAffected` — inbound follows from real local people among the
 *   actors a pass touched. Every other counter is inventory; that one is the
 *   user-visible cost of the decision, so it is the first column of the table
 *   and the first field of the totals.
 *
 * ENV
 *   DRY_RUN=0                 execute (default: 1, plan only)
 *   CONFIRM_ADMIN_MUTATION    must equal `purgeBlockedDomainPlatformData` to execute
 *   PURGE_DOMAIN              restrict the run to ONE domain, which must be in
 *                             the committed policy
 *   PURGE_BATCH_LIMIT         actors per request (1–1000, default 200)
 *   PURGE_MAX_PASSES          per-domain ceiling on requests (default 200)
 *   RESET_CURSOR=1            ignore recorded progress and sweep from the top
 *
 * RUN AS A FARGATE ONE-SHOT (in-VPC — it needs the oxy-api service credential):
 *   bun packages/backend/dist/src/scripts/purgeBlockedDomainPlatformData.js
 *   DRY_RUN=0 CONFIRM_ADMIN_MUTATION=purgeBlockedDomainPlatformData \
 *     bun packages/backend/dist/src/scripts/purgeBlockedDomainPlatformData.js
 */

import mongoose from 'mongoose';
import { canonicalFederationHost } from '@oxyhq/federation';
import { getOxyServiceCredentials } from '../config';
import { connectToDatabase } from '../utils/database';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { getBlockedDomainPolicy } from '../connectors/activitypub/federationBlockPolicy';
import { OWN_DOMAINS } from '../connectors/activitypub/ownDomain';
import { buildBlockedContentDomains } from './purgeBlockedDomainContent';
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

/** This script's own name — the token its mutation guard and cursor rows use. */
export const SCRIPT_NAME = 'purgeBlockedDomainPlatformData';

/** The capability this script drives. Oxy owns it; the policy stays here. */
const PURGE_PATH = '/federation/domain-purge';

/** Actors per request. Matches the endpoint's own default. */
const DEFAULT_BATCH_LIMIT = 200;

/** The endpoint's hard ceiling; asking for more is a 400, so refuse locally. */
const MAX_BATCH_LIMIT = 1000;

/**
 * Requests one domain may take before the run gives up on it.
 *
 * At the default batch size that is 40,000 actors from a single instance in one
 * run — comfortably above the largest blocked domain in a corpus of 61,113
 * federated rows spread over 3,977 domains, so reaching it means something is
 * wrong rather than something is big. Hitting it fails the run: the domain was
 * NOT swept, and a partial sweep must never report success. Its cursor is
 * recorded, so the fix is usually just to run it again.
 */
const DEFAULT_MAX_PASSES_PER_DOMAIN = 200;

/**
 * Consecutive per-domain failures that abort the whole run.
 *
 * A bad credential, a missing `federation:write` scope, an unarmed deployment or
 * an oxy-api outage fails EVERY domain identically. Firing 118 doomed requests
 * at a production endpoint to learn that twice is not diligence, it is noise —
 * and the fifth identical failure is not new information. Scattered failures
 * stay below this and are handled by the tolerance instead.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Share of visited domains whose request may fail before the run is incomplete.
 *
 * oxy-api rolls deploys, and a task that catches the window sees an individual
 * call 502 or lose its token mid-flight. The purge is idempotent and the failed
 * domain keeps its cursor, so the next run picks it up exactly where this one
 * stopped — a handful of transient misses is a retry, not a regression. A
 * systemic fault cannot hide under this: it fails every domain, and the
 * consecutive-failure abort above catches it long before the rate does.
 */
const REQUEST_FAILURE_TOLERANCE = 0.05;

/** The exact shape Oxy's `nextCursor` (a stringified `_id`) and `afterId` take. */
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

// --- environment -------------------------------------------------------------

function readBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  // Never guessed. An unrecognised value on the flag that decides whether this
  // deletes must not silently resolve to either answer.
  throw new Error(`${name} must be a boolean ("1"/"true" or "0"/"false"), got "${raw}"`);
}

function readBoundedIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got "${raw}")`);
  }
  return parsed;
}

/** Everything the run's behaviour depends on, resolved once at start-up. */
export interface PlatformPurgeOptions {
  /** When true (the DEFAULT) every request carries `dryRun:true` and nothing is written. */
  dryRun: boolean;
  /** Restrict the run to one policy domain, canonicalised. */
  domain?: string;
  /** Actors per request. */
  batchLimit: number;
  /** Requests one domain may take in this run. */
  maxPassesPerDomain: number;
  /** Ignore recorded progress and sweep each domain from the top. */
  resetCursor: boolean;
}

export function readOptions(): PlatformPurgeOptions {
  return {
    dryRun: readBooleanEnv('DRY_RUN', true),
    // Canonicalised with the federation engine's own function, so a narrowed run
    // is compared against the policy in exactly the form the policy is held in.
    domain: canonicalFederationHost(process.env.PURGE_DOMAIN || '') || undefined,
    batchLimit: readBoundedIntEnv('PURGE_BATCH_LIMIT', DEFAULT_BATCH_LIMIT, 1, MAX_BATCH_LIMIT),
    maxPassesPerDomain: readBoundedIntEnv('PURGE_MAX_PASSES', DEFAULT_MAX_PASSES_PER_DOMAIN, 1, 10_000),
    resetCursor: readBooleanEnv('RESET_CURSOR', false),
  };
}

// --- the request -------------------------------------------------------------

/** The body of one `POST /federation/domain-purge` call. */
export interface DomainPurgeRequest {
  domain: string;
  dryRun: boolean;
  limit: number;
  afterId?: string;
}

/**
 * Build one request. `dryRun` is the ONE field that differs between planning and
 * executing — everything else (the domain, the batch size, the cursor) is
 * identical — so the plan an operator approves and the run that follows it
 * cannot describe different work.
 *
 * `callerAppId` is conspicuously absent and must stay absent: Oxy resolves it
 * from the service credential precisely so that no caller can name whose files
 * to delete. Sending one would be asking to be ignored at best.
 */
export function buildPurgeRequest(
  domain: string,
  options: PlatformPurgeOptions,
  afterId?: string,
): DomainPurgeRequest {
  const request: DomainPurgeRequest = {
    domain,
    dryRun: options.dryRun,
    limit: options.batchLimit,
  };
  if (afterId !== undefined) request.afterId = afterId;
  return request;
}

// --- the response ------------------------------------------------------------

/** One pass's result, after validation. Mirrors the endpoint's response. */
export interface DomainPurgePass {
  canonicalDomain: string;
  dryRun: boolean;
  actorsMatched: number;
  actorsProcessed: number;
  actorsDeleted: number;
  actorsRetained: number;
  /** Applications, other than us, that kept a row alive. */
  retainedByAppIds: string[];
  filesDeleted: number;
  bytesDeleted: number;
  avatarsDeleted: number;
  followEdgesRemoved: number;
  localFollowersAffected: number;
  candidatesRejected: number;
  remaining: number;
  nextCursor: string | null;
  done: boolean;
}

/** Raised when a response cannot be trusted to mean what this script reads it as. */
export class MalformedPurgeResponseError extends Error {
  constructor(detail: string) {
    super(`[${SCRIPT_NAME}] Oxy returned a response this script cannot read: ${detail}`);
    this.name = 'MalformedPurgeResponseError';
  }
}

/** Raised when a response contradicts the mode the request asked for. */
export class DryRunViolationError extends Error {
  constructor(requested: boolean, reported: boolean) {
    super(
      `[${SCRIPT_NAME}] requested dryRun=${requested} but Oxy reported dryRun=${reported}. `
      + 'Stopping the whole run: the two ends disagree about whether this deletes.',
    );
    this.name = 'DryRunViolationError';
  }
}

function readCount(source: Record<string, unknown>, field: string): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new MalformedPurgeResponseError(`"${field}" is not a non-negative number`);
  }
  return value;
}

/**
 * Validate a pass, strictly.
 *
 * The SDK has already stripped the API's `{ data }` envelope (`HttpService`
 * unwraps a lone `data` key), so this reads the result object itself. It is
 * deliberately NOT tolerant of an unexpected shape: every field below decides
 * either what gets reported to a human or where the next request starts, and a
 * missing counter silently read as zero would make an under-delete look like a
 * completed sweep. A wrong guess here fails loudly on the first pass of a dry
 * run, which is the cheapest place in the whole system to find out.
 */
export function parseDomainPurgePass(raw: unknown): DomainPurgePass {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MalformedPurgeResponseError('the body is not an object');
  }
  const body = raw as Record<string, unknown>;

  const canonicalDomain = body.canonicalDomain;
  if (typeof canonicalDomain !== 'string' || canonicalDomain.length === 0) {
    throw new MalformedPurgeResponseError('"canonicalDomain" is missing');
  }

  const dryRun = body.dryRun;
  if (typeof dryRun !== 'boolean') {
    throw new MalformedPurgeResponseError('"dryRun" is not a boolean');
  }

  const done = body.done;
  if (typeof done !== 'boolean') {
    throw new MalformedPurgeResponseError('"done" is not a boolean');
  }

  const nextCursor = body.nextCursor ?? null;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || !OBJECT_ID_PATTERN.test(nextCursor))) {
    throw new MalformedPurgeResponseError('"nextCursor" is neither null nor an object id');
  }

  const retained = body.actorsRetained;
  if (!Array.isArray(retained)) {
    throw new MalformedPurgeResponseError('"actorsRetained" is not an array');
  }
  const retainedByAppIds = new Set<string>();
  for (const entry of retained) {
    if (!entry || typeof entry !== 'object') {
      throw new MalformedPurgeResponseError('"actorsRetained" holds a non-object');
    }
    const appIds = (entry as { referencedByAppIds?: unknown }).referencedByAppIds;
    if (!Array.isArray(appIds)) {
      throw new MalformedPurgeResponseError('a retained actor has no "referencedByAppIds"');
    }
    for (const appId of appIds) {
      if (typeof appId === 'string' && appId.length > 0) retainedByAppIds.add(appId);
    }
  }

  return {
    canonicalDomain,
    dryRun,
    actorsMatched: readCount(body, 'actorsMatched'),
    actorsProcessed: readCount(body, 'actorsProcessed'),
    actorsDeleted: readCount(body, 'actorsDeleted'),
    actorsRetained: retained.length,
    retainedByAppIds: [...retainedByAppIds],
    filesDeleted: readCount(body, 'filesDeleted'),
    bytesDeleted: readCount(body, 'bytesDeleted'),
    avatarsDeleted: readCount(body, 'avatarsDeleted'),
    followEdgesRemoved: readCount(body, 'followEdgesRemoved'),
    localFollowersAffected: readCount(body, 'localFollowersAffected'),
    candidatesRejected: readCount(body, 'candidatesRejected'),
    remaining: readCount(body, 'remaining'),
    nextCursor,
    done,
  };
}

// --- the report --------------------------------------------------------------

/** What one domain cost, accumulated across every pass this run made for it. */
export interface DomainPurgeOutcome {
  domain: string;
  passes: number;
  /** The endpoint reported it had reached the end of the scan. */
  done: boolean;
  /** A request threw, or a response could not be read. The domain is unfinished. */
  failed: boolean;
  /** Inbound follows from real local people. The user-visible number. */
  localFollowersAffected: number;
  actorsProcessed: number;
  actorsDeleted: number;
  actorsRetained: number;
  retainedByAppIds: string[];
  filesDeleted: number;
  bytesDeleted: number;
  avatarsDeleted: number;
  followEdgesRemoved: number;
  candidatesRejected: number;
  /** Actors still matching after the last pass. Informational, never a loop condition. */
  remaining: number;
}

/**
 * Every way a run can be less than complete. All strict except
 * `requestFailed` — see {@link REQUEST_FAILURE_TOLERANCE} for why that one, and
 * only that one, has an allowance.
 */
export type PlatformPurgeIssues = {
  /** A request threw. Transient below the stated rate; systemic above it. */
  requestFailed: number;
  /** A response could not be validated. Contract drift between the two ends. */
  malformedResponse: number;
  /** `done:false` with a cursor that did not advance — the endpoint's livelock, caller side. */
  stalledCursor: number;
  /** A domain used its whole pass budget without finishing. */
  passCeilingReached: number;
  /** Oxy canonicalised the domain differently than we did. */
  canonicalDomainMismatch: number;
  /**
   * Rows Oxy's indexed candidate query returned that its own canonical rule then
   * refused. Should always be 0; anything else means the query is wider than the
   * rule, which is the shape a purge over-reaches through — so it fails the run
   * here rather than sitting in a counter nobody reads.
   */
  candidatesRejected: number;
  /** Oxy reported a different mode than the request asked for. */
  dryRunMismatch: number;
  /** A resume point could not be persisted, so the domain is not resumable. */
  cursorWriteFailed: number;
  /** The run stopped early on consecutive failures, or on a mode disagreement. */
  abortedEarly: number;
};

export interface PlatformPurgeReport {
  dryRun: boolean;
  /** Domains this run actually attempted — the denominator for every rate. */
  domainsVisited: number;
  outcomes: DomainPurgeOutcome[];
  issues: PlatformPurgeIssues;
}

export function emptyIssues(): PlatformPurgeIssues {
  return {
    requestFailed: 0,
    malformedResponse: 0,
    stalledCursor: 0,
    passCeilingReached: 0,
    canonicalDomainMismatch: 0,
    candidatesRejected: 0,
    dryRunMismatch: 0,
    cursorWriteFailed: 0,
    abortedEarly: 0,
  };
}

function emptyOutcome(domain: string): DomainPurgeOutcome {
  return {
    domain,
    passes: 0,
    done: false,
    failed: false,
    localFollowersAffected: 0,
    actorsProcessed: 0,
    actorsDeleted: 0,
    actorsRetained: 0,
    retainedByAppIds: [],
    filesDeleted: 0,
    bytesDeleted: 0,
    avatarsDeleted: 0,
    followEdgesRemoved: 0,
    candidatesRejected: 0,
    remaining: 0,
  };
}

// --- the sweep ---------------------------------------------------------------

/**
 * Where a domain resumes from.
 *
 * A DRY RUN reads the stored cursor but never writes one, which is the only way
 * a plan can honestly describe the execute that follows it: both start at the
 * same actor. `RESET_CURSOR` on a dry run therefore ignores the row rather than
 * deleting it — deleting would be a write, and a plan writes nothing.
 */
async function resumeCursor(
  domain: string,
  options: PlatformPurgeOptions,
): Promise<{ afterId?: string; scanned: number }> {
  if (options.resetCursor) {
    if (!options.dryRun) await clearAdminScriptCursor(SCRIPT_NAME, domain);
    return { scanned: 0 };
  }

  const stored = await readAdminScriptCursor(SCRIPT_NAME, domain);
  if (!stored) return { scanned: 0 };
  if (!OBJECT_ID_PATTERN.test(stored.cursor)) {
    // Only this script writes these rows, and only ever from a `nextCursor`, so
    // this is unreachable short of hand-editing. Sweeping the domain from the
    // top is the safe reading: idempotent, and it cannot skip an actor.
    logger.warn(`[${SCRIPT_NAME}] ignoring an unreadable resume cursor`, { domain });
    return { scanned: 0 };
  }
  return { afterId: stored.cursor, scanned: stored.scanned };
}

/**
 * Purge ONE domain, paging until the endpoint says it is done.
 *
 * Throws only {@link DryRunViolationError}, which is fatal to the whole run.
 * Every other failure is recorded against the domain and the sweep moves on:
 * one instance's unfinished purge must not strand the other 117.
 */
export async function purgeDomainOnPlatform(
  domain: string,
  options: PlatformPurgeOptions,
  issues: PlatformPurgeIssues,
): Promise<DomainPurgeOutcome> {
  const outcome = emptyOutcome(domain);
  const retainedByAppIds = new Set<string>();
  const { afterId: resumeFrom, scanned: alreadyScanned } = await resumeCursor(domain, options);

  let afterId = resumeFrom;
  let lastCursor = resumeFrom;
  let scanned = alreadyScanned;

  for (let pass = 1; pass <= options.maxPassesPerDomain; pass += 1) {
    const request = buildPurgeRequest(domain, options, afterId);
    // Counted before the call, not after it: a pass that failed is still a pass
    // that was made, and a report saying `passes: 0` next to `failed` would
    // describe a domain nobody had tried.
    outcome.passes = pass;

    let result: DomainPurgePass;
    try {
      result = parseDomainPurgePass(
        await getServiceOxyClient().makeServiceRequest('POST', PURGE_PATH, request),
      );
    } catch (error) {
      outcome.failed = true;
      if (error instanceof MalformedPurgeResponseError) {
        issues.malformedResponse += 1;
        logger.error(`[${SCRIPT_NAME}] unreadable response`, { domain, error });
      } else {
        issues.requestFailed += 1;
        // The whole error object goes to the logger, which sanitises it and
        // keeps `status` — so a 401 (credential), 403 (scope) or 409 (deployment
        // not armed) is legible without this script re-deriving any of it.
        logger.error(`[${SCRIPT_NAME}] request failed`, { domain, error });
      }
      break;
    }

    // The two ends must agree on what was asked for before anything is believed
    // about what happened. A mode disagreement means a dry run may have deleted,
    // or an execute may have done nothing; neither is survivable by continuing.
    if (result.dryRun !== options.dryRun) {
      issues.dryRunMismatch += 1;
      throw new DryRunViolationError(options.dryRun, result.dryRun);
    }

    // Both ends canonicalise with `@oxyhq/federation`, so these agree unless the
    // two deployments hold different versions of it — the exact drift that makes
    // a block and a deletion target different hosts. Refuse the domain rather
    // than accept a purge aimed at a host we did not name.
    if (result.canonicalDomain !== domain) {
      issues.canonicalDomainMismatch += 1;
      outcome.failed = true;
      logger.error(`[${SCRIPT_NAME}] Oxy canonicalised the domain differently`, {
        domain,
        canonical: result.canonicalDomain,
      });
      break;
    }

    outcome.localFollowersAffected += result.localFollowersAffected;
    outcome.actorsProcessed += result.actorsProcessed;
    outcome.actorsDeleted += result.actorsDeleted;
    outcome.actorsRetained += result.actorsRetained;
    outcome.filesDeleted += result.filesDeleted;
    outcome.bytesDeleted += result.bytesDeleted;
    outcome.avatarsDeleted += result.avatarsDeleted;
    outcome.followEdgesRemoved += result.followEdgesRemoved;
    outcome.candidatesRejected += result.candidatesRejected;
    issues.candidatesRejected += result.candidatesRejected;
    outcome.remaining = result.remaining;
    for (const appId of result.retainedByAppIds) retainedByAppIds.add(appId);

    scanned += result.actorsProcessed;
    if (result.nextCursor !== null) lastCursor = result.nextCursor;

    if (result.done) {
      outcome.done = true;
      await saveProgress(domain, options, lastCursor, scanned, issues, true);
      break;
    }

    // `done:false` promises another page, which requires a cursor STRICTLY after
    // the one we sent. Anything else would re-request the same head forever —
    // the endpoint's own former livelock, rebuilt on this side. Stop instead.
    if (result.nextCursor === null || result.nextCursor === afterId) {
      issues.stalledCursor += 1;
      outcome.failed = true;
      logger.error(`[${SCRIPT_NAME}] the cursor did not advance on an unfinished pass`, {
        domain,
        pass,
      });
      break;
    }

    afterId = result.nextCursor;
    await saveProgress(domain, options, afterId, scanned, issues, false);
  }

  outcome.retainedByAppIds = [...retainedByAppIds];

  if (!outcome.done && !outcome.failed) {
    issues.passCeilingReached += 1;
    logger.error(`[${SCRIPT_NAME}] domain used its whole pass budget without finishing`, {
      domain,
      passes: outcome.passes,
    });
  }

  return outcome;
}

/**
 * Record where a domain got to. A dry run records nothing — a cursor row IS a
 * write, and a plan that leaves state behind is not a plan.
 *
 * A failed write is counted rather than thrown: the pass already happened, and
 * losing the receipt must not abandon a sweep that is otherwise working. It is a
 * strict issue, so a run whose progress never persisted still exits non-zero
 * instead of quietly becoming unresumable.
 */
async function saveProgress(
  domain: string,
  options: PlatformPurgeOptions,
  cursor: string | undefined,
  scanned: number,
  issues: PlatformPurgeIssues,
  completed: boolean,
): Promise<void> {
  if (options.dryRun) return;
  // Nothing matched and nothing was ever paged: there is no resume point to
  // record, and inventing one would be a lie about where the next run starts.
  if (cursor === undefined) return;

  const persisted = await recordAdminScriptCursor(SCRIPT_NAME, domain, {
    cursor,
    scanned,
    completed,
  });
  if (!persisted) issues.cursorWriteFailed += 1;
}

/**
 * Walk the policy, domain by domain.
 *
 * Sequential on purpose: this is a destructive sweep against a shared platform
 * running live traffic, and there is no deadline on it. Concurrency would buy
 * wall-clock time at the price of a much wider blast radius per mistake.
 */
export async function purgeBlockedDomainPlatformData(
  domains: ReadonlySet<string>,
  options: PlatformPurgeOptions,
): Promise<PlatformPurgeReport> {
  const report: PlatformPurgeReport = {
    dryRun: options.dryRun,
    domainsVisited: 0,
    outcomes: [],
    issues: emptyIssues(),
  };

  let consecutiveFailures = 0;

  for (const domain of [...domains].sort()) {
    report.domainsVisited += 1;

    let outcome: DomainPurgeOutcome;
    try {
      outcome = await purgeDomainOnPlatform(domain, options, report.issues);
    } catch (error) {
      // A mode disagreement is fatal to the RUN, not just the domain — but the
      // report still has to reach the operator, so it is caught here rather than
      // thrown past the table. `dryRunMismatch` is already counted and strict,
      // so the run exits non-zero whatever else it managed to do.
      if (!(error instanceof DryRunViolationError)) throw error;
      report.issues.abortedEarly += 1;
      logger.error(`[${SCRIPT_NAME}] stopping: Oxy disagreed about the mode`, { domain, error });
      break;
    }

    report.outcomes.push(outcome);

    consecutiveFailures = outcome.failed ? consecutiveFailures + 1 : 0;
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      report.issues.abortedEarly += 1;
      logger.error(`[${SCRIPT_NAME}] stopping: ${MAX_CONSECUTIVE_FAILURES} domains failed in a row`, {
        domainsVisited: report.domainsVisited,
        domainsRemaining: domains.size - report.domainsVisited,
      });
      break;
    }
  }

  return report;
}

/**
 * The domains this run may touch: the REVIEWED policy, and nothing else.
 *
 * `config.federation.blockedDomains` is not reachable from here — see the file
 * header for why an environment string may stop new content but may not delete
 * an instance's history from a shared platform.
 *
 * The set is built by the SAME function the local content purge uses, so both
 * halves of a blocked domain's cleanup provably target the same hosts: it
 * subtracts our own domains (an operator cannot blocklist us into purging our
 * own users), refuses an empty target set rather than sweeping nothing or
 * everything, and rejects a `PURGE_DOMAIN` that is not in the policy.
 */
export function resolvePurgeTargets(options: PlatformPurgeOptions): ReadonlySet<string> {
  return buildBlockedContentDomains(
    getBlockedDomainPolicy().map((entry) => entry.domain),
    OWN_DOMAINS,
    options.domain,
  );
}

/**
 * The run's verdict. Everything is strict except `requestFailed`, whose
 * allowance and its reasoning are stated in one place and are a property of the
 * sweep rather than of the invocation — there is deliberately no way to relax it
 * from the outside.
 */
export function assertPlatformPurgeRunComplete(report: PlatformPurgeReport): void {
  assertAdminRunComplete(SCRIPT_NAME, report.issues, {
    scanned: report.domainsVisited,
    tolerate: {
      requestFailed: {
        maxFraction: REQUEST_FAILURE_TOLERANCE,
        reason:
          'oxy-api rolls deploys, so an individual call can 502 or lose its token mid-flight; '
          + 'the purge is idempotent and the domain keeps its cursor, so the next run resumes it',
      },
    },
  });
}

// --- reporting ---------------------------------------------------------------

const MIB = 1024 * 1024;

/** What a row's state was when the run left it. */
function stateOf(outcome: DomainPurgeOutcome): string {
  if (outcome.failed) return 'failed';
  if (!outcome.done) return 'partial';
  return 'done';
}

/**
 * The per-domain table, led by the number that describes people rather than
 * inventory, and ranked by it.
 */
export function renderDomainTable(report: PlatformPurgeReport): string[] {
  const rows = report.outcomes
    .filter((outcome) =>
      outcome.failed
      || !outcome.done
      || outcome.actorsProcessed > 0
      || outcome.remaining > 0)
    .sort((a, b) =>
      b.localFollowersAffected - a.localFollowersAffected
      || b.actorsDeleted - a.actorsDeleted
      || a.domain.localeCompare(b.domain));

  if (rows.length === 0) return ['no blocked domain had anything left on the platform'];

  const cells = rows.map((outcome) => ({
    domain: outcome.domain,
    followers: String(outcome.localFollowersAffected),
    actors: String(outcome.actorsProcessed),
    deleted: String(outcome.actorsDeleted),
    kept: String(outcome.actorsRetained),
    files: String(outcome.filesDeleted),
    mib: (outcome.bytesDeleted / MIB).toFixed(1),
    left: String(outcome.remaining),
    passes: String(outcome.passes),
    state: stateOf(outcome),
  }));
  const header = {
    domain: 'DOMAIN',
    followers: 'FOLLOWERS',
    actors: 'ACTORS',
    deleted: 'DELETED',
    kept: 'KEPT',
    files: 'FILES',
    mib: 'MiB',
    left: 'LEFT',
    passes: 'PASSES',
    state: 'STATE',
  };

  const columns = Object.keys(header) as (keyof typeof header)[];
  const widths = new Map<string, number>(
    columns.map((column) => [
      column,
      Math.max(header[column].length, ...cells.map((row) => row[column].length)),
    ]),
  );
  const renderRow = (row: Record<string, string>): string =>
    columns.map((column) => row[column].padEnd(widths.get(column) ?? 0)).join('  ').trimEnd();

  return [renderRow(header), ...cells.map(renderRow)];
}

/** Run totals, `localFollowersAffected` first. */
export function totalsOf(report: PlatformPurgeReport): Record<string, number> {
  const sum = (pick: (outcome: DomainPurgeOutcome) => number): number =>
    report.outcomes.reduce((total, outcome) => total + pick(outcome), 0);

  return {
    localFollowersAffected: sum((outcome) => outcome.localFollowersAffected),
    actorsProcessed: sum((outcome) => outcome.actorsProcessed),
    actorsDeleted: sum((outcome) => outcome.actorsDeleted),
    actorsRetained: sum((outcome) => outcome.actorsRetained),
    filesDeleted: sum((outcome) => outcome.filesDeleted),
    bytesDeleted: sum((outcome) => outcome.bytesDeleted),
    avatarsDeleted: sum((outcome) => outcome.avatarsDeleted),
    followEdgesRemoved: sum((outcome) => outcome.followEdgesRemoved),
    candidatesRejected: sum((outcome) => outcome.candidatesRejected),
    domainsFinished: report.outcomes.filter((outcome) => outcome.done).length,
  };
}

// --- entry point -------------------------------------------------------------

/**
 * Refuse before the first request if there is no service credential to make it
 * with. Without one every call is an unauthenticated 401, and the run would
 * spend five domains discovering a configuration problem it could state up front.
 */
function assertServiceCredentialConfigured(): void {
  const { apiKey, apiSecret, token } = getOxyServiceCredentials();
  if ((apiKey && apiSecret) || token) return;
  throw new Error(
    `[${SCRIPT_NAME}] no Oxy service credential is configured `
    + '(OXY_SERVICE_API_KEY + OXY_SERVICE_API_SECRET, or OXY_SERVICE_TOKEN). '
    + 'The purge endpoint resolves whose data may be deleted from that credential.',
  );
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const options = readOptions();

  try {
    assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun: options.dryRun });
    assertServiceCredentialConfigured();

    const domains = resolvePurgeTargets(options);

    // The cursor rows live in Mongo; the purge itself happens entirely over the
    // Oxy API.
    await connectToDatabase();
    logger.info(`[${SCRIPT_NAME}] connected`, {
      dryRun: options.dryRun,
      domains: domains.size,
      batchLimit: options.batchLimit,
      narrowedScope: Boolean(options.domain),
      resetCursor: options.resetCursor,
    });

    const report = await purgeBlockedDomainPlatformData(domains, options);

    // One record per line: the backend logger caps a single string field, and a
    // table in one field is truncated exactly where the tail of the ranking is.
    for (const line of renderDomainTable(report)) {
      logger.info(`[${SCRIPT_NAME}] domain`, { row: line });
    }
    logger.info(
      `[${SCRIPT_NAME}] ${options.dryRun ? 'WOULD-remove' : 'removed'} totals`,
      totalsOf(report),
    );
    logger.info(`[${SCRIPT_NAME}] done`, {
      dryRun: options.dryRun,
      domainsVisited: report.domainsVisited,
      durationMs: Date.now() - startedAt,
    });

    assertPlatformPurgeRunComplete(report);
  } catch (error) {
    logger.error(`[${SCRIPT_NAME}] failed`, error);
    throw error;
  } finally {
    await closeAdminScriptResources();
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  // Exit deterministically: imported singletons (BullMQ Redis handles, the media
  // cache worker) keep the event loop alive, so a Fargate one-shot would sit
  // RUNNING after the work completed. Mirrors the other federation one-shots.
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(`[${SCRIPT_NAME}] unhandled failure`, error);
      process.exit(1);
    });
}

export default purgeBlockedDomainPlatformData;
