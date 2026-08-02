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
 * ## The backlog is not a delta
 *
 * The first time this ledger is ever built, every domain already in the policy
 * is recorded as `baseline` and is NOT purged automatically. "Everything blocked
 * so far" is precisely the batch an unattended run should never take on itself —
 * it is reviewed and run by a person, once. Only domains added AFTER the ledger
 * exists are deltas, and only deltas are automatic.
 *
 * The baseline is "the first policy CONTENT this ledger ever saw", not "the
 * first time this function ran": a policy that is empty records nothing, so the
 * first real domain to appear is still the first thing seen and is baselined
 * rather than swept. That is deliberately conservative — the failure direction
 * of an automatic deleter must always be to delete less.
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
import BlockedDomainPurge, {
  toLedgerCounts,
  type BlockedDomainPurgeCounts,
  type IBlockedDomainPurge,
} from '../../models/BlockedDomainPurge';
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
   * The canonical domains in the committed policy file, as its own parser
   * produced them. This module never reads the file: the policy's shape belongs
   * to whoever owns it, and passing the result in keeps exactly one parser in
   * the repo.
   */
  policyDomains: readonly string[];
  runPurge: PurgeRunner;
  now?: () => Date;
}

export interface ReconcileBlockedDomainPurgesResult {
  runId: string;
  /** Recorded as the pre-existing backlog; never purged automatically. */
  baselined: string[];
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
 * sweep. Everything else — a first-ever backlog, a domain that departed, one
 * already purged — is recorded and excluded here rather than being filtered
 * later, so the eligibility rule lives in exactly one place.
 */
async function observePolicy(
  policyDomains: readonly string[],
  now: Date,
): Promise<{ eligible: string[]; baselined: string[]; departed: string[] }> {
  const wanted = [...new Set(policyDomains)].sort();
  const isFirstEverReconciliation = (await BlockedDomainPurge.estimatedDocumentCount()) === 0;

  const baselined: string[] = [];
  const eligible: string[] = [];

  for (const domain of wanted) {
    const existing = await BlockedDomainPurge.findOne({ domain }).lean<IBlockedDomainPurge | null>();

    if (!existing) {
      const state = isFirstEverReconciliation ? 'baseline' : 'pending';
      await BlockedDomainPurge.updateOne(
        { domain },
        {
          $set: { inPolicy: true, state, lastObservedAt: now },
          $setOnInsert: { firstObservedAt: now },
        },
        { upsert: true },
      );
      if (state === 'baseline') baselined.push(domain);
      else eligible.push(domain);
      continue;
    }

    // Re-added after having been removed: content can have arrived while it was
    // allowed, so this is newly blocked again, not already handled.
    const reAdded = existing.inPolicy === false;
    const retryable = existing.state === 'pending' || existing.state === 'failed';
    const nextState = reAdded || retryable ? 'pending' : existing.state;

    await BlockedDomainPurge.updateOne(
      { domain },
      { $set: { inPolicy: true, state: nextState, lastObservedAt: now } },
    );
    if (nextState === 'pending') eligible.push(domain);
  }

  // Departed domains: flagged, never undone. There is no restore path in this
  // system and this line is not one — it only records that the policy changed.
  const departedRows = await BlockedDomainPurge.find(
    { inPolicy: true, domain: { $nin: wanted } },
    { domain: 1 },
  ).lean<Array<{ domain: string }>>();
  const departed = departedRows.map((row) => row.domain);
  if (departed.length > 0) {
    await BlockedDomainPurge.updateMany(
      { domain: { $in: departed } },
      { $set: { inPolicy: false } },
    );
  }

  return { eligible, baselined, departed };
}

/** Re-arm claims from a run that never reported back. */
async function reArmStaleClaims(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS);
  const result = await BlockedDomainPurge.updateMany(
    { state: 'in_progress', claimedAt: { $lt: cutoff } },
    { $set: { state: 'pending' }, $unset: { claimedAt: '', runId: '' } },
  );
  if (result.modifiedCount > 0) {
    logger.warn('[BlockedDomainPurge] re-armed claims from a run that did not report back', {
      count: result.modifiedCount,
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
    baselined: [],
    purged: [],
    held: [],
    failed: [],
    departed: [],
    breaches: [],
    removed: null,
  };

  await reArmStaleClaims(now);

  const { eligible, baselined, departed } = await observePolicy(input.policyDomains, now);
  result.baselined = baselined;
  result.departed = departed;

  if (baselined.length > 0) {
    logger.warn(
      '[BlockedDomainPurge] recorded a pre-existing blocklist as the baseline; '
      + 'its content is NOT purged automatically and needs a reviewed run',
      { count: baselined.length },
    );
  }
  if (eligible.length === 0) {
    logger.info('[BlockedDomainPurge] policy reconciled; no newly blocked domain to purge');
    return result;
  }

  // Claim atomically, so two overlapping deploys split the work instead of both
  // sweeping the same domains.
  await BlockedDomainPurge.updateMany(
    { domain: { $in: eligible }, state: 'pending' },
    { $set: { state: 'in_progress', runId, claimedAt: now } },
  );
  const claimedRows = await BlockedDomainPurge.find(
    { runId, state: 'in_progress' },
    { domain: 1 },
  ).lean<Array<{ domain: string }>>();
  const claimed = claimedRows.map((row) => row.domain);
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
      await recordOutcome(claimed, preview, {
        state: 'held',
        runId,
        heldReason,
        now,
      });
      result.held = claimed;
      return result;
    }

    const removed = await input.runPurge(domains, { dryRun: false, resetCursor: false });
    await recordOutcome(claimed, removed, { state: 'purged', runId, now });
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
    await BlockedDomainPurge.updateMany(
      { runId, state: 'in_progress' },
      {
        $set: {
          state: 'failed',
          failureReason: error instanceof Error ? error.message : String(error),
        },
      },
    );
    result.failed = claimed;
    return result;
  }
}

/** Write the per-domain audit record for a finished (or refused) run. */
async function recordOutcome(
  domains: readonly string[],
  report: PurgeReport,
  context: { state: 'purged' | 'held'; runId: string; heldReason?: string; now: Date },
): Promise<void> {
  for (const domain of domains) {
    const counts = report.byDomain.get(domain);
    const ledgerCounts = counts ? toLedgerCounts(counts) : null;
    const update: Record<string, unknown> = {
      state: context.state,
      runId: context.runId,
    };
    if (context.state === 'purged') {
      update.purgedAt = context.now;
      if (ledgerCounts) update.removed = ledgerCounts;
    } else {
      update.heldReason = context.heldReason;
      if (ledgerCounts) update.measured = ledgerCounts;
    }
    await BlockedDomainPurge.updateOne({ domain }, { $set: update });
  }
}
