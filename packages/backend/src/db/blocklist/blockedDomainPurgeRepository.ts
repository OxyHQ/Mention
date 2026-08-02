/**
 * `blocked_domain_purges` (the per-domain STATE) and `blocked_domain_purge_runs`
 * (the per-domain-per-run HISTORY).
 *
 * ## Two tables because a domain can be blocked twice
 *
 * The state row carries what the circuit breaker last measured; the history row
 * carries what a run actually removed. Storing the counts only on the state row
 * would overwrite the first purge's result with the second and make any total
 * for that domain quietly wrong. `(domain, run_id)` is unique on the history, so
 * a retried or resumed run UPDATES its row rather than appending — an append
 * would inflate a sum-per-domain, which is a public transparency number.
 *
 * ## The claim is a LEASE, and its false answer points at a second sweep
 *
 * `state = 'in_progress'` plus `claimed_at` is what stops two overlapping
 * deploys sweeping the same domains. A claim that reads as absent lets a second
 * run start on a domain the first may still be inside — and these are
 * irreversible deletions. So the claim and the re-arm are both single
 * conditional statements whose affected rows ARE the answer, never a read
 * followed by a write.
 *
 * ## Batched, because this runs on every deploy
 *
 * The policy read and both writes are constant-round-trip regardless of how many
 * domains the blocklist holds. Measured before the Mongo version was batched:
 * 2.0ms per domain, dead linear from 118 to 944 domains. Keeping it constant is
 * not an optimisation so much as removing a reason for the policy to ever be
 * kept small.
 */

import { and, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { getDb } from '../postgres';
import { blockedDomainPurges, blockedDomainPurgeRuns } from '../schema/blocklist';

/**
 * What a purge removed for one domain.
 *
 * Deliberately NARROWER than the purge script's internal counters: this is the
 * record a human review and the public transparency surface read, so it carries
 * the numbers that answer "what was lost" rather than every internal tally.
 * Widening the script's counters must not silently change a persisted shape.
 *
 * Declared here rather than on the deleted Mongoose model, for the reason it was
 * declared there: both the script and the reconciler satisfy {@link PurgeTallies}
 * BY SHAPE, so the persisted record can be written from either without this
 * module depending on a script or the script depending on the reconciler.
 */
export interface BlockedDomainPurgeCounts {
  posts: number;
  actors: number;
  boosts: number;
  likes: number;
  notifications: number;
  mediaCacheRows: number;
  /** Local posts left pointing at removed content (replies + quotes + thread roots). */
  localContentKept: number;
  /** Accepted outbound follows removed — a local user had followed an account there. */
  localFollowsRemoved: number;
}

/** The tallies {@link toLedgerCounts} reads, described structurally. */
export interface PurgeTallies {
  posts: number;
  orphanPosts: number;
  actors: number;
  boostsByOthers: number;
  likesOnRemovedPosts: number;
  likesByBlockedActors: number;
  notificationsByEntity: number;
  notificationsByActor: number;
  mediaCacheRows: number;
  repliesByOthersKept: number;
  quotesByOthersKept: number;
  threadRootsKept: number;
  localFollowsRemoved: number;
}

/**
 * Narrow a run's internal tallies to the shape this ledger persists.
 *
 * Deliberately lossy: adding an internal counter to the purge must not silently
 * widen a stored record.
 */
export function toLedgerCounts(totals: PurgeTallies): BlockedDomainPurgeCounts {
  return {
    posts: totals.posts + totals.orphanPosts,
    actors: totals.actors,
    boosts: totals.boostsByOthers,
    likes: totals.likesOnRemovedPosts + totals.likesByBlockedActors,
    notifications: totals.notificationsByEntity + totals.notificationsByActor,
    mediaCacheRows: totals.mediaCacheRows,
    localContentKept:
      totals.repliesByOthersKept + totals.quotesByOthersKept + totals.threadRootsKept,
    localFollowsRemoved: totals.localFollowsRemoved,
  };
}

/** `BlockedDomainPurgeState`. */
export type BlockedDomainPurgeState =
  | 'pending'
  | 'in_progress'
  | 'purged'
  | 'held'
  | 'failed';

/** What the reconciler needs to know about a domain it already has a row for. */
export interface ObservedPurgeRow {
  domain: string;
  inPolicy: boolean;
  state: BlockedDomainPurgeState;
}

/** The eight `measured_*` columns, written together or not at all. */
function measuredColumns(counts: BlockedDomainPurgeCounts) {
  return {
    measuredPosts: counts.posts,
    measuredActors: counts.actors,
    measuredBoosts: counts.boosts,
    measuredLikes: counts.likes,
    measuredNotifications: counts.notifications,
    measuredMediaCacheRows: counts.mediaCacheRows,
    measuredLocalContentKept: counts.localContentKept,
    measuredLocalFollowsRemoved: counts.localFollowsRemoved,
  };
}

/**
 * Re-arm claims from a run that never reported back.
 *
 * `claimed_at` and `run_id` are CLEARED here, which is the one place clearing
 * them is correct: the lease has demonstrably expired, and leaving it would
 * block the domain forever. Everywhere else an expired lease is kept verbatim,
 * because clearing it is what lets a second run claim a domain the first is
 * inside.
 *
 * @returns How many rows were re-armed.
 */
export async function reArmStaleClaims(cutoff: Date): Promise<number> {
  const rows = await getDb()
    .update(blockedDomainPurges)
    .set({ state: 'pending', claimedAt: null, runId: null })
    .where(
      and(
        eq(blockedDomainPurges.state, 'in_progress'),
        lt(blockedDomainPurges.claimedAt, cutoff)
      )
    )
    .returning({ domain: blockedDomainPurges.domain });
  return rows.length;
}

/** What the ledger already holds for each named domain. ONE read. */
export async function findPurgeRows(domains: readonly string[]): Promise<ObservedPurgeRow[]> {
  if (domains.length === 0) return [];
  return getDb()
    .select({
      domain: blockedDomainPurges.domain,
      inPolicy: blockedDomainPurges.inPolicy,
      state: blockedDomainPurges.state,
    })
    .from(blockedDomainPurges)
    .where(inArray(blockedDomainPurges.domain, [...domains]));
}

/** One domain's observation: it is in the policy, at this state, right now. */
export interface PolicyObservation {
  domain: string;
  state: BlockedDomainPurgeState;
}

/**
 * Record that every named domain is in the policy, at the state the caller
 * computed. ONE write.
 *
 * `first_observed_at` is supplied only in the INSERT branch — Mongo's
 * `$setOnInsert` — so a domain observed again keeps the moment it was first
 * seen. `state` comes from `excluded`, which is what lets one statement carry a
 * different state per domain.
 */
export async function observePolicyDomains(
  observations: readonly PolicyObservation[],
  now: Date
): Promise<void> {
  if (observations.length === 0) return;
  await getDb()
    .insert(blockedDomainPurges)
    .values(
      observations.map((observation) => ({
        domain: observation.domain,
        inPolicy: true,
        state: observation.state,
        firstObservedAt: now,
        lastObservedAt: now,
      }))
    )
    .onConflictDoUpdate({
      target: blockedDomainPurges.domain,
      set: {
        inPolicy: true,
        state: sql`excluded.state`,
        lastObservedAt: now,
        updatedAt: now,
      },
    });
}

/**
 * Mark every in-policy domain NOT in `wanted` as departed.
 *
 * Flagged, never undone: there is no restore path in this system. The flag
 * exists for the opposite case — a domain removed and later RE-ADDED is newly
 * blocked again, because content can have arrived while it was allowed.
 *
 * An EMPTY `wanted` means the policy is empty and every in-policy domain has
 * departed. That is a real case (Mongo's `$nin: []` matches everything) and it
 * is handled explicitly, because SQL `not in ()` is a syntax error rather than a
 * predicate — a naive port would crash on exactly the input that matters.
 *
 * @returns The domains that departed.
 */
export async function flagDepartedDomains(wanted: readonly string[]): Promise<string[]> {
  const stillWanted =
    wanted.length === 0
      ? undefined
      : notInArray(blockedDomainPurges.domain, [...wanted]);

  const rows = await getDb()
    .update(blockedDomainPurges)
    .set({ inPolicy: false })
    .where(
      stillWanted
        ? and(eq(blockedDomainPurges.inPolicy, true), stillWanted)
        : eq(blockedDomainPurges.inPolicy, true)
    )
    .returning({ domain: blockedDomainPurges.domain });
  return rows.map((row) => row.domain);
}

/**
 * Claim every eligible domain still `pending` for this run.
 *
 * ONE conditional statement: the rows it returns ARE the claim. A read followed
 * by a write would let two overlapping deploys both observe `pending` and both
 * start deleting.
 *
 * @returns The domains this run now owns.
 */
export async function claimPendingDomains(
  eligible: readonly string[],
  runId: string,
  now: Date
): Promise<string[]> {
  if (eligible.length === 0) return [];
  const rows = await getDb()
    .update(blockedDomainPurges)
    .set({ state: 'in_progress', runId, claimedAt: now })
    .where(
      and(
        inArray(blockedDomainPurges.domain, [...eligible]),
        eq(blockedDomainPurges.state, 'pending')
      )
    )
    .returning({ domain: blockedDomainPurges.domain });
  return rows.map((row) => row.domain);
}

/** Mark this run's still-claimed rows failed, so the next run retries them. */
export async function failClaimedDomains(runId: string, failureReason: string): Promise<void> {
  await getDb()
    .update(blockedDomainPurges)
    .set({ state: 'failed', failureReason })
    .where(
      and(eq(blockedDomainPurges.runId, runId), eq(blockedDomainPurges.state, 'in_progress'))
    );
}

/** One domain's outcome, as the ledger records it. */
export interface PurgeOutcome {
  domain: string;
  /** Present only for a HELD row — the evidence for the breaker's refusal. */
  measured?: BlockedDomainPurgeCounts;
}

/**
 * Move the claimed rows to their finished state. ONE write.
 *
 * `held` carries what the breaker measured, which is the evidence for the state;
 * `purged` carries when it happened. The rows exist (they were claimed), so the
 * insert branch is unreachable — it is present because a batched per-domain
 * UPDATE has no other spelling, and its values are the ones the update would
 * have written anyway.
 */
export async function recordPurgeOutcomes(
  outcomes: readonly PurgeOutcome[],
  context: { state: 'purged' | 'held'; runId: string; heldReason?: string; now: Date }
): Promise<void> {
  if (outcomes.length === 0) return;
  await getDb()
    .insert(blockedDomainPurges)
    .values(
      outcomes.map((outcome) => ({
        domain: outcome.domain,
        state: context.state,
        runId: context.runId,
        firstObservedAt: context.now,
        lastObservedAt: context.now,
        ...(context.state === 'purged'
          ? { purgedAt: context.now }
          : {
              heldReason: context.heldReason ?? null,
              ...(outcome.measured ? measuredColumns(outcome.measured) : {}),
            }),
      }))
    )
    .onConflictDoUpdate({
      target: blockedDomainPurges.domain,
      set: {
        state: context.state,
        runId: context.runId,
        updatedAt: context.now,
        ...(context.state === 'purged'
          ? { purgedAt: context.now }
          : {
              heldReason: context.heldReason ?? null,
              measuredPosts: sql`excluded.measured_posts`,
              measuredActors: sql`excluded.measured_actors`,
              measuredBoosts: sql`excluded.measured_boosts`,
              measuredLikes: sql`excluded.measured_likes`,
              measuredNotifications: sql`excluded.measured_notifications`,
              measuredMediaCacheRows: sql`excluded.measured_media_cache_rows`,
              measuredLocalContentKept: sql`excluded.measured_local_content_kept`,
              measuredLocalFollowsRemoved: sql`excluded.measured_local_follows_removed`,
            }),
      },
    });
}

/** One domain's history row for one run. */
export interface PurgeRunRecord {
  domain: string;
  removed: BlockedDomainPurgeCounts;
  /**
   * The policy's public reason AS IT READ WHEN THIS RAN. It may legitimately
   * differ from the live entry — one says why the domain is blocked now, the
   * other why content was deleted then. Never re-read the current policy to
   * "repair" the divergence.
   */
  reason?: string;
  category?: string;
  corroboratingSources?: readonly string[];
}

/**
 * Append what this run removed, one row per domain. ONE write.
 *
 * Keyed on `(domain, run_id)`: a retried run UPDATES its own row. Appending
 * instead would double-count a resumed sweep in every sum-per-domain, including
 * the public transparency figure.
 */
export async function recordPurgeRun(
  records: readonly PurgeRunRecord[],
  context: { runId: string; runAt: Date; trigger: 'policy_added' | 'manual' }
): Promise<void> {
  if (records.length === 0) return;
  await getDb()
    .insert(blockedDomainPurgeRuns)
    .values(
      records.map((record) => ({
        domain: record.domain,
        runId: context.runId,
        runAt: context.runAt,
        trigger: context.trigger,
        removedPosts: record.removed.posts,
        removedActors: record.removed.actors,
        removedBoosts: record.removed.boosts,
        removedLikes: record.removed.likes,
        removedNotifications: record.removed.notifications,
        removedMediaCacheRows: record.removed.mediaCacheRows,
        removedLocalContentKept: record.removed.localContentKept,
        removedLocalFollowsRemoved: record.removed.localFollowsRemoved,
        reason: record.reason ?? null,
        category: record.category ?? null,
        corroboratingSources: record.corroboratingSources
          ? [...record.corroboratingSources]
          : null,
      }))
    )
    .onConflictDoUpdate({
      target: [blockedDomainPurgeRuns.domain, blockedDomainPurgeRuns.runId],
      set: {
        runAt: context.runAt,
        trigger: context.trigger,
        removedPosts: sql`excluded.removed_posts`,
        removedActors: sql`excluded.removed_actors`,
        removedBoosts: sql`excluded.removed_boosts`,
        removedLikes: sql`excluded.removed_likes`,
        removedNotifications: sql`excluded.removed_notifications`,
        removedMediaCacheRows: sql`excluded.removed_media_cache_rows`,
        removedLocalContentKept: sql`excluded.removed_local_content_kept`,
        removedLocalFollowsRemoved: sql`excluded.removed_local_follows_removed`,
        reason: sql`excluded.reason`,
        category: sql`excluded.category`,
        corroboratingSources: sql`excluded.corroborating_sources`,
        updatedAt: context.runAt,
      },
    });
}

/** Set a domain's state directly. The purge script's own progress stamp. */
export async function markPurgeState(
  domain: string,
  values: {
    state: BlockedDomainPurgeState;
    runId?: string | null;
    purgedAt?: Date | null;
    heldReason?: string | null;
    failureReason?: string | null;
    measured?: BlockedDomainPurgeCounts;
  }
): Promise<void> {
  const { measured, ...rest } = values;
  await getDb()
    .update(blockedDomainPurges)
    .set({ ...rest, ...(measured ? measuredColumns(measured) : {}) })
    .where(eq(blockedDomainPurges.domain, domain));
}
