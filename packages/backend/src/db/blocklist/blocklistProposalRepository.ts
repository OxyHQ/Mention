/**
 * `blocklist_proposals` (+ its observations child) and `blocklist_proposal_runs`
 * (+ its sources child).
 *
 * ## Nothing here can block anything
 *
 * A proposal row is a note asking a PERSON to consider writing a policy entry.
 * The enforced set is `connectors/activitypub/federationBlockPolicy` — a
 * committed source file — unioned with an environment variable, and neither is
 * writable from a running process. Porting these reads must not create a path
 * that changes that: no function here is read by any enforcement predicate.
 *
 * ## Two child tables, and why they are not `jsonb`
 *
 * `observations` and `sources` were subdocument arrays. As tables they are
 * REPLACED wholesale on each write, in the parent's transaction — a proposal's
 * observations are what the sources said AT THE LAST SIGHTING, so merging them
 * with an older sighting would be a different fact. `position` preserves the
 * order the poller produced, which is the order a reviewer reads.
 *
 * ## `status <> 'declined'` is the load-bearing predicate
 *
 * A person's decision is never moved by the sweep. Mongo expressed that as
 * `{status: {$ne: 'declined'}}` on the upsert's filter, so a decline landing
 * between the classification read and the write could not be undone by it — and
 * the duplicate-key error that followed WAS the signal that a person decided
 * first. Postgres says it directly: the row is locked for the duration
 * (`for update`), and the `on conflict do update ... where` refuses the write
 * outright. A refused write is a DECLINE HELD, not an error, so it returns a
 * verdict rather than throwing.
 */

import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { getDb, type Transaction } from '../postgres';
import {
  BLOCKLIST_SOURCE_OUTCOMES,
  blocklistProposalObservations,
  blocklistProposalRuns,
  blocklistProposalRunSources,
  blocklistProposals,
} from '../schema/blocklist';

/** One source's own published verdict at the last sighting. */
export interface ProposalObservation {
  instance: string;
  operator: string;
  severity: 'suspend' | 'silence' | 'noop';
  comment?: string;
  resolvedFromDigest: boolean;
}

/** What blocking a domain would cost us, as the reviewer is shown it. */
export interface ProposalFootprint {
  actors: number;
  posts: number;
  localUsersFollowing: number;
  remoteActorsFollowed: number;
  localUsersFollowed: number;
}

/** A proposal row plus its observations, in the shape the report renders. */
export interface StoredProposal {
  domain: string;
  status: 'open' | 'declined' | 'adopted' | 'lapsed';
  firstProposedAt: Date;
  operatorCount: number;
  corroboratingSources: string[];
  observations: ProposalObservation[];
  footprint: ProposalFootprint;
  decidedAt: Date | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

/** What one raise/refresh of a proposal writes. */
export interface UpsertProposalInput {
  domain: string;
  now: Date;
  operatorCount: number;
  corroboratingSources: string[];
  observations: ProposalObservation[];
  footprint: ProposalFootprint;
}

/**
 * The outcome of {@link upsertOpenProposal}.
 *
 * `declinedFirst` is a VERDICT and not an error: a person deciding while the
 * sweep runs is the mechanism working, and the sweep counts it as a suppression.
 */
export interface UpsertProposalResult {
  /** The row entered `open` from something else, or from nothing. */
  raised: boolean;
  /** A person had already declined it; the write was refused. */
  declinedFirst: boolean;
}

/** Assemble a row plus its ordered observations into the read shape. */
function toStoredProposal(
  row: typeof blocklistProposals.$inferSelect,
  observations: readonly (typeof blocklistProposalObservations.$inferSelect)[]
): StoredProposal {
  return {
    domain: row.domain,
    status: row.status,
    firstProposedAt: row.firstProposedAt,
    operatorCount: row.operatorCount,
    corroboratingSources: row.corroboratingSources,
    observations: observations.map((observation) => ({
      instance: observation.instance,
      operator: observation.operator,
      severity: observation.severity,
      // The Mongo field was OPTIONAL, so a missing comment must stay missing
      // rather than becoming an empty string a renderer would print as `""`.
      ...(observation.comment === null ? {} : { comment: observation.comment }),
      resolvedFromDigest: observation.resolvedFromDigest,
    })),
    footprint: {
      actors: row.footprintActors,
      posts: row.footprintPosts,
      localUsersFollowing: row.footprintLocalUsersFollowing,
      remoteActorsFollowed: row.footprintRemoteActorsFollowed,
      localUsersFollowed: row.footprintLocalUsersFollowed,
    },
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    decisionReason: row.decisionReason,
  };
}

/** Replace one proposal's observations with the current sighting's, in order. */
async function replaceObservations(
  tx: Transaction,
  proposalId: string,
  observations: readonly ProposalObservation[]
): Promise<void> {
  await tx
    .delete(blocklistProposalObservations)
    .where(eq(blocklistProposalObservations.proposalId, proposalId));
  if (observations.length === 0) return;
  await tx.insert(blocklistProposalObservations).values(
    observations.map((observation, position) => ({
      proposalId,
      instance: observation.instance,
      operator: observation.operator,
      severity: observation.severity,
      comment: observation.comment ?? null,
      resolvedFromDigest: observation.resolvedFromDigest,
      position,
    }))
  );
}

/**
 * Raise or refresh one proposal, unless a person has declined it.
 *
 * One transaction. The existing row is locked FIRST (`for update`), so a decline
 * cannot interleave between reading its status and writing over it; the
 * `on conflict do update … where status <> 'declined'` is the second guard, and
 * covers the case where no row existed to lock and one appeared.
 */
export async function upsertOpenProposal(
  input: UpsertProposalInput
): Promise<UpsertProposalResult> {
  return getDb().transaction(async (tx) => {
    const [before] = await tx
      .select({ status: blocklistProposals.status })
      .from(blocklistProposals)
      .where(eq(blocklistProposals.domain, input.domain))
      .for('update');

    if (before?.status === 'declined') {
      return { raised: false, declinedFirst: true };
    }

    const refreshed = {
      status: 'open' as const,
      lastSeenAt: input.now,
      operatorCount: input.operatorCount,
      corroboratingSources: input.corroboratingSources,
      footprintActors: input.footprint.actors,
      footprintPosts: input.footprint.posts,
      footprintLocalUsersFollowing: input.footprint.localUsersFollowing,
      footprintRemoteActorsFollowed: input.footprint.remoteActorsFollowed,
      footprintLocalUsersFollowed: input.footprint.localUsersFollowed,
      updatedAt: input.now,
    };

    const [row] = await tx
      .insert(blocklistProposals)
      .values({
        domain: input.domain,
        // Never overwritten on a refresh — it is how long a reviewer has been
        // asked, and resetting it would hide a proposal ageing in the queue.
        firstProposedAt: input.now,
        ...refreshed,
      })
      .onConflictDoUpdate({
        target: blocklistProposals.domain,
        set: refreshed,
        setWhere: ne(blocklistProposals.status, 'declined'),
      })
      .returning({ id: blocklistProposals.id });

    if (!row) {
      return { raised: false, declinedFirst: true };
    }

    await replaceObservations(tx, row.id, input.observations);

    return { raised: before === undefined || before.status !== 'open', declinedFirst: false };
  });
}

/** The current status of each named domain that has a proposal row. */
export async function statusByDomain(
  domains: readonly string[]
): Promise<Map<string, StoredProposal['status']>> {
  if (domains.length === 0) return new Map();
  const rows = await getDb()
    .select({ domain: blocklistProposals.domain, status: blocklistProposals.status })
    .from(blocklistProposals)
    .where(inArray(blocklistProposals.domain, [...domains]));
  return new Map(rows.map((row) => [row.domain, row.status]));
}

/** Every domain currently awaiting a person, oldest question first. */
export async function listOpenProposalDomains(): Promise<string[]> {
  const rows = await getDb()
    .select({ domain: blocklistProposals.domain })
    .from(blocklistProposals)
    .where(eq(blocklistProposals.status, 'open'))
    .orderBy(asc(blocklistProposals.firstProposedAt));
  return rows.map((row) => row.domain);
}

/**
 * Move an `open` proposal to `adopted` or `lapsed`.
 *
 * Conditional on it still being `open`, so a decline that landed in between is
 * not overwritten — the sweep never moves a person's decision.
 */
export async function closeOpenProposal(
  domain: string,
  status: 'adopted' | 'lapsed'
): Promise<void> {
  await getDb()
    .update(blocklistProposals)
    .set({ status })
    .where(and(eq(blocklistProposals.domain, domain), eq(blocklistProposals.status, 'open')));
}

/** Every proposal awaiting a person, with its observations, oldest first. */
export async function listOpenProposals(): Promise<StoredProposal[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(blocklistProposals)
    .where(eq(blocklistProposals.status, 'open'))
    .orderBy(asc(blocklistProposals.firstProposedAt));
  if (rows.length === 0) return [];

  const observations = await db
    .select()
    .from(blocklistProposalObservations)
    .where(
      inArray(
        blocklistProposalObservations.proposalId,
        rows.map((row) => row.id)
      )
    )
    .orderBy(asc(blocklistProposalObservations.position));

  const byProposal = new Map<string, (typeof observations)[number][]>();
  for (const observation of observations) {
    const bucket = byProposal.get(observation.proposalId);
    if (bucket) bucket.push(observation);
    else byProposal.set(observation.proposalId, [observation]);
  }

  return rows.map((row) => toStoredProposal(row, byProposal.get(row.id) ?? []));
}

/** One proposal by domain, with its observations. */
export async function findProposalByDomain(domain: string): Promise<StoredProposal | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(blocklistProposals)
    .where(eq(blocklistProposals.domain, domain))
    .limit(1);
  if (!row) return null;

  const observations = await db
    .select()
    .from(blocklistProposalObservations)
    .where(eq(blocklistProposalObservations.proposalId, row.id))
    .orderBy(asc(blocklistProposalObservations.position));
  return toStoredProposal(row, observations);
}

/**
 * Record that a person said no, if the row is still `open` or `lapsed`.
 *
 * @returns The declined proposal, or `null` when it changed state in between —
 *   which the caller reports as "re-read it" rather than forcing the write.
 */
export async function declineProposalRow(
  domain: string,
  decidedBy: string,
  reason: string
): Promise<StoredProposal | null> {
  const [row] = await getDb()
    .update(blocklistProposals)
    .set({
      status: 'declined',
      decidedAt: new Date(),
      decidedBy,
      decisionReason: reason,
    })
    .where(
      and(
        eq(blocklistProposals.domain, domain),
        inArray(blocklistProposals.status, ['open', 'lapsed'])
      )
    )
    .returning();
  if (!row) return null;
  return findProposalByDomain(row.domain);
}

/**
 * Put a declined proposal back in the queue.
 *
 * The three decision fields are set back to NULL rather than left in place:
 * Mongo `$unset` them, and a row reading `open` while still naming who declined
 * it would describe two decisions at once.
 */
export async function reopenProposalRow(domain: string): Promise<StoredProposal | null> {
  const [row] = await getDb()
    .update(blocklistProposals)
    .set({ status: 'open', decidedAt: null, decidedBy: null, decisionReason: null })
    .where(
      and(eq(blocklistProposals.domain, domain), eq(blocklistProposals.status, 'declined'))
    )
    .returning();
  if (!row) return null;
  return findProposalByDomain(row.domain);
}

/**
 * One source's contribution to one run.
 *
 * `outcome` is typed FROM the schema tuple rather than restated, and the sweep
 * assigns the poller's own `SourceOutcome` into it — so a value the poller can
 * produce and the CHECK constraint does not accept fails to compile at the call
 * site. That guard is the one `models/BlocklistProposalRun.ts` carried
 * (`satisfies Record<SourceOutcome, SourceOutcome>`), kept rather than lost with
 * the model: without it this column was constrained to a vocabulary nothing
 * produces and nobody noticed.
 */
export interface ProposalRunSource {
  instance: string;
  operator: string;
  outcome: (typeof BLOCKLIST_SOURCE_OUTCOMES)[number];
  entries: number;
  detail?: string;
}

/** What the run did, in the terms a reader would ask about. */
export interface ProposalRunCounts {
  /** Domains named by at least one source at a corroborating severity. */
  domainsObserved: number;
  /** Domains that cleared the DISTINCT-OPERATOR suspend threshold. */
  clearedOperatorThreshold: number;
  /** Proposals this run opened for the first time. */
  opened: number;
  /** Open proposals after the run — including ones still waiting from before. */
  pending: number;
  /** Cleared the threshold but a person had already declined them. */
  suppressedDeclined: number;
  /** Cleared the threshold but our own policy already refuses them. */
  suppressedBlocked: number;
  /** Open proposals whose corroboration no longer holds. */
  lapsed: number;
  /** Open proposals whose domain our policy now refuses. */
  adopted: number;
}

/** Who asked for a sweep: the leader-gated schedule, or a person. */
export type ProposalRunTrigger = 'scheduled' | 'manual';

/** What one sweep did. */
export interface ProposalRunInput {
  runId: string;
  trigger: ProposalRunTrigger;
  startedAt: Date;
  finishedAt: Date;
  minOperators: number;
  sources: readonly ProposalRunSource[];
  counts: ProposalRunCounts;
  ok: boolean;
  failureReason?: string;
}

/**
 * Append one run, with what each source answered.
 *
 * The run row is written whatever the sweep found — a sweep that found nothing
 * writes no proposal, and without this row that is indistinguishable from a
 * sweep that silently stopped happening.
 */
export async function recordProposalRun(input: ProposalRunInput): Promise<void> {
  await getDb().transaction(async (tx) => {
    const [run] = await tx
      .insert(blocklistProposalRuns)
      .values({
        runId: input.runId,
        trigger: input.trigger,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        minOperators: input.minOperators,
        countsDomainsObserved: input.counts.domainsObserved,
        countsClearedOperatorThreshold: input.counts.clearedOperatorThreshold,
        countsOpened: input.counts.opened,
        countsPending: input.counts.pending,
        countsSuppressedDeclined: input.counts.suppressedDeclined,
        countsSuppressedBlocked: input.counts.suppressedBlocked,
        countsLapsed: input.counts.lapsed,
        countsAdopted: input.counts.adopted,
        ok: input.ok,
        failureReason: input.failureReason ?? null,
      })
      .returning({ id: blocklistProposalRuns.id });

    if (input.sources.length === 0) return;
    await tx.insert(blocklistProposalRunSources).values(
      input.sources.map((source, position) => ({
        runRowId: run.id,
        instance: source.instance,
        operator: source.operator,
        outcome: source.outcome,
        entries: source.entries,
        detail: source.detail ?? null,
        position,
      }))
    );
  });
}

/**
 * When the most recent sweep STARTED, or `null` when none has.
 *
 * `null` means "no sweep has ever been recorded", which the scheduler reads as
 * DUE — the direction that costs a redundant poll rather than one that silently
 * stops sweeping.
 */
export async function latestProposalRunStartedAt(): Promise<Date | null> {
  const [row] = await getDb()
    .select({ startedAt: blocklistProposalRuns.startedAt })
    .from(blocklistProposalRuns)
    .orderBy(desc(blocklistProposalRuns.startedAt))
    .limit(1);
  return row?.startedAt ?? null;
}

/** Total proposal rows, whatever their status. Diagnostics only. */
export async function countProposals(): Promise<number> {
  const [row] = await getDb()
    .select({ total: sql<number>`count(*)::int` })
    .from(blocklistProposals);
  return row?.total ?? 0;
}
