/**
 * TURN THE PUBLISHED-BLOCKLIST INTELLIGENCE INTO A REVIEW QUEUE THAT DOES NOT
 * ROT — WITHOUT EVER MAKING THE DECISION.
 *
 * ## What was rejected, and why it constrains this file
 *
 * The obvious version of this is a sync: read the blocklists other instances
 * publish, add what they block. It was considered and refused, for three
 * reasons that are all still true here:
 *   - it would make another operator's moderation silently OURS — some published
 *     lists are contested, and instances import each other's wholesale;
 *   - it would make our transparency page false. That page, live in production,
 *     says corroboration is not the decision and that we look at what we
 *     actually hold before adding anything. A page that lies is worse than none;
 *   - combined with the automatic purge, a third party editing their list would
 *     irreversibly delete OUR data with nobody in the loop.
 *
 * So the DETECTION and the PROPOSAL are automated and the DECISION is not. This
 * module writes exactly one collection — `BlocklistProposal`, a queue of notes
 * asking a person to consider an entry — and cannot block anything. That is
 * structural rather than a rule to remember: the enforced set is derived at
 * module load from `FEDERATION_BLOCK_POLICY` (a committed source file) unioned
 * with an environment variable, and neither is writable from a running process.
 * `isBlockedDomain` is READ here, to leave decisions that are already made out
 * of the queue; nothing in this file can widen it.
 *
 * ## Corroboration is counted by OPERATOR
 *
 * Two sites run by one moderation team are one decision counted twice. The first
 * production run counted instances and 116 of its 196 candidates rested entirely
 * on `mastodon.social` + `mastodon.online` — both Mastodon GmbH, publishing from
 * the same contact account. The threshold is applied to distinct operators from
 * `connectors/activitypub/blocklistSourceRegistry`, where the mapping is an
 * explicit, evidence-carrying assertion rather than anything inferred from a
 * hostname.
 *
 * And only to `suspend`. `silence` is a DIFFERENT decision (hide from public
 * timelines, keep federating) that Mention has no mechanism for, and `noop`
 * means the domain is listed with no action taken. Neither can push a domain
 * over the threshold; both are still stored and rendered, because a reviewer
 * needs to see the operators who looked and chose to do less.
 *
 * ## Only what is NEW
 *
 * A report that re-lists the same rejects every week gets ignored, and an
 * ignored report is the rot. Three things are therefore suppressed, each
 * counted so the reader can see WHY the list is short:
 *   - domains our own policy already refuses (`isBlockedDomain`);
 *   - domains a person has already declined, with their reason on the row;
 *   - nothing else. A proposal nobody has answered yet keeps appearing, with the
 *     date it was first raised, because unreviewed is not the same as reviewed.
 */

import { randomUUID } from 'node:crypto';
import { isBlockedDomain } from '../../connectors/activitypub/constants';
import {
  operatorOf,
  sourceRank,
  tallyOperators,
} from '../../connectors/activitypub/blocklistSourceRegistry';
import {
  closeOpenProposal,
  declineProposalRow,
  findProposalByDomain,
  listOpenProposalDomains,
  listOpenProposals as listOpenProposalRows,
  recordProposalRun,
  reopenProposalRow,
  statusByDomain,
  upsertOpenProposal,
  type ProposalFootprint,
  type ProposalObservation,
  type ProposalRunCounts,
  type ProposalRunSource,
  type ProposalRunTrigger,
  type StoredProposal,
} from '../../db/blocklist/blocklistProposalRepository';
import {
  reportFederationBlocklistCandidates,
  type BlockSeverity,
  type BlocklistCandidate,
  type BlocklistIntelReport,
  type SourceObservation,
} from '../../scripts/reportFederationBlocklistCandidates';
import { logger } from '../../utils/logger';

/**
 * Distinct OPERATORS that must suspend a domain before it is put to a person.
 *
 * One operator is an opinion. Two independent ones is the weakest thing worth a
 * human's attention — and it is only ever an invitation to look, never a
 * decision, which is why the floor is not set higher to compensate for the
 * automation. The reviewer sees every verdict and decides.
 */
export const MIN_CORROBORATING_OPERATORS = 2;

/** Who corroborates a domain at one severity, collapsed onto operators. */
export interface OperatorCorroboration {
  /** Distinct operator ids, sorted. The value the threshold is applied to. */
  operators: string[];
  /**
   * One instance per operator, sorted — exactly what a policy entry's
   * `corroboratingSources` takes, transcribable as-is.
   */
  sources: string[];
  /** Polled instances with no declared operator; each counted as its own. */
  unregistered: string[];
}

/**
 * Collapse one severity's observations onto the operators behind them.
 *
 * Deduped by INSTANCE first, so a source that lists the same domain twice votes
 * once, and then by operator, so a moderation team that runs two sites votes
 * once. `sources` and `operators` therefore always have the same length, and the
 * names a reviewer transcribes always match the count they were shown.
 */
export function corroboratingOperators(
  observations: readonly SourceObservation[],
  severity: BlockSeverity,
): OperatorCorroboration {
  const instances = new Set<string>();
  for (const observation of observations) {
    if (observation.severity === severity) instances.add(observation.source);
  }

  const { operators, unregistered } = tallyOperators(instances);

  // One representative instance per operator. When both of an operator's
  // instances published the block, the registry's own order picks which name
  // stands for it — a deliberate, reviewable choice rather than whichever
  // sorted first, so re-runs and policy entries stay consistent.
  const representative = new Map<string, string>();
  const ranked = [...instances].sort(
    (a, b) => sourceRank(a) - sourceRank(b) || a.localeCompare(b),
  );
  for (const instance of ranked) {
    const operator = operatorOf(instance) ?? instance;
    if (!representative.has(operator)) representative.set(operator, instance);
  }

  return { operators, sources: [...representative.values()].sort(), unregistered };
}

/** A proposal awaiting a person, in the shape the report and the CLI render. */
export interface PendingProposal {
  domain: string;
  firstProposedAt: Date;
  /** Distinct operators suspending it. */
  operatorCount: number;
  corroboratingSources: string[];
  observations: ProposalObservation[];
  footprint: ProposalFootprint;
  /** This run raised it — as opposed to a previous one nobody has answered. */
  raisedThisRun: boolean;
}

export interface BlocklistProposalSweepResult {
  runId: string;
  startedAt: Date;
  finishedAt: Date;
  trigger: ProposalRunTrigger;
  minOperators: number;
  sources: ProposalRunSource[];
  counts: ProposalRunCounts;
  /** Every proposal awaiting a person after this run, oldest first. */
  pending: PendingProposal[];
  /**
   * False when the poll could not support a verdict — fewer publishing operators
   * than the threshold needs, or the poll itself threw. NO ledger write happens
   * on such a run: an empty candidate list from a broken poll would otherwise
   * lapse every open proposal at once.
   */
  ok: boolean;
  failureReason?: string;
}

export interface BlocklistProposalSweepOptions {
  trigger: ProposalRunTrigger;
  /**
   * The intelligence poll. Injected so this module's behaviour — thresholds,
   * suppression, the ledger's state machine — is testable without the network,
   * exactly as `BlockedDomainPurgeReconciler` injects the purge it drives.
   */
  poll?: () => Promise<BlocklistIntelReport>;
}

/** The message of an unknown thrown value, without leaking a stack into a field. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The default poll: every registered source, at the operator threshold. */
function pollPublishedBlocklists(): Promise<BlocklistIntelReport> {
  // `minSources` counts INSTANCES and is the weaker gate, so it can only ever
  // discard domains that would also have failed the operator threshold below —
  // a domain's operator count can never exceed its source count. It is worth
  // passing because it spares the report's per-candidate footprint queries.
  return reportFederationBlocklistCandidates({ minSources: MIN_CORROBORATING_OPERATORS });
}

/** Flatten one candidate's per-source verdicts onto the row, unmerged. */
function toStoredObservations(
  candidate: BlocklistCandidate,
): ProposalObservation[] {
  return candidate.observations.map((observation) => ({
    instance: observation.source,
    operator: operatorOf(observation.source) ?? observation.source,
    severity: observation.severity,
    comment: observation.comment,
    resolvedFromDigest: observation.resolvedFromDigest,
  }));
}

function toStoredFootprint(candidate: BlocklistCandidate): ProposalFootprint {
  return {
    actors: candidate.footprint.actors,
    posts: candidate.footprint.posts,
    localUsersFollowing: candidate.footprint.localUsersFollowing,
    remoteActorsFollowed: candidate.footprint.remoteActorsFollowed,
    localUsersFollowed: candidate.footprint.localUsersFollowed,
  };
}

/** A candidate that cleared the operator threshold, with its corroboration. */
interface ClearedCandidate {
  candidate: BlocklistCandidate;
  suspend: OperatorCorroboration;
}

/**
 * Raise or refresh one proposal, unless a person has already declined it.
 *
 * The `status <> 'declined'` guard is the repository's, and it is stated on the
 * write itself rather than checked beforehand: a decline landing between the
 * classification read and this write must not be undone by it. Its refusal is a
 * VERDICT — `declinedFirst` — which the sweep counts as a suppression, not an
 * error.
 */
function raiseProposal(
  cleared: ClearedCandidate,
  now: Date,
): Promise<{ raised: boolean; declinedFirst: boolean }> {
  const { candidate, suspend } = cleared;
  return upsertOpenProposal({
    domain: candidate.domain,
    now,
    operatorCount: suspend.operators.length,
    corroboratingSources: suspend.sources,
    observations: toStoredObservations(candidate),
    footprint: toStoredFootprint(candidate),
  });
}

/**
 * Poll the published blocklists, reconcile the review queue, and report what a
 * person still has to look at.
 *
 * Writes `BlocklistProposal` and `BlocklistProposalRun` and nothing else. The
 * run row is written whatever happens — a sweep that found nothing writes no
 * proposal, and without the run row that is indistinguishable from a sweep that
 * silently stopped happening.
 */
export async function runBlocklistProposalSweep(
  options: BlocklistProposalSweepOptions,
): Promise<BlocklistProposalSweepResult> {
  const runId = randomUUID();
  const startedAt = new Date();
  const poll = options.poll ?? pollPublishedBlocklists;

  let report: BlocklistIntelReport | null = null;
  let failureReason: string | undefined;
  try {
    report = await poll();
  } catch (error) {
    failureReason = `poll failed: ${describeError(error)}`;
  }

  const sources: ProposalRunSource[] = (report?.sources ?? []).map((source) => ({
    instance: source.source,
    operator: operatorOf(source.source) ?? source.source,
    outcome: source.outcome,
    entries: source.entries.length,
    detail: source.detail,
  }));

  // The threshold is on OPERATORS, so the "could this run reach a verdict at
  // all?" question is too: five instances of two operators can never corroborate
  // a third. Fewer publishing operators than the threshold makes an empty result
  // read exactly like "there is nothing to block", which is the one outcome that
  // must never pass as a clean run.
  const publishingOperators = tallyOperators(
    sources.filter((source) => source.outcome === 'published').map((source) => source.instance),
  ).operators.length;

  if (report && publishingOperators < MIN_CORROBORATING_OPERATORS) {
    failureReason = `only ${publishingOperators} operator(s) published; ${MIN_CORROBORATING_OPERATORS} needed`;
  }

  const ok = failureReason === undefined;

  const counts: ProposalRunCounts = {
    domainsObserved: report?.domainsObserved ?? 0,
    clearedOperatorThreshold: 0,
    opened: 0,
    pending: 0,
    suppressedDeclined: 0,
    suppressedBlocked: 0,
    lapsed: 0,
    adopted: 0,
  };

  let pending: PendingProposal[] = [];

  if (ok && report) {
    const cleared: ClearedCandidate[] = [];
    const unregistered = new Set<string>();
    for (const candidate of report.candidates) {
      const suspend = corroboratingOperators(candidate.observations, 'suspend');
      for (const instance of suspend.unregistered) unregistered.add(instance);
      if (suspend.operators.length < MIN_CORROBORATING_OPERATORS) continue;
      cleared.push({ candidate, suspend });
    }
    counts.clearedOperatorThreshold = cleared.length;

    // Impossible by construction on this path — the poll takes its sources from
    // the registry — so if it ever happens, a count here rests on an assumption
    // nobody made (an unregistered instance is counted as its own operator) and
    // that must be visible rather than inferred from a docstring. Once per run,
    // not once per domain.
    if (unregistered.size > 0) {
      logger.warn('[blocklistProposals] corroboration from instances with no declared operator', {
        instances: [...unregistered].sort(),
      });
    }

    const knownStatus = await statusByDomain(cleared.map((entry) => entry.candidate.domain));

    const raisedThisRun = new Set<string>();
    const proposable = new Set<string>();

    for (const entry of cleared) {
      const { domain } = entry.candidate;

      // A decision already made is not a review to spend. Both suppressions are
      // COUNTED rather than listed, so a short list is legible as "we decided"
      // rather than "nothing was found".
      if (entry.candidate.blockedLocally) {
        counts.suppressedBlocked += 1;
        continue;
      }
      if (knownStatus.get(domain) === 'declined') {
        counts.suppressedDeclined += 1;
        continue;
      }

      const { raised, declinedFirst } = await raiseProposal(entry, startedAt);
      if (declinedFirst) {
        counts.suppressedDeclined += 1;
        continue;
      }
      proposable.add(domain);
      if (raised) {
        raisedThisRun.add(domain);
        counts.opened += 1;
      }
    }

    // Every open row this run did NOT re-confirm has stopped being a live
    // question: either we blocked it (the review succeeded) or the corroboration
    // behind it went away. `declined` rows are not read here at all — a person's
    // decision is never moved by the sweep.
    const openDomains = await listOpenProposalDomains();
    for (const domain of openDomains) {
      if (proposable.has(domain)) continue;
      const status = isBlockedDomain(domain) ? 'adopted' : 'lapsed';
      await closeOpenProposal(domain, status);
      if (status === 'adopted') counts.adopted += 1;
      else counts.lapsed += 1;
    }

    const stillOpen = await listOpenProposalRows();
    counts.pending = stillOpen.length;
    pending = stillOpen.map((row) => toPendingProposal(row, raisedThisRun.has(row.domain)));
  }

  const finishedAt = new Date();
  await recordProposalRun({
    runId,
    trigger: options.trigger,
    startedAt,
    finishedAt,
    minOperators: MIN_CORROBORATING_OPERATORS,
    sources,
    counts,
    ok,
    failureReason,
  });

  return {
    runId,
    startedAt,
    finishedAt,
    trigger: options.trigger,
    minOperators: MIN_CORROBORATING_OPERATORS,
    sources,
    counts,
    pending,
    ok,
    failureReason,
  };
}

/** A stored row in the shape the report and the CLI render. */
function toPendingProposal(row: StoredProposal, raisedThisRun: boolean): PendingProposal {
  return {
    domain: row.domain,
    firstProposedAt: row.firstProposedAt,
    operatorCount: row.operatorCount,
    corroboratingSources: row.corroboratingSources,
    observations: row.observations,
    footprint: row.footprint,
    raisedThisRun,
  };
}

/** Every proposal awaiting a person, oldest first. */
export async function listOpenProposals(): Promise<PendingProposal[]> {
  const rows = await listOpenProposalRows();
  return rows.map((row) => toPendingProposal(row, false));
}

export interface DeclineProposalInput {
  domain: string;
  /** Who decided. Required: an audit record with no author is worth little. */
  decidedBy: string;
  /** Why we do NOT block a domain other operators do. The record's whole point. */
  reason: string;
}

/**
 * Record that a person looked at a proposal and said no.
 *
 * The domain is never proposed again — that suppression is what keeps the weekly
 * report worth reading. Only `open` and `lapsed` rows can be declined: an
 * `adopted` one is already blocked, so there is nothing to decline, and a
 * second decline would overwrite the first author and reason.
 */
export async function declineProposal(input: DeclineProposalInput): Promise<StoredProposal> {
  const domain = input.domain.trim().toLowerCase();
  const decidedBy = input.decidedBy.trim();
  const reason = input.reason.trim();

  if (decidedBy.length === 0) throw new Error('a decline must name who decided');
  if (reason.length === 0) throw new Error('a decline must state why');

  const row = await findProposalByDomain(domain);
  if (!row) throw new Error(`no proposal for ${domain}`);
  if (row.status === 'declined') {
    throw new Error(`${domain} was already declined by ${row.decidedBy ?? 'someone'}`);
  }
  if (row.status === 'adopted') {
    throw new Error(`${domain} is already refused by the committed policy`);
  }

  const declined = await declineProposalRow(domain, decidedBy, reason);

  if (!declined) throw new Error(`${domain} changed state during the decline; re-read it`);

  logger.info('[blocklistProposals] proposal declined', {
    domain,
    decidedBy,
    operatorCount: declined.operatorCount,
  });
  return declined;
}

/**
 * Put a declined proposal back in the queue.
 *
 * The counterpart to a decline being permanent: a decision made on thin evidence
 * can be revisited deliberately, by a person, rather than by the sweep quietly
 * re-raising it. The next sweep either re-confirms it or lapses it.
 */
export async function reopenProposal(domain: string, reopenedBy: string): Promise<StoredProposal> {
  const canonical = domain.trim().toLowerCase();
  const by = reopenedBy.trim();
  if (by.length === 0) throw new Error('a reopen must name who did it');

  const reopened = await reopenProposalRow(canonical);

  if (!reopened) throw new Error(`no declined proposal for ${canonical}`);

  logger.info('[blocklistProposals] proposal reopened', { domain: canonical, reopenedBy: by });
  return reopened;
}

/** Whole days between two instants, for "waiting since" in the report. */
function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

/**
 * Proposals rendered into the scheduled report.
 *
 * The LEDGER holds every one; this bounds only what a single run writes to the
 * log. The first sweep after this ships inherits a backlog — the production
 * intelligence run behind the current policy cleared nearly two hundred
 * candidates — and a run that emits a thousand log lines is a run nobody reads,
 * which is the same failure as not reporting at all. The tail is named, with
 * where to read it.
 */
const REPORT_QUEUE_LIMIT = 25;

/** `suspend`, `silence` and `noop` in the order a reviewer weighs them. */
const SEVERITY_ORDER: readonly BlockSeverity[] = ['suspend', 'silence', 'noop'];

/** What each severity means for the decision, said once per rendered block. */
const SEVERITY_NOTE: Readonly<Record<BlockSeverity, string>> = {
  suspend: 'corroborates',
  silence: 'a lesser decision — does not corroborate a suspend',
  noop: 'listed, no action taken — corroborates nothing',
};

/**
 * Render the queue as lines a reviewer can act on without re-deriving anything.
 *
 * Lines, not one blob: the backend logger caps a single string field, so a
 * fifty-row report in one field is silently truncated exactly where the tail of
 * the queue lives. Each line is logged as its own record.
 *
 * Deliberately verbose per proposal rather than a wide table. The output has one
 * job — letting somebody write a policy entry and its public reason — and that
 * needs the corroborating instances BY NAME, what each of them published, and
 * what we hold from the domain. A table wide enough for all three is unreadable;
 * a table narrow enough to read omits the part that does the work.
 */
export function renderProposalQueue(
  pending: readonly PendingProposal[],
  asOf: Date,
  limit: number = Number.MAX_SAFE_INTEGER,
): string[] {
  const lines: string[] = [];
  const shown = pending.slice(0, Math.max(0, limit));

  for (const proposal of shown) {
    lines.push(
      `${proposal.raisedThisRun ? 'NEW  ' : '     '}${proposal.domain}`
      + `  ${proposal.operatorCount} operators`
      + `  waiting ${daysBetween(proposal.firstProposedAt, asOf)}d`,
    );

    for (const severity of SEVERITY_ORDER) {
      const observations = proposal.observations.filter((o) => o.severity === severity);
      if (observations.length === 0) continue;
      lines.push(`       ${severity} (${SEVERITY_NOTE[severity]}):`);
      for (const observation of observations) {
        const masked = observation.resolvedFromDigest ? ' (masked, recovered from digest)' : '';
        const comment = observation.comment ? ` "${observation.comment}"` : '';
        lines.push(`         ${observation.instance} [${observation.operator}]${masked}${comment}`);
      }
    }

    const { footprint } = proposal;
    lines.push(
      `       we hold: ${footprint.posts} posts, ${footprint.actors} actors;`
      + ` ${footprint.localUsersFollowing} local users follow ${footprint.remoteActorsFollowed} accounts there;`
      + ` ${footprint.localUsersFollowed} local users would lose a follower`,
    );
    lines.push(
      `       corroboratingSources: [${proposal.corroboratingSources.map((s) => `'${s}'`).join(', ')}]`,
    );
  }

  if (pending.length > shown.length) {
    lines.push(
      `     … ${pending.length - shown.length} further proposals not shown here —`
      + ' run `reviewFederationBlocklistProposals` to read the whole queue',
    );
  }

  return lines;
}

/** One sweep, as the scheduler logs it: what the poll saw, then the queue. */
export function renderProposalReport(result: BlocklistProposalSweepResult): string[] {
  const published = result.sources.filter((source) => source.outcome === 'published').length;
  const failed = result.sources.filter((source) => source.outcome === 'failed').length;
  const lines = [
    `polled ${result.sources.length} instances: ${published} published, ${failed} failed`
    + ` — threshold ${result.minOperators} distinct operators, suspend only`,
  ];

  if (!result.ok) {
    lines.push(`RUN NOT USABLE: ${result.failureReason ?? 'unknown'} — the queue was left untouched`);
    return lines;
  }

  lines.push(
    `${result.counts.clearedOperatorThreshold} domains cleared the threshold;`
    + ` ${result.counts.suppressedBlocked} already refused by our policy,`
    + ` ${result.counts.suppressedDeclined} already declined by a person,`
    + ` ${result.counts.lapsed} lapsed, ${result.counts.adopted} adopted`,
  );

  if (result.pending.length === 0) {
    lines.push('nothing awaits review');
    return lines;
  }

  lines.push(
    `${result.pending.length} awaiting review (${result.counts.opened} raised by this run):`,
  );
  lines.push(...renderProposalQueue(result.pending, result.finishedAt, REPORT_QUEUE_LIMIT));
  return lines;
}
