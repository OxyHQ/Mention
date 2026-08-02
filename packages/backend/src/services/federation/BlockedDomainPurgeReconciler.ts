/**
 * Reconcile the blocklist POLICY against what has actually been purged, and
 * purge the difference — so blocking a domain is ONE action with a complete
 * effect rather than a config change plus a cleanup somebody has to remember.
 *
 * A cleanup that must be launched by hand is a cleanup that gets skipped, and
 * the blocklist quietly becomes half-true: nothing new gets in, while everything
 * that arrived before is still served.
 *
 * ## Where this runs, and why there
 *
 * In the DEPLOY ONE-SHOT (`scripts/migrate.ts` → `runMigrationTask`), after the
 * schema migrations, in the same process. Three properties make that the right
 * slot and the alternatives wrong:
 *
 *  - It runs ONCE per deploy, on the exact image being rolled out. A startup
 *    reconciliation on every web task would run N times on a scale-out — N
 *    concurrent destructive sweeps triggered by an autoscaling event rather than
 *    by anyone changing the policy — and would hold up readiness while it swept.
 *  - The policy file is a COMMITTED file, so it can only change via a deploy.
 *    Reconciling on deploy means the cleanup happens exactly when the thing it
 *    reconciles against changes; a scheduled job would instead leave a window
 *    where the domain is blocked but its content is still served, and would fire
 *    at a time nobody associates with the change.
 *  - A deploy one-shot already has the ceremony this deserves: a reviewed diff,
 *    an author, and a deployment record to correlate against.
 *
 * ## Run twice, or die half way
 *
 * Both are safe, and neither is left to luck:
 *  - Every domain is a row with a state. A row only leaves `pending` by being
 *    claimed with a run id, and only reaches `purged` when that run finished, so
 *    a second concurrent run claims nothing and does nothing.
 *  - A run that dies leaves rows `in_progress`. The next reconciliation re-arms
 *    any claim older than {@link STALE_CLAIM_MS} and redoes it. The purge itself
 *    is idempotent and cursor-resumable, so redoing it is cheap and cannot
 *    double-delete.
 *  - The purge's own resume cursors are namespaced by the domain SET, so a batch
 *    that changes between attempts starts cleanly instead of inheriting a
 *    cursor parked at the end of a previous sweep.
 *
 * ## Removing a domain from the policy does NOT undo anything
 *
 * Deletion is one-way. A domain that leaves the policy has its row marked
 * `inPolicy: false` and nothing else happens — no restore exists, here or
 * anywhere. The flag is kept for the opposite case: a domain REMOVED and later
 * RE-ADDED is treated as newly blocked again, because content can have arrived
 * during the window when it was allowed, and that content must be purged on the
 * second block exactly as it was on the first.
 *
 * ## The first batch goes through the ordinary path, like every other
 *
 * There is deliberately NO special case for the first reconciliation. An earlier
 * version recorded the pre-existing policy as a `baseline` and skipped it, on
 * the reasoning that "everything blocked so far" is too big a batch to take on
 * unattended. That was the wrong mechanism for a real risk: the risk is a large
 * or mistaken deletion, and the circuit breaker already guards exactly that —
 * but it MEASURES first and then either proceeds or HOLDS with the numbers on
 * the record, whereas the baseline decided blindly, permanently, and for the one
 * batch that actually had content accumulated behind it.
 *
 * Two mechanisms guarding one risk, and the weaker one suppressing the outcome
 * the system exists to produce. So the baseline is gone and the breaker decides.
 * A first batch that looks ordinary is purged; one that does not is `held` —
 * which is what `baseline` was reaching for, except `held` carries the measured
 * blast radius and the ceiling that refused it, and a human resolves it.
 *
 * ## The env var is deliberately not a trigger
 *
 * `FEDERATION_BLOCKED_DOMAINS` remains an additive emergency lever for STOPPING
 * new content immediately, and it is not read here. A committed policy file has
 * a diff, an author and a review; an environment variable can be changed by one
 * person in a console with none of those. Unattended irreversible deletion is
 * only ever driven by the reviewed artefact.
 */

import { randomUUID } from 'node:crypto';
import {
  claimPendingDomains,
  failClaimedDomains,
  findPurgeRows,
  flagDepartedDomains,
  observePolicyDomains,
  reArmStaleClaims as reArmStaleClaimRows,
  recordPurgeOutcomes,
  recordPurgeRun,
  toLedgerCounts,
  type BlockedDomainPurgeCounts,
  type BlockedDomainPurgeState,
  type PolicyObservation,
  type PurgeOutcome,
  type PurgeRunRecord,
} from '../../db/blocklist/blockedDomainPurgeRepository';
import type { FederationBlockPolicyEntry } from '../../connectors/activitypub/federationBlockPolicy';
import { logger } from '../../utils/logger';
import {
  describeBreaches,
  evaluatePurgeCeilings,
  type PurgeCeilingBreach,
  type PurgeMeasurement,
} from './blockedDomainPurgeCeilings';
import type {
  PurgeOptions,
  PurgeReport,
} from '../../scripts/purgeBlockedDomainContent';

/**
 * How long a claim may sit before another run may take it back.
 *
 * Comfortably longer than a full sweep of the corpus so a slow-but-alive run is
 * never stolen from, and short enough that a task killed mid-deploy is retried
 * on the next one rather than blocking the domain forever.
 */
const STALE_CLAIM_MS = 60 * 60 * 1_000;

/** The purge entry point, injected so this is testable without a real sweep. */
export type PurgeRunner = (
  domains: ReadonlySet<string>,
  options: PurgeOptions,
) => Promise<PurgeReport>;

export interface ReconcileBlockedDomainPurgesInput {
  /**
   * The committed policy entries, as `getBlockedDomainPolicy()` produced them
   * (already canonicalised). This module never reads or parses the policy file:
   * passing the parser's output in keeps exactly one reader of it in the repo.
   *
   * `since` on these entries is IGNORED for deciding what is new. It is a date
   * the author declares rather than a commit timestamp — it can be backdated,
   * and correcting a typo in it is an ordinary edit that must not re-trigger a
   * deletion. Newness comes from diffing the domain set against the ledger.
   * `reason`, `category` and `corroboratingSources` ARE used: they are copied
   * onto the audit record so the published justification and the record of what
   * was deleted for it are the same words.
   */
  policyEntries: readonly FederationBlockPolicyEntry[];
  runPurge: PurgeRunner;
  now?: () => Date;
}

export interface ReconcileBlockedDomainPurgesResult {
  runId: string;
  /** Newly blocked and swept by this run. */
  purged: string[];
  /** Refused by the circuit breaker; awaiting a human. */
  held: string[];
  /** Attempted and errored; retried next reconciliation. */
  failed: string[];
  /** Left the policy since the last run. Nothing was undone for them. */
  departed: string[];
  breaches: PurgeCeilingBreach[];
  removed: BlockedDomainPurgeCounts | null;
}

/** Build the breaker's input from a dry-run report. */
export function toMeasurement(report: PurgeReport): PurgeMeasurement {
  const perDomain = new Map<string, {
    posts: number;
    actors: number;
    localFollows: number;
    localContent: number;
  }>();
  for (const [domain, counts] of report.byDomain) {
    perDomain.set(domain, {
      posts: counts.posts + counts.orphanPosts,
      actors: counts.actors,
      localFollows: counts.localFollowsRemoved,
      localContent:
        counts.repliesByOthersKept + counts.quotesByOthersKept + counts.threadRootsKept,
    });
  }
  return {
    corpus: report.corpus,
    total: {
      posts: report.totals.posts + report.totals.orphanPosts,
      actors: report.totals.actors,
    },
    perDomain,
  };
}

/**
 * Record what the policy currently says, WITHOUT purging anything.
 *
 * Returns the domains that are newly blocked and eligible for an automatic
 * sweep. Everything else — a domain that departed, one already purged, one the
 * breaker is holding — is recorded and excluded here rather than being filtered
 * later, so the eligibility rule lives in exactly one place.
 */
async function observePolicy(
  policyEntries: readonly FederationBlockPolicyEntry[],
  now: Date,
): Promise<{ eligible: string[]; departed: string[] }> {
  const wanted = [...new Set(policyEntries.map((entry) => entry.domain))].sort();
  const eligible: string[] = [];
  if (wanted.length === 0) return { eligible, departed: await flagDeparted(wanted) };

  // ONE read and ONE write for the whole policy, rather than a findOne plus an
  // updateOne per domain. Measured before this change: 2.0ms per domain, dead
  // linear from 118 to 944 domains — fine at today's size, but it is round-trip
  // count and it runs on EVERY deploy, so it grows with the blocklist forever.
  // Constant-round-trip is not an optimisation here so much as removing a reason
  // for the policy to ever be kept small.
  const existingRows = await findPurgeRows(wanted);
  const existingByDomain = new Map(existingRows.map((row) => [row.domain, row]));

  const observations: PolicyObservation[] = wanted.map((domain) => {
    const existing = existingByDomain.get(domain);

    // Never seen: eligible whether it is the first domain ever or the
    // thousandth. Whether sweeping it is SAFE is the circuit breaker's question,
    // answered from a measurement rather than from a row count.
    // Re-added after removal: content can have arrived while it was allowed, so
    // this is a fresh block.
    const reAdded = existing?.inPolicy === false;
    const retryable = existing?.state === 'pending' || existing?.state === 'failed';
    const nextState: BlockedDomainPurgeState =
      !existing || reAdded || retryable ? 'pending' : existing.state;
    if (nextState === 'pending') eligible.push(domain);

    return { domain, state: nextState };
  });

  await observePolicyDomains(observations, now);

  return { eligible, departed: await flagDeparted(wanted) };
}

/**
 * Record that a domain has left the policy. Flagged, never undone: there is no
 * restore path in this system and this is not one. The flag exists so a domain
 * REMOVED and later RE-ADDED is recognised as newly blocked again.
 */
function flagDeparted(wanted: readonly string[]): Promise<string[]> {
  // ONE conditional statement whose affected rows are the answer, rather than a
  // read followed by a write over the ids it found.
  return flagDepartedDomains(wanted);
}

/** Re-arm claims from a run that never reported back. */
async function reArmStaleClaims(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const reArmed = await reArmStaleClaimRows(cutoff);
  if (reArmed > 0) {
    logger.warn('[BlockedDomainPurge] re-armed claims from a run that did not report back', {
      count: reArmed,
    });
  }
}

/**
 * Reconcile the policy and purge what is newly blocked.
 *
 * Never throws for a purge failure: this runs inside the deploy one-shot, and a
 * cleanup problem must not block shipping. The failure is recorded on the row
 * and logged at error level, and the content simply stays until the next
 * reconciliation — failing to delete is the safe direction.
 */
export async function reconcileBlockedDomainPurges(
  input: ReconcileBlockedDomainPurgesInput,
): Promise<ReconcileBlockedDomainPurgesResult> {
  const now = input.now?.() ?? new Date();
  const runId = randomUUID();
  const result: ReconcileBlockedDomainPurgesResult = {
    runId,
    purged: [],
    held: [],
    failed: [],
    departed: [],
    breaches: [],
    removed: null,
  };

  await reArmStaleClaims(now);

  const { eligible, departed } = await observePolicy(input.policyEntries, now);
  result.departed = departed;

  if (eligible.length === 0) {
    logger.info('[BlockedDomainPurge] policy reconciled; no newly blocked domain to purge');
    return result;
  }

  // Claim atomically, so two overlapping deploys split the work instead of both
  // sweeping the same domains.
  const claimed = await claimPendingDomains(eligible, runId, now);
  if (claimed.length === 0) {
    logger.info('[BlockedDomainPurge] another run claimed the newly blocked domains');
    return result;
  }

  const domains = new Set(claimed);
  logger.info('[BlockedDomainPurge] newly blocked domains claimed for purge', {
    runId,
    count: claimed.length,
  });

  try {
    // MEASURE FIRST. The circuit breaker decides on real numbers from a run that
    // is provably read-only, never on an estimate.
    const preview = await input.runPurge(domains, {
      dryRun: true,
      resetCursor: false,
    });
    const measurement = toMeasurement(preview);
    const breaches = evaluatePurgeCeilings(measurement);
    result.breaches = breaches;

    if (breaches.length > 0) {
      const heldReason = describeBreaches(breaches);
      // Logged at ERROR: an automatic cleanup that refused is the one outcome
      // that needs a person, and it must not read as routine.
      logger.error('[BlockedDomainPurge] circuit breaker refused an automatic purge', {
        runId,
        domains: claimed.length,
        heldReason,
      });
      await recordOutcome(claimed, preview, input.policyEntries, {
        state: 'held',
        runId,
        heldReason,
        now,
      });
      result.held = claimed;
      return result;
    }

    const removed = await input.runPurge(domains, { dryRun: false, resetCursor: false });
    await recordOutcome(claimed, removed, input.policyEntries, { state: 'purged', runId, now });
    result.purged = claimed;
    result.removed = toLedgerCounts(removed.totals);
    logger.info('[BlockedDomainPurge] automatic purge complete', {
      runId,
      domains: claimed.length,
      removed: result.removed,
    });
    return result;
  } catch (error) {
    logger.error('[BlockedDomainPurge] automatic purge failed; content left in place', {
      runId,
      error,
    });
    await failClaimedDomains(runId, error instanceof Error ? error.message : String(error));
    result.failed = claimed;
    return result;
  }
}

/**
 * Write the audit record for a finished (or refused) run.
 *
 * Two records, deliberately: the LEDGER row moves to its new state (and, when
 * refused, keeps what the breaker measured as the evidence for that state),
 * while an append-only RUN row records what was actually removed. A domain can
 * be blocked, purged, unblocked and blocked again — storing the counts only on
 * the state row would overwrite the first purge's result with the second and
 * make any total for that domain quietly wrong.
 *
 * The run row copies the policy's `reason`, `category` and
 * `corroboratingSources` as they read AT THIS MOMENT. The published wording can
 * later change, or the entry can be removed entirely, and the record of an
 * irreversible deletion has to keep saying what it was done for.
 */
async function recordOutcome(
  domains: readonly string[],
  report: PurgeReport,
  policyEntries: readonly FederationBlockPolicyEntry[],
  context: { state: 'purged' | 'held'; runId: string; heldReason?: string; now: Date },
): Promise<void> {
  if (domains.length === 0) return;
  const entryByDomain = new Map(policyEntries.map((entry) => [entry.domain, entry]));

  // Batched for the same reason the policy read is: this runs on every deploy
  // and the count is the size of the blocklist, so a per-domain round trip makes
  // the deploy slower every time a domain is added.
  const outcomes: PurgeOutcome[] = [];
  const history: PurgeRunRecord[] = [];

  for (const domain of domains) {
    const counts = report.byDomain.get(domain);
    const ledgerCounts = counts ? toLedgerCounts(counts) : null;
    outcomes.push({
      domain,
      // Only a HELD row records what the breaker measured — it is the evidence
      // for the refusal. A purged row's numbers belong on the history, where a
      // second block of the same domain cannot overwrite the first.
      ...(context.state === 'held' && ledgerCounts ? { measured: ledgerCounts } : {}),
    });

    // A refused batch removed nothing, so it has no history to append.
    if (context.state !== 'purged' || !ledgerCounts) continue;
    const entry = entryByDomain.get(domain);
    history.push({
      domain,
      removed: ledgerCounts,
      reason: entry?.reason,
      category: entry?.category,
      corroboratingSources: entry ? [...entry.corroboratingSources] : undefined,
    });
  }

  await recordPurgeOutcomes(outcomes, context);
  await recordPurgeRun(history, {
    runId: context.runId,
    runAt: context.now,
    trigger: 'policy_added',
  });
}
