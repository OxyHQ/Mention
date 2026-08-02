/**
 * Federation blocklist intelligence and domain-purge bookkeeping:
 * `blocklist_proposals`, `blocklist_proposal_runs`, `blocked_domain_purges`,
 * `blocked_domain_purge_runs`.
 *
 * ## None of this is a blocklist
 *
 * Nothing here decides what Mention federates with. The blocklist is
 * `connectors/activitypub/federationBlockPolicy` — a committed source file with
 * a diff, an author and a review — plus the `FEDERATION_BLOCKED_DOMAINS`
 * emergency lever. A `blocklist_proposals` row is a note asking a PERSON to
 * consider writing one of those entries, and no runtime path may perform that
 * write. Porting these tables must not create one: there is deliberately no
 * column here that any enforcement predicate reads.
 *
 * ## `blocklist_proposals.decision_reason` is the record of a NEGATIVE decision
 *
 * It is the only place in the repository that records why a corroborated domain
 * is NOT blocked, and it is what stops the weekly report re-litigating a
 * decision nobody asked to revisit. 751 of these rows exist in production —
 * hand-made moderation decisions with an author and a reason, which is why they
 * are ported rather than regenerated: a sweep can recompute corroboration, and
 * cannot recompute a person having said no.
 *
 * ## The state row and the history row are deliberately separate
 *
 * `blocked_domain_purges` is ONE ROW PER DOMAIN and carries what the circuit
 * breaker last measured; `blocked_domain_purge_runs` is one row per domain per
 * run and carries what a run actually removed. A domain blocked twice keeps
 * both results, and `blocked_domain_purge_runs.reason` is the policy's reason AS
 * IT READ THEN — it may legitimately diverge from the current policy entry, and
 * "repairing" that divergence by re-reading the live policy would quietly
 * rewrite history.
 *
 * ## The two count subdocuments are the same shape and stay flattened
 *
 * `BlockedDomainPurgeCounts` appears on both tables (`measured` on the state
 * row, `removed` on the history row). Every leaf is a plain integer with a known
 * name, so both flatten into columns rather than `jsonb`: a `jsonb` here would
 * make "how much did we remove from this domain" unanswerable by SQL, which is
 * exactly the question the transparency surface asks.
 */

import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from './columns';

/** `BlocklistProposalStatus`. */
export const BLOCKLIST_PROPOSAL_STATUSES = ['open', 'declined', 'adopted', 'lapsed'] as const;

/** `BlockSeverity` — Mastodon's published severities, kept UNMERGED per source. */
export const PUBLISHED_BLOCK_SEVERITIES = ['suspend', 'silence', 'noop'] as const;

/** `BlocklistProposalRunTrigger`. */
export const BLOCKLIST_PROPOSAL_RUN_TRIGGERS = ['scheduled', 'manual'] as const;

/** `SourceOutcome` — what one source contributed to one run. */
export const BLOCKLIST_SOURCE_OUTCOMES = [
  'published',
  'unavailable',
  'unparseable',
  'empty',
] as const;

/** `BlockedDomainPurgeState`. */
export const BLOCKED_DOMAIN_PURGE_STATES = [
  'pending',
  'in_progress',
  'purged',
  'held',
  'failed',
] as const;

/** `BlockedDomainPurgeTrigger`. */
export const BLOCKED_DOMAIN_PURGE_TRIGGERS = ['policy_added', 'manual'] as const;

/**
 * `blocklist_proposals` — one row per domain the intelligence has proposed, and
 * what a person decided about it.
 */
export const blocklistProposals = pgTable(
  'blocklist_proposals',
  {
    id: generatedId(),
    /** Canonical domain, in the form the enforcement predicate compares against. */
    domain: text().notNull(),
    status: text({ enum: BLOCKLIST_PROPOSAL_STATUSES }).notNull().default('open'),
    /** When this domain first cleared the operator threshold. Never overwritten. */
    firstProposedAt: timestamptz().notNull(),
    /** The last sweep that still saw it corroborated. */
    lastSeenAt: timestamptz().notNull(),
    /** Distinct operators SUSPENDING it at the last sighting. */
    operatorCount: integer().notNull(),
    /**
     * One instance per suspending operator, sorted — exactly what a policy
     * entry's `corroboratingSources` takes, and published on the transparency
     * page. It stays a `text[]` because it is transcribed WHOLE into a source
     * file by a person; a junction would make the thing they copy a query.
     */
    corroboratingSources: text().array().notNull(),

    // ── footprint: what blocking this domain would cost US ──
    footprintActors: integer().notNull(),
    footprintPosts: integer().notNull(),
    footprintLocalUsersFollowing: integer().notNull(),
    footprintRemoteActorsFollowed: integer().notNull(),
    footprintLocalUsersFollowed: integer().notNull(),

    /** When a person decided. Set with `declined`, cleared on reopen. */
    decidedAt: timestamptz(),
    /** Who decided — an audit record with no author is weak. */
    decidedBy: text(),
    /** WHY. The only record of why a corroborated domain is NOT blocked. */
    decisionReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'blocklist_proposals_status_check',
      sql`${t.status} in (${sql.raw(inList(BLOCKLIST_PROPOSAL_STATUSES))})`
    ),
    check(
      'blocklist_proposals_counts_check',
      sql`${t.operatorCount} >= 0
        and ${t.footprintActors} >= 0
        and ${t.footprintPosts} >= 0
        and ${t.footprintLocalUsersFollowing} >= 0
        and ${t.footprintRemoteActorsFollowed} >= 0
        and ${t.footprintLocalUsersFollowed} >= 0`
    ),
    uniqueIndex('blocklist_proposals_domain_key').on(t.domain),
    // The review queue, oldest first: a proposal nobody has answered for months
    // is the one worth seeing at the top.
    index('blocklist_proposals_status_chrono_idx').on(t.status, t.firstProposedAt),
  ]
);

/**
 * `blocklist_proposal_observations` — one source's own verdict, kept UNMERGED.
 *
 * A child table rather than `jsonb` because the whole point is that a reviewer
 * sees what each operator actually said, INCLUDING the ones arguing against
 * acting: `suspend` and `silence` are different decisions and `noop` (listed, no
 * action) corroborates nothing. Flattening them would destroy the distinction
 * the parent's `operator_count` is computed from.
 */
export const blocklistProposalObservations = pgTable(
  'blocklist_proposal_observations',
  {
    id: generatedId(),
    proposalId: text()
      .notNull()
      .references(() => blocklistProposals.id, { onDelete: 'cascade' }),
    /** The instance that published it. */
    instance: text().notNull(),
    /** Who operates that instance, per the source registry. */
    operator: text().notNull(),
    severity: text({ enum: PUBLISHED_BLOCK_SEVERITIES }).notNull(),
    /** The reason that operator published, bounded and control-stripped upstream. */
    comment: text(),
    /** The instance published this block MASKED; the domain came from its digest. */
    resolvedFromDigest: boolean().notNull(),
    position: integer().notNull(),
  },
  (t) => [
    check(
      'blocklist_proposal_observations_severity_check',
      sql`${t.severity} in (${sql.raw(inList(PUBLISHED_BLOCK_SEVERITIES))})`
    ),
    check('blocklist_proposal_observations_position_check', sql`${t.position} >= 0`),
    // One verdict per (proposal, instance): an operator speaks once per sighting.
    uniqueIndex('blocklist_proposal_observations_proposal_id_instance_key').on(
      t.proposalId,
      t.instance
    ),
    index('blocklist_proposal_observations_proposal_idx').on(t.proposalId, t.position),
  ]
);

/** `blocklist_proposal_runs` — what one sweep did, in the terms a reader asks about. */
export const blocklistProposalRuns = pgTable(
  'blocklist_proposal_runs',
  {
    id: generatedId(),
    /** Unique per run, so a row cannot be recorded twice. */
    runId: text().notNull(),
    trigger: text({ enum: BLOCKLIST_PROPOSAL_RUN_TRIGGERS }).notNull(),
    startedAt: timestamptz().notNull(),
    finishedAt: timestamptz().notNull(),
    /** Distinct operators required before a domain is proposed. */
    minOperators: integer().notNull(),

    // ── counts ──
    countsDomainsObserved: integer().notNull(),
    countsClearedOperatorThreshold: integer().notNull(),
    countsOpened: integer().notNull(),
    countsPending: integer().notNull(),
    /** Counted rather than listed, so decisions are not re-litigated weekly. */
    countsSuppressedDeclined: integer().notNull(),
    countsSuppressedBlocked: integer().notNull(),
    countsLapsed: integer().notNull(),
    countsAdopted: integer().notNull(),

    /**
     * False when the run could not produce a trustworthy list — fewer sources
     * published than the threshold needs, so no domain COULD clear it and an
     * empty result reads exactly like "there is nothing to block".
     */
    ok: boolean().notNull(),
    failureReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'blocklist_proposal_runs_trigger_check',
      sql`${t.trigger} in (${sql.raw(inList(BLOCKLIST_PROPOSAL_RUN_TRIGGERS))})`
    ),
    check(
      'blocklist_proposal_runs_counts_check',
      sql`${t.minOperators} >= 0
        and ${t.countsDomainsObserved} >= 0
        and ${t.countsClearedOperatorThreshold} >= 0
        and ${t.countsOpened} >= 0
        and ${t.countsPending} >= 0
        and ${t.countsSuppressedDeclined} >= 0
        and ${t.countsSuppressedBlocked} >= 0
        and ${t.countsLapsed} >= 0
        and ${t.countsAdopted} >= 0`
    ),
    uniqueIndex('blocklist_proposal_runs_run_id_key').on(t.runId),
    // The scheduler's only query: when did the last sweep start?
    index('blocklist_proposal_runs_started_at_idx').on(t.startedAt.desc()),
  ]
);

/** `blocklist_proposal_run_sources` — what each source contributed to one run. */
export const blocklistProposalRunSources = pgTable(
  'blocklist_proposal_run_sources',
  {
    id: generatedId(),
    runRowId: text()
      .notNull()
      .references(() => blocklistProposalRuns.id, { onDelete: 'cascade' }),
    instance: text().notNull(),
    operator: text().notNull(),
    outcome: text({ enum: BLOCKLIST_SOURCE_OUTCOMES }).notNull(),
    entries: integer().notNull(),
    detail: text(),
    position: integer().notNull(),
  },
  (t) => [
    check(
      'blocklist_proposal_run_sources_outcome_check',
      sql`${t.outcome} in (${sql.raw(inList(BLOCKLIST_SOURCE_OUTCOMES))})`
    ),
    check(
      'blocklist_proposal_run_sources_counts_check',
      sql`${t.entries} >= 0 and ${t.position} >= 0`
    ),
    uniqueIndex('blocklist_proposal_run_sources_run_row_id_instance_key').on(
      t.runRowId,
      t.instance
    ),
  ]
);

/**
 * `blocked_domain_purges` — ONE ROW PER DOMAIN: the current purge state, and
 * what the circuit breaker last measured.
 */
export const blockedDomainPurges = pgTable(
  'blocked_domain_purges',
  {
    id: generatedId(),
    /** Canonical domain: lowercase, no trailing dot, no `www.` prefix. */
    domain: text().notNull(),
    /** Whether the domain was in the policy at the last reconciliation. */
    inPolicy: boolean().notNull().default(true),
    state: text({ enum: BLOCKED_DOMAIN_PURGE_STATES }).notNull().default('pending'),
    firstObservedAt: timestamptz().notNull(),
    lastObservedAt: timestamptz().notNull(),
    /** Set when a run claims the row, so a dead run's claim can be re-armed. */
    claimedAt: timestamptz(),
    /** The run that claimed or completed this row — the audit join key. */
    runId: text(),
    purgedAt: timestamptz(),
    /** Why the circuit breaker refused, when `state` is `held`. */
    heldReason: text(),
    /** The error a `failed` attempt reported. */
    failureReason: text(),

    // ── what the DRY RUN predicted; NULL when never measured ──
    measuredPosts: integer(),
    measuredActors: integer(),
    measuredBoosts: integer(),
    measuredLikes: integer(),
    measuredNotifications: integer(),
    measuredMediaCacheRows: integer(),
    measuredLocalContentKept: integer(),
    measuredLocalFollowsRemoved: integer(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'blocked_domain_purges_state_check',
      sql`${t.state} in (${sql.raw(inList(BLOCKED_DOMAIN_PURGE_STATES))})`
    ),
    // Every measured count is nullable and non-negative when present. The
    // subdocument was absent-or-complete in Mongo (`default: undefined`), and
    // that all-or-nothing is what the second clause preserves.
    check(
      'blocked_domain_purges_measured_check',
      sql`(${t.measuredPosts} is null
          and ${t.measuredActors} is null
          and ${t.measuredBoosts} is null
          and ${t.measuredLikes} is null
          and ${t.measuredNotifications} is null
          and ${t.measuredMediaCacheRows} is null
          and ${t.measuredLocalContentKept} is null
          and ${t.measuredLocalFollowsRemoved} is null)
        or (${t.measuredPosts} >= 0
          and ${t.measuredActors} >= 0
          and ${t.measuredBoosts} >= 0
          and ${t.measuredLikes} >= 0
          and ${t.measuredNotifications} >= 0
          and ${t.measuredMediaCacheRows} >= 0
          and ${t.measuredLocalContentKept} >= 0
          and ${t.measuredLocalFollowsRemoved} >= 0)`
    ),
    // The reconciler's whole cheapness rests on this: one indexed lookup per
    // policy domain instead of re-measuring every domain ever blocked.
    uniqueIndex('blocked_domain_purges_domain_key').on(t.domain),
    // The claim/re-arm sweep reads by state.
    index('blocked_domain_purges_state_claimed_idx').on(t.state, t.claimedAt),
  ]
);

/**
 * `blocked_domain_purge_runs` — one row per domain per run: what a run actually
 * REMOVED, and the policy's reason as it read at the time.
 */
export const blockedDomainPurgeRuns = pgTable(
  'blocked_domain_purge_runs',
  {
    id: generatedId(),
    domain: text().notNull(),
    /** Groups every domain swept by the same run. */
    runId: text().notNull(),
    runAt: timestamptz().notNull(),
    trigger: text({ enum: BLOCKED_DOMAIN_PURGE_TRIGGERS }).notNull(),

    // ── what this run REMOVED ──
    removedPosts: integer().notNull(),
    removedActors: integer().notNull(),
    removedBoosts: integer().notNull(),
    removedLikes: integer().notNull(),
    removedNotifications: integer().notNull(),
    removedMediaCacheRows: integer().notNull(),
    removedLocalContentKept: integer().notNull(),
    removedLocalFollowsRemoved: integer().notNull(),

    /**
     * The policy's public reason AS IT READ WHEN THIS RAN. It may legitimately
     * differ from the live policy entry — one says why the domain is blocked
     * now, the other why content was deleted then. Never "repair" the
     * divergence by re-reading the current entry.
     */
    reason: text(),
    /** No CHECK: the category vocabulary belongs to `@mention/shared-types`. */
    category: text(),
    /** Instances that had independently published the same decision. */
    corroboratingSources: text().array(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      'blocked_domain_purge_runs_trigger_check',
      sql`${t.trigger} in (${sql.raw(inList(BLOCKED_DOMAIN_PURGE_TRIGGERS))})`
    ),
    check(
      'blocked_domain_purge_runs_removed_check',
      sql`${t.removedPosts} >= 0
        and ${t.removedActors} >= 0
        and ${t.removedBoosts} >= 0
        and ${t.removedLikes} >= 0
        and ${t.removedNotifications} >= 0
        and ${t.removedMediaCacheRows} >= 0
        and ${t.removedLocalContentKept} >= 0
        and ${t.removedLocalFollowsRemoved} >= 0`
    ),
    // One row per domain per run: a retried or resumed run updates its row
    // rather than appending, so it cannot inflate a sum-per-domain.
    uniqueIndex('blocked_domain_purge_runs_domain_run_id_key').on(t.domain, t.runId),
    // The latest run for a domain, and every run for a domain to sum.
    index('blocked_domain_purge_runs_domain_chrono_idx').on(t.domain, t.runAt.desc()),
  ]
);
