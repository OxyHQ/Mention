/**
 * Federation blocklist intelligence and domain-purge bookkeeping:
 * `blocklistproposals`, `blocklistproposalruns`, `blockeddomainpurges`,
 * `blockeddomainpurgeruns`.
 *
 * ## Why these are copied rather than regenerated
 *
 * A sweep can recompute corroboration. It cannot recompute a PERSON having said
 * no. `blocklist_proposals.decision_reason` — with its author and its timestamp
 * — is the only record in the repository of why a corroborated domain is NOT
 * blocked, and it is what stops the weekly report re-litigating a decision
 * nobody asked to revisit. 751 of these rows exist in production. Losing them
 * would not merely lose data: the next sweep would re-propose every declined
 * domain, and a report that re-lists what a person already rejected is exactly
 * the rot the collection exists to prevent.
 *
 * ## The observations array is a child table because the DISAGREEMENT matters
 *
 * `suspend` and `silence` are different decisions and `noop` (listed, no action
 * taken) corroborates nothing at all. The parent's `operator_count` is derived
 * from exactly that distinction — distinct operators SUSPENDING — so flattening
 * the array, or keeping only the suspends, would destroy the evidence the count
 * was computed from and leave a reviewer unable to see the operators arguing
 * AGAINST acting.
 *
 * ## The purge state row and the purge history row are deliberately separate
 *
 * `blockeddomainpurges` is one row per domain carrying what the circuit breaker
 * last MEASURED; `blockeddomainpurgeruns` is one row per domain per run carrying
 * what a run actually REMOVED. `reason` on the history row is the policy's
 * reason AS IT READ THEN and may legitimately differ from the live policy entry.
 * Neither transform reconciles them, and a future one must not: re-reading the
 * current policy to "repair" the divergence would quietly rewrite the record of
 * why content was deleted.
 *
 * ## `measured` is absent-or-complete, and the CHECK says so
 *
 * The Mongo subdocument was `default: undefined`, so a domain never measured has
 * no counts at all rather than eight zeros — and zero is a meaningful value here
 * (a domain whose purge would remove nothing). `blocked_domain_purges_measured_check`
 * is the all-or-nothing that the subdocument gave for free, so the transform
 * emits all eight or none.
 */

import {
  blockedDomainPurgeRuns,
  blockedDomainPurges,
  blocklistProposalObservations,
  blocklistProposalRunSources,
  blocklistProposalRuns,
  blocklistProposals,
} from '../../schema/blocklist';
import type { CollectionPlan, Emit } from '../plan';
import { buildRow } from '../rowBuilder';
import {
  bool,
  childRowId,
  date,
  int,
  ownId,
  reqBool,
  reqDate,
  reqInt,
  reqStr,
  str,
  strArray,
  subdocuments,
  type MongoDocument,
} from '../values';
import { timestamps } from './timestamps';

/** `blocklistproposals` → `blocklist_proposals` + its observations. */
const blocklistProposalsPlan: CollectionPlan = {
  collection: 'blocklistproposals',
  table: blocklistProposals,
  childTables: [blocklistProposalObservations],
  enumAudits: [
    { path: 'status', column: blocklistProposals.status, absentAs: 'open' },
    // A path INTO an array of subdocuments: `distinct` returns the elements'
    // values, which is the set the CHILD table's CHECK constrains.
    { path: 'observations.severity', column: blocklistProposalObservations.severity },
  ],
  numericAudits: [
    {
      path: 'operatorCount',
      column: blocklistProposals.operatorCount,
      constraint: 'blocklist_proposals_counts_check',
      min: 0,
    },
    {
      path: 'footprint.actors',
      column: blocklistProposals.footprintActors,
      constraint: 'blocklist_proposals_counts_check',
      min: 0,
    },
    {
      path: 'footprint.posts',
      column: blocklistProposals.footprintPosts,
      constraint: 'blocklist_proposals_counts_check',
      min: 0,
    },
    {
      path: 'footprint.localUsersFollowing',
      column: blocklistProposals.footprintLocalUsersFollowing,
      constraint: 'blocklist_proposals_counts_check',
      min: 0,
    },
    {
      path: 'footprint.remoteActorsFollowed',
      column: blocklistProposals.footprintRemoteActorsFollowed,
      constraint: 'blocklist_proposals_counts_check',
      min: 0,
    },
    {
      path: 'footprint.localUsersFollowed',
      column: blocklistProposals.footprintLocalUsersFollowed,
      constraint: 'blocklist_proposals_counts_check',
      min: 0,
    },
  ],
  uniquenessAudits: [
    { index: 'blocklist_proposals_domain_key', key: [{ path: 'domain', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    const proposalId = ownId(doc);

    emit(
      blocklistProposals,
      buildRow(
        blocklistProposals,
        {
          id: proposalId,
          // Canonical already — the form the enforcement predicate compares
          // against. Re-canonicalising here would risk disagreeing with the
          // predicate on some edge the writer already settled.
          domain: reqStr(doc, 'domain'),
          status: str(doc, 'status') ?? 'open',
          // `required` in Mongo and NOT NULL here: "how long has this been
          // waiting" is the review queue's whole ordering, and an invented
          // `now()` would send every migrated proposal to the back of it.
          firstProposedAt: reqDate(doc, 'firstProposedAt'),
          lastSeenAt: reqDate(doc, 'lastSeenAt'),
          operatorCount: reqInt(doc, 'operatorCount'),
          // Stays an ARRAY, not a junction: a person transcribes this whole
          // into a policy entry's `corroboratingSources`, and it is published on
          // the transparency page as who independently reached the same
          // decision. A junction would make the thing they copy a query.
          corroboratingSources: strArray(doc, 'corroboratingSources') ?? [],

          footprintActors: reqInt(doc, 'footprint.actors'),
          footprintPosts: reqInt(doc, 'footprint.posts'),
          footprintLocalUsersFollowing: reqInt(doc, 'footprint.localUsersFollowing'),
          footprintRemoteActorsFollowed: reqInt(doc, 'footprint.remoteActorsFollowed'),
          footprintLocalUsersFollowed: reqInt(doc, 'footprint.localUsersFollowed'),

          // The three decision fields are NULLABLE together and are the reason
          // this collection is ported rather than regenerated. NULL means no
          // person has decided — a different state from any string.
          decidedAt: date(doc, 'decidedAt'),
          decidedBy: str(doc, 'decidedBy'),
          decisionReason: str(doc, 'decisionReason'),
          ...timestamps(doc),
        },
        proposalId
      )
    );

    emitObservations(doc, proposalId, emit);
  },
};

/**
 * `observations[]` → `blocklist_proposal_observations`, deduped on the INSTANCE.
 *
 * The unique key is `(proposal, instance)`: one operator speaks once per
 * sighting. Deduping keeps the emitted count equal to what the table can hold,
 * which is what the verifier compares against.
 */
function emitObservations(doc: MongoDocument, proposalId: string, emit: Emit): void {
  const seen = new Set<string>();
  let position = 0;
  for (const [observation, ordinal] of subdocuments(doc, 'observations')) {
    const instance = reqStr(observation, 'instance');
    if (seen.has(instance)) continue;
    seen.add(instance);
    emit(
      blocklistProposalObservations,
      buildRow(
        blocklistProposalObservations,
        {
          // `{ _id: false }` on the subschema, so DERIVED from the source
          // ordinal — a pure function of the document.
          id: childRowId(observation, proposalId, 'observations', ordinal),
          proposalId,
          instance,
          operator: reqStr(observation, 'operator'),
          severity: reqStr(observation, 'severity'),
          comment: str(observation, 'comment'),
          // `required: true` in Mongo, and the flag that says the domain came
          // from a DIGEST rather than a published name. A defaulted `false`
          // would claim an operator published something it masked.
          resolvedFromDigest: reqBool(observation, 'resolvedFromDigest', proposalId),
          position,
        },
        proposalId
      )
    );
    position += 1;
  }
}

/** `blocklistproposalruns` → `blocklist_proposal_runs` + its per-source rows. */
const blocklistProposalRunsPlan: CollectionPlan = {
  collection: 'blocklistproposalruns',
  table: blocklistProposalRuns,
  childTables: [blocklistProposalRunSources],
  enumAudits: [
    { path: 'trigger', column: blocklistProposalRuns.trigger },
    { path: 'sources.outcome', column: blocklistProposalRunSources.outcome },
  ],
  numericAudits: [
    {
      path: 'minOperators',
      column: blocklistProposalRuns.minOperators,
      constraint: 'blocklist_proposal_runs_counts_check',
      min: 0,
    },
    {
      path: 'counts.domainsObserved',
      column: blocklistProposalRuns.countsDomainsObserved,
      constraint: 'blocklist_proposal_runs_counts_check',
      min: 0,
    },
    {
      path: 'counts.opened',
      column: blocklistProposalRuns.countsOpened,
      constraint: 'blocklist_proposal_runs_counts_check',
      min: 0,
    },
    {
      path: 'sources.entries',
      column: blocklistProposalRunSources.entries,
      constraint: 'blocklist_proposal_run_sources_counts_check',
      min: 0,
    },
  ],
  uniquenessAudits: [
    { index: 'blocklist_proposal_runs_run_id_key', key: [{ path: 'runId', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    const runRowId = ownId(doc);

    emit(
      blocklistProposalRuns,
      buildRow(
        blocklistProposalRuns,
        {
          id: runRowId,
          runId: reqStr(doc, 'runId'),
          trigger: reqStr(doc, 'trigger'),
          startedAt: reqDate(doc, 'startedAt'),
          finishedAt: reqDate(doc, 'finishedAt'),
          minOperators: reqInt(doc, 'minOperators'),

          countsDomainsObserved: reqInt(doc, 'counts.domainsObserved'),
          countsClearedOperatorThreshold: reqInt(doc, 'counts.clearedOperatorThreshold'),
          countsOpened: reqInt(doc, 'counts.opened'),
          countsPending: reqInt(doc, 'counts.pending'),
          countsSuppressedDeclined: reqInt(doc, 'counts.suppressedDeclined'),
          countsSuppressedBlocked: reqInt(doc, 'counts.suppressedBlocked'),
          countsLapsed: reqInt(doc, 'counts.lapsed'),
          countsAdopted: reqInt(doc, 'counts.adopted'),

          // `required: true` with no default. It is the flag that says an empty
          // result meant "we could not look" rather than "there is nothing to
          // block" — the two read identically and only this distinguishes them,
          // so a defaulted `true` would turn a failed run into a clean one.
          ok: reqBool(doc, 'ok', runRowId),
          failureReason: str(doc, 'failureReason'),
          ...timestamps(doc),
        },
        runRowId
      )
    );

    const seen = new Set<string>();
    let position = 0;
    for (const [source, ordinal] of subdocuments(doc, 'sources')) {
      const instance = reqStr(source, 'instance');
      if (seen.has(instance)) continue;
      seen.add(instance);
      emit(
        blocklistProposalRunSources,
        buildRow(
          blocklistProposalRunSources,
          {
            id: childRowId(source, runRowId, 'sources', ordinal),
            runRowId,
            instance,
            operator: reqStr(source, 'operator'),
            outcome: reqStr(source, 'outcome'),
            entries: reqInt(source, 'entries'),
            detail: str(source, 'detail'),
            position,
          },
          runRowId
        )
      );
      position += 1;
    }
  },
};

/** `blockeddomainpurges` → `blocked_domain_purges`. The STATE row, one per domain. */
const blockedDomainPurgesPlan: CollectionPlan = {
  collection: 'blockeddomainpurges',
  table: blockedDomainPurges,
  enumAudits: [
    { path: 'state', column: blockedDomainPurges.state, absentAs: 'pending' },
  ],
  uniquenessAudits: [
    { index: 'blocked_domain_purges_domain_key', key: [{ path: 'domain', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    const purgeId = ownId(doc);

    // ABSENT-OR-COMPLETE, because Mongo's subdocument was `default: undefined`
    // and zero is a meaningful measurement here (a purge that would remove
    // nothing). Emitting eight zeros for a domain never measured would claim a
    // dry run that never happened, and the CHECK enforces the same all-or-
    // nothing the subdocument gave for free.
    const measuredPosts = int(doc, 'measured.posts');
    const measured =
      measuredPosts === null
        ? {}
        : {
            measuredPosts,
            measuredActors: int(doc, 'measured.actors'),
            measuredBoosts: int(doc, 'measured.boosts'),
            measuredLikes: int(doc, 'measured.likes'),
            measuredNotifications: int(doc, 'measured.notifications'),
            measuredMediaCacheRows: int(doc, 'measured.mediaCacheRows'),
            measuredLocalContentKept: int(doc, 'measured.localContentKept'),
            measuredLocalFollowsRemoved: int(doc, 'measured.localFollowsRemoved'),
          };

    emit(
      blockedDomainPurges,
      buildRow(
        blockedDomainPurges,
        {
          id: purgeId,
          domain: reqStr(doc, 'domain'),
          inPolicy: bool(doc, 'inPolicy') ?? true,
          state: str(doc, 'state') ?? 'pending',
          firstObservedAt: reqDate(doc, 'firstObservedAt'),
          lastObservedAt: reqDate(doc, 'lastObservedAt'),
          // Carried VERBATIM, expired or not — the same rule the outbox leases
          // follow. A claim is what lets a dead run's row be re-armed, and
          // clearing it here would let a second run claim a domain the first
          // may still be purging.
          claimedAt: date(doc, 'claimedAt'),
          runId: str(doc, 'runId'),
          purgedAt: date(doc, 'purgedAt'),
          // Why the circuit breaker refused. Losing it turns a deliberate HOLD
          // into an unexplained one, and the next operator has no way to tell
          // it from a failure.
          heldReason: str(doc, 'heldReason'),
          failureReason: str(doc, 'failureReason'),
          ...measured,
          ...timestamps(doc),
        },
        purgeId
      )
    );
  },
};

/** `blockeddomainpurgeruns` → `blocked_domain_purge_runs`. The HISTORY row. */
const blockedDomainPurgeRunsPlan: CollectionPlan = {
  collection: 'blockeddomainpurgeruns',
  table: blockedDomainPurgeRuns,
  enumAudits: [{ path: 'trigger', column: blockedDomainPurgeRuns.trigger }],
  numericAudits: [
    {
      path: 'removed.posts',
      column: blockedDomainPurgeRuns.removedPosts,
      constraint: 'blocked_domain_purge_runs_removed_check',
      min: 0,
    },
    {
      path: 'removed.actors',
      column: blockedDomainPurgeRuns.removedActors,
      constraint: 'blocked_domain_purge_runs_removed_check',
      min: 0,
    },
    {
      path: 'removed.localFollowsRemoved',
      column: blockedDomainPurgeRuns.removedLocalFollowsRemoved,
      constraint: 'blocked_domain_purge_runs_removed_check',
      min: 0,
    },
  ],
  uniquenessAudits: [
    {
      index: 'blocked_domain_purge_runs_domain_run_id_key',
      key: [
        { path: 'domain', normalize: 'exact' },
        { path: 'runId', normalize: 'exact' },
      ],
    },
  ],
  transform: (doc, emit) => {
    const rowId = ownId(doc);
    emit(
      blockedDomainPurgeRuns,
      buildRow(
        blockedDomainPurgeRuns,
        {
          id: rowId,
          domain: reqStr(doc, 'domain'),
          runId: reqStr(doc, 'runId'),
          runAt: reqDate(doc, 'runAt'),
          trigger: reqStr(doc, 'trigger'),

          // `required: true` on the whole subdocument, so every leaf is present.
          // Unlike `measured` above there is no absent case: a run that removed
          // nothing recorded eight zeros, which is a real measurement.
          removedPosts: reqInt(doc, 'removed.posts'),
          removedActors: reqInt(doc, 'removed.actors'),
          removedBoosts: reqInt(doc, 'removed.boosts'),
          removedLikes: reqInt(doc, 'removed.likes'),
          removedNotifications: reqInt(doc, 'removed.notifications'),
          removedMediaCacheRows: reqInt(doc, 'removed.mediaCacheRows'),
          removedLocalContentKept: reqInt(doc, 'removed.localContentKept'),
          removedLocalFollowsRemoved: reqInt(doc, 'removed.localFollowsRemoved'),

          // The policy's reason AS IT READ THEN. Copied from THIS document and
          // never re-read from the live policy — the divergence is the record.
          reason: str(doc, 'reason'),
          category: str(doc, 'category'),
          // `default: undefined` in Mongo, so absent rather than `[]` when the
          // run recorded none. NULL preserves "not recorded"; `[]` would claim
          // the run found no corroborating sources.
          corroboratingSources: strArray(doc, 'corroboratingSources'),
          ...timestamps(doc),
        },
        rowId
      )
    );
  },
};

/** Every blocklist and purge plan. */
export const BLOCKLIST_PLANS: readonly CollectionPlan[] = [
  blocklistProposalsPlan,
  blocklistProposalRunsPlan,
  blockedDomainPurgesPlan,
  blockedDomainPurgeRunsPlan,
];
