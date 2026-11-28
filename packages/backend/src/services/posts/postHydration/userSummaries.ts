// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/** Resolving authors to their cached Oxy identity, within a shared deadline and a bounded failure memory. */
import type { PostUser } from '@mention/shared-types';
import type { PostRecordFederation } from '../../../db/posts/postRecord';
import type { FederatedActorRecord } from '../../../db/federation/actorRecord';
import { findActorsByUris } from '../../../db/federation/actorRepository';
import { deriveBridgyActorUri } from '../../../connectors/activitypub/bridgy';
import { getRuntimeOxyClient } from '../../../runtime/oxyClient';
import { lookupOxyUsers } from '../../../utils/oxyUserLookup';
import { logger } from '../../../utils/logger';
import { metrics } from '../../../utils/metrics';
import type { User as OxyUser } from '@oxy.so/core';
import { isRetryableError } from '@oxy.so/core';
import { chunk } from '@oxy.so/utils/text';
import {
  mget as mgetUserSummaries,
  mset as msetUserSummaries,
  type CachedUserSummary,
} from '../../accounts/userSummaryCache';
import {
  computeStarterPackScores,
  starterPackCurationDeps,
} from '../../accounts/starterPackCuration';
import { degradedActorSummary } from '../../../utils/degradedActorSummary';

/**
 * Build the cached identity ({@link CachedUserSummary}: raw Oxy user + the
 * ranking-side follower count and account facts) from a resolved Oxy user.
 * Oxy owns the user shape, so the {@link PostUser} half is a PASSTHROUGH: it
 * selects the canonical fields without reshaping — no flat `displayName`, no
 * pre-resolved `avatarUrl`, no wire `handle`. `avatar` stays the bare Oxy file id
 * (Bloom's `ImageResolver` renders it, same as Who-to-follow / the profile
 * header). Centralized so the per-id and the bulk resolution paths cache
 * IDENTICAL output.
 */
function toCachedUser(userId: string, userData: OxyUser): CachedUserSummary {
  const isFederated = Boolean(userData.isFederated) || userData.type === 'federated';
  const federation = userData.federation;

  const user: PostUser = {
    id: String(userData.id || userId),
    username: userData.username || undefined,
    // Canonical structured name — passed through unchanged. `name.displayName`
    // is present only when the user has a real name; renderers fall back to the
    // handle when it is absent (never synthesize a name here).
    name: userData.name ?? {},
    // Bare Oxy file id (or a mirrored absolute URL) — never pre-resolved here.
    avatar: userData.avatar ?? null,
    verified: Boolean(userData.verified || userData.isVerified),
    // The account classification, passed through UNCHANGED like every other Oxy
    // user field. It is what tells a renderer to link a channel's post to
    // `/c/<handle>`, and what `services/accounts/publishAsAccount` reads server-side.
    kind: userData.kind,
    character: userData.character,
    color: userData.color,
    isFederated: isFederated || undefined,
    federation: federation
      ? { domain: federation.domain, actorUri: federation.actorUri, actorId: federation.actorId }
      : undefined,
    instance: isFederated
      ? userData.instance || federation?.domain
      : userData.instance || undefined,
  };

  const followerCount = userData._count?.followers;
  // Two RANKING-side account facts Oxy has always sent and this serializer used to
  // drop on the floor, because it names its fields one by one. Neither belongs on
  // `PostUser` — same reasoning as `followerCount`: they describe the ACCOUNT
  // for ranking, not the author of a post for a renderer.
  const accountCreatedAt =
    typeof userData.createdAt === 'string' && userData.createdAt.length > 0
      ? userData.createdAt
      : undefined;
  const reputationTier =
    typeof (userData as { reputationTier?: unknown }).reputationTier === 'string'
      ? (userData as { reputationTier?: string }).reputationTier
      : undefined;
  return {
    user,
    followerCount: typeof followerCount === 'number' ? followerCount : undefined,
    accountCreatedAt,
    reputationTier,
  };
}

// Preserve the existing public import path while keeping the placeholder in a
// dependency-light module that non-hydration surfaces can safely reuse.
export { degradedActorSummary };

/** A minimal, safe cached value used when an author cannot be resolved from Oxy. */
function fallbackSummary(userId: string): CachedUserSummary {
  return { user: degradedActorSummary(userId) };
}

/**
 * Whether a {@link PostUser} is the degraded/unresolved placeholder — the ONLY
 * user with an EMPTY `username` (a resolved Oxy user always has one). Callers use this
 * to SKIP an unresolved actor (starter-pack members, mention-placeholder
 * replacement) instead of rendering a nameless row. Kept in lockstep with
 * `degradedActorSummary`.
 */
export function isFallbackUserSummary(user: PostUser): boolean {
  return !user.username;
}

/**
 * Stamp the bounded starter-pack CURATION score onto the summaries resolved in
 * this batch, BEFORE they are written to the Redis cache — so the score is read
 * back on every warm hydration and the `starterPackBoost` ranking signal costs no
 * per-post (and no per-author) query.
 *
 * ONE batched aggregation for the WHOLE set of freshly-resolved authors, run only
 * on the cache-MISS path. Fail-soft by construction: {@link computeStarterPackScores}
 * never throws, and an author with no score is simply left without the field,
 * which the signal reads as exactly neutral. Mutates `freshlyResolved` in place.
 */
async function applyStarterPackScores(
  freshlyResolved: Map<string, CachedUserSummary>,
): Promise<void> {
  if (freshlyResolved.size === 0) return;

  const scores = await computeStarterPackScores(
    Array.from(freshlyResolved.keys()),
    starterPackCurationDeps,
  );
  for (const [userId, score] of scores) {
    const summary = freshlyResolved.get(userId);
    if (summary) {
      summary.starterPackScore = score;
    }
  }
}

/** Ids per Oxy request: the SDK's chunk size, so one chunk is one request. */
const OXY_USER_LOOKUP_CHUNK_SIZE = 100;

/** Maximum number of public per-user Oxy reads in flight after a bulk miss. */
export const OXY_USER_FALLBACK_CONCURRENCY = 8;

/** One wall-clock budget shared by the bulk read and every fallback read. */
export const OXY_USER_RESOLUTION_DEADLINE_MS = 1_500;

/**
 * How long an author Oxy could not resolve is answered with the placeholder
 * without asking again. A failed author was never cached, so during an Oxy
 * outage every feed render re-asked for the same authors — on the budget that
 * had just run out. A few seconds absorbs the renders of a burst and still
 * lets a recovered Oxy show real names on the next scroll.
 */
export const OXY_USER_FAILURE_TTL_MS = 5_000;

/**
 * How long an author Oxy ANSWERED without (the account is gone, archived or
 * restricted) is answered with the placeholder without asking again. Longer than
 * a failure's: absence is the server's word, not a blip, and a recovered account
 * is also announced by Oxy's user-invalidation broadcast.
 */
export const OXY_USER_ABSENT_TTL_MS = 60_000;

const OXY_USER_FAILURE_MAX_ENTRIES = 10_000;

/**
 * Authors whose resolution just failed, or that Oxy answered without, with when
 * they may be asked again ({@link OXY_USER_FAILURE_TTL_MS} / {@link OXY_USER_ABSENT_TTL_MS}).
 * Per task.
 */
const failedUserLookups = new Map<string, number>();

/** Forget every remembered failure: a test that fails an author, then serves it. */
export function resetOxyUserFailureMemory(): void {
  failedUserLookups.clear();
}

function recentlyFailedUserLookup(userId: string, now: number): boolean {
  const retryAt = failedUserLookups.get(userId);
  if (retryAt === undefined) return false;
  if (retryAt > now) return true;
  failedUserLookups.delete(userId);
  return false;
}

function rememberFailedUserLookups(userIds: readonly string[], ttlMs: number): void {
  const retryAt = Date.now() + ttlMs;
  for (const userId of userIds) {
    failedUserLookups.delete(userId);
    failedUserLookups.set(userId, retryAt);
  }
  // Insertion-ordered: the oldest failures go first.
  for (const userId of failedUserLookups.keys()) {
    if (failedUserLookups.size <= OXY_USER_FAILURE_MAX_ENTRIES) break;
    failedUserLookups.delete(userId);
  }
}

/**
 * Whether the bulk read failed because Oxy is overloaded or unreachable (a 429,
 * a 5xx, a network failure, the deadline). Asking for each author on its own
 * would spend the same exhausted budget N times over, so it is not attempted.
 * Any other failure (a 400/401/403 on the service read) still falls back to the
 * public per-id reads, which do not share its cause.
 */
function isOxyOverloaded(error: unknown): boolean {
  return error instanceof OxyUserResolutionDeadlineError || isRetryableError(error);
}

class OxyUserResolutionDeadlineError extends Error {
  constructor() {
    super('Oxy user resolution deadline exceeded');
    this.name = 'OxyUserResolutionDeadlineError';
  }
}

const userSummaryFlights = new Map<string, Promise<Map<string, CachedUserSummary>>>();

let activeOxyUserResolutionCalls = 0;

const oxyUserResolutionWaiters: Array<{
  grant: () => void;
  cancel: () => void;
}> = [];

async function withinUserResolutionDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new OxyUserResolutionDeadlineError();
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new OxyUserResolutionDeadlineError()), remainingMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function releaseOxyUserResolutionPermit(): void {
  const next = oxyUserResolutionWaiters.shift();
  if (next) {
    next.grant();
    return;
  }
  activeOxyUserResolutionCalls = Math.max(0, activeOxyUserResolutionCalls - 1);
}

async function acquireOxyUserResolutionPermit(deadlineAt: number): Promise<() => void> {
  if (Date.now() >= deadlineAt) {
    throw new OxyUserResolutionDeadlineError();
  }

  if (activeOxyUserResolutionCalls < OXY_USER_FALLBACK_CONCURRENCY) {
    activeOxyUserResolutionCalls += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseOxyUserResolutionPermit();
    };
  }

  return new Promise<() => void>((resolve, reject) => {
    const remainingMs = deadlineAt - Date.now();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const waiter = {
      grant: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          releaseOxyUserResolutionPermit();
        });
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new OxyUserResolutionDeadlineError());
      },
    };
    timeout = setTimeout(
      () => {
        const index = oxyUserResolutionWaiters.indexOf(waiter);
        if (index >= 0) oxyUserResolutionWaiters.splice(index, 1);
        waiter.cancel();
      },
      Math.max(0, remainingMs),
    );
    timeout.unref?.();
    oxyUserResolutionWaiters.push(waiter);
  });
}

/**
 * Bound Oxy I/O across every concurrent hydration cohort. A timed-out caller
 * stops waiting, but its permit remains occupied until the underlying SDK call
 * actually settles. This prevents slow or non-abortable SDK requests from
 * accumulating without limit during an outage.
 */
async function runBoundedOxyUserResolutionCall<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
): Promise<T> {
  const release = await acquireOxyUserResolutionPermit(deadlineAt);
  const inFlight = Promise.resolve().then(operation);
  void inFlight.then(release, release);
  return withinUserResolutionDeadline(inFlight, deadlineAt);
}

async function runWithConcurrencyLimit<T>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const value = values[nextIndex++];
      await worker(value);
    }
  });
  await Promise.all(workers);
}

async function resolveOxyUserSummaryMisses(
  missIds: string[],
): Promise<Map<string, CachedUserSummary>> {
  const deadlineAt = Date.now() + OXY_USER_RESOLUTION_DEADLINE_MS;
  const requestedIds = new Set(missIds);
  const freshlyResolved = new Map<string, CachedUserSummary>();
  let bulkFailure: unknown;
  /** Ids Oxy answered WITHOUT: the account does not exist or is not visible. */
  let lookupMissing: readonly string[] = [];
  /** Ids Oxy could not be asked about (a chunk timed out, 429, 5xx). */
  let lookupFailed: readonly string[] = [];

  // One request per chunk of the SDK's own size, each held to the shared
  // deadline on its own. A single bulk read waited for EVERY chunk, so one slow
  // chunk discarded the answers of the others too: a 270-author render lost all
  // 270 names to one 100-author timeout. Here a chunk that answers is kept, and a
  // chunk that does not is the only one reported as failed.
  const chunks = chunk(missIds, OXY_USER_LOOKUP_CHUNK_SIZE);
  const settled = await Promise.allSettled(
    chunks.map((ids) =>
      runBoundedOxyUserResolutionCall(
        () => lookupOxyUsers(ids, 'post_hydration', { counts: true }),
        deadlineAt,
      ),
    ),
  );
  const lookupMissingIds: string[] = [];
  const lookupFailedIds: string[] = [];
  settled.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      bulkFailure = outcome.reason;
      lookupFailedIds.push(...chunks[index]);
      return;
    }
    const lookup = outcome.value;
    if (lookup.error !== undefined) bulkFailure = lookup.error;
    lookupMissingIds.push(...lookup.missing);
    lookupFailedIds.push(...lookup.failed);
    for (const user of lookup.found) {
      const id = String((user as { id?: unknown }).id ?? '');
      const aliases = (user as unknown as { redirectedUserIds?: unknown }).redirectedUserIds;
      const keys = [
        id,
        ...(Array.isArray(aliases)
          ? aliases.filter((alias): alias is string => typeof alias === 'string')
          : []),
      ];
      for (const key of keys)
        if (key && requestedIds.has(key)) freshlyResolved.set(key, toCachedUser(id, user));
    }
  });
  lookupMissing = lookupMissingIds;
  lookupFailed = lookupFailedIds;

  // An id the server answered without that a found user's `redirectedUserIds`
  // covers is resolved, not absent.
  const absentIds = lookupMissing.filter((userId) => !freshlyResolved.has(userId));
  const unresolved = lookupFailed.filter((userId) => !freshlyResolved.has(userId));
  let perIdFailures = 0;
  let deadlineExceeded = bulkFailure instanceof OxyUserResolutionDeadlineError;
  const overloaded = bulkFailure !== undefined && isOxyOverloaded(bulkFailure);

  // Only ids that could not be ASKED about are read again. An absent one is the
  // server's answer already.
  if (unresolved.length > 0 && overloaded) {
    perIdFailures = unresolved.length;
  } else if (unresolved.length > 0 && Date.now() < deadlineAt) {
    await runWithConcurrencyLimit(unresolved, OXY_USER_FALLBACK_CONCURRENCY, async (userId) => {
      if (Date.now() >= deadlineAt) {
        deadlineExceeded = true;
        perIdFailures += 1;
        return;
      }

      try {
        const userData = await runBoundedOxyUserResolutionCall(
          () => getRuntimeOxyClient().users.get(userId),
          deadlineAt,
        );
        freshlyResolved.set(userId, toCachedUser(userId, userData));
      } catch (error) {
        if (error instanceof OxyUserResolutionDeadlineError) {
          deadlineExceeded = true;
        }
        perIdFailures += 1;
      }
    });
  } else if (unresolved.length > 0) {
    deadlineExceeded = true;
    perIdFailures = unresolved.length;
  }

  const stillFailed = unresolved.filter((userId) => !freshlyResolved.has(userId));
  if (stillFailed.length > 0) rememberFailedUserLookups(stillFailed, OXY_USER_FAILURE_TTL_MS);
  if (absentIds.length > 0) rememberFailedUserLookups(absentIds, OXY_USER_ABSENT_TTL_MS);

  if (stillFailed.length > 0 || absentIds.length > 0) {
    // Absence and failure are different problems with different owners: a gone
    // account is data to clean up, a failure is Oxy's availability.
    metrics.incrementCounter('oxy_user_resolution_partial_total', 1, {
      reason:
        stillFailed.length === 0
          ? 'absent'
          : deadlineExceeded
            ? 'deadline'
            : bulkFailure
              ? 'bulk_error'
              : 'per_id_error',
    });
    logger.warn('[PostHydration] Oxy user resolution was partial', {
      requested: missIds.length,
      resolved: freshlyResolved.size,
      absent: absentIds.length,
      // A few opaque ids, enough to look the accounts up in Oxy.
      absentSample: absentIds.slice(0, 3),
      failed: stillFailed.length,
      fallbackFailures: perIdFailures,
      fallbackSkipped: overloaded,
      deadlineExceeded,
      bulkReason: bulkFailure instanceof Error ? bulkFailure.message : undefined,
    });
  }

  await applyStarterPackScores(freshlyResolved);
  if (freshlyResolved.size > 0) {
    await msetUserSummaries(freshlyResolved);
  }

  const result = new Map<string, CachedUserSummary>();
  for (const userId of missIds) {
    result.set(userId, freshlyResolved.get(userId) ?? fallbackSummary(userId));
  }

  return result;
}

/**
 * Resolve {@link CachedUserSummary} for a set of Oxy user ids, collapsing the
 * classic feed M+1 (one `getUserById` per unique author) into:
 *   1. a single batched read of the Redis user-summary cache, then
 *   2. a single bulk service-token Oxy fetch for the MISSES (`getUsersByIds`
 *      via the service client; bounded per-id fallback under one deadline), then
 *   3. a single batched write of the freshly-resolved summaries back to cache.
 *
 * Cache hits never touch Oxy. Misses that error fall back to a minimal summary,
 * never written to Redis; this task answers them with it for
 * {@link OXY_USER_FAILURE_TTL_MS} before asking Oxy again. A bulk read that
 * failed because Oxy is overloaded is not fanned out per id. Shared by hydration
 * ({@link PostHydrationService.buildUserMap}) and the ranking authority signal.
 */
export async function resolveUserSummaries(
  userIds: string[],
): Promise<Map<string, CachedUserSummary>> {
  const resolved = new Map<string, CachedUserSummary>();
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  if (uniqueUserIds.length === 0) {
    return resolved;
  }

  // 1. Batched cache read.
  const cached = await mgetUserSummaries(uniqueUserIds);
  const missIds: string[] = [];
  const now = Date.now();
  for (const userId of uniqueUserIds) {
    const hit = cached.get(userId);
    if (hit) {
      resolved.set(userId, hit);
    } else if (recentlyFailedUserLookup(userId, now)) {
      // Asked a moment ago and Oxy could not answer, or answered without it: the
      // placeholder again.
      resolved.set(userId, fallbackSummary(userId));
    } else {
      missIds.push(userId);
    }
  }

  if (missIds.length === 0) {
    return resolved;
  }

  // 2. Share by identity, not by the whole miss cohort: concurrent panels often
  // overlap only partly. Batch new identities together and join existing reads.
  const unclaimedIds = missIds.filter((userId) => !userSummaryFlights.has(userId));
  if (unclaimedIds.length > 0) {
    const flight = resolveOxyUserSummaryMisses(unclaimedIds);
    for (const userId of unclaimedIds) userSummaryFlights.set(userId, flight);
    const release = () => {
      for (const userId of unclaimedIds) {
        if (userSummaryFlights.get(userId) === flight) userSummaryFlights.delete(userId);
      }
    };
    void flight.then(release, release);
  }

  const flights = new Set<Promise<Map<string, CachedUserSummary>>>();
  for (const userId of missIds) {
    const flight = userSummaryFlights.get(userId);
    if (flight) flights.add(flight);
  }
  const batches = await Promise.all(flights);

  // 3. A shared batch can contain other callers' identities. Return exactly this
  // caller's misses, alongside its cache hits, including uncached fallbacks.
  const requestedMisses = new Set(missIds);
  for (const batch of batches) {
    for (const [userId, value] of batch) {
      if (requestedMisses.has(userId)) resolved.set(userId, value);
    }
  }

  return resolved;
}

/**
 * Resolve legacy source-bound authors through their stored Oxy IDs. Transport
 * records only locate the source; public profiles come from the Oxy summary
 * cache or the normal Oxy user read. Hydration never discovers remote actors.
 * Missing identities remain neutral so the post content can still render.
 */
export async function resolveOrphanFederatedAuthors(
  orphans: Array<{ postId: string; federation: PostRecordFederation }>,
): Promise<Map<string, PostUser>> {
  const result = new Map<string, PostUser>();
  if (orphans.length === 0) return result;

  const derivedByPost = new Map<string, string>();
  const lookupUris = new Set<string>();
  for (const { postId, federation } of orphans) {
    if (federation.actorUri) {
      lookupUris.add(federation.actorUri);
      continue;
    }
    const derivedUri = deriveBridgyActorUri(federation.activityId, federation.url);
    if (derivedUri) {
      derivedByPost.set(postId, derivedUri);
      lookupUris.add(derivedUri);
    }
  }

  const actorByUri = new Map<string, FederatedActorRecord>();
  if (lookupUris.size > 0) {
    try {
      const actors = await findActorsByUris(Array.from(lookupUris));
      for (const actor of actors) {
        actorByUri.set(actor.uri, actor);
      }
    } catch (error) {
      logger.warn('[PostHydration] Orphan federated author lookup failed', {
        count: lookupUris.size,
        reason: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  const summaries = await resolveUserSummaries(
    [...actorByUri.values()].flatMap((actor) => (actor.oxyUserId ? [actor.oxyUserId] : [])),
  );
  for (const { postId, federation } of orphans) {
    const actorUri = federation.actorUri ?? derivedByPost.get(postId);
    const actor = actorUri ? actorByUri.get(actorUri) : undefined;
    const summary = actor?.oxyUserId ? summaries.get(actor.oxyUserId)?.user : undefined;
    result.set(
      postId,
      summary && !isFallbackUserSummary(summary)
        ? summary
        : { ...degradedActorSummary(actor?.oxyUserId || postId), isFederated: true },
    );
  }

  return result;
}
