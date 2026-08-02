import { readFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BlockSeverity,
  BlocklistCandidate,
  BlocklistIntelReport,
  SourceObservation,
  SourcePollResult,
} from '../../../scripts/reportFederationBlocklistCandidates';

/**
 * The scheduled half of the blocklist loop: detect and PROPOSE, never decide.
 *
 * Against a real database, because every property here is a property of the
 * LEDGER — whether a domain a person already answered comes back, whether an
 * unanswered proposal survives, what a run that could not reach a verdict leaves
 * behind. A mocked model cannot fail for any of those.
 *
 * That database is now Postgres. It was `mongodb-memory-server`; the queue moved
 * to `blocklist_proposals` + `blocklist_proposal_observations` and the history to
 * `blocklist_proposal_runs` + `blocklist_proposal_run_sources`.
 *
 * **This file owns those four tables for the duration of a run.** Its cleanup is
 * unscoped, because one case asserts the behaviour when there is NO run history
 * at all — which is a claim about the whole table, not about this file's rows.
 * Vitest runs files in parallel against one database, so a second file writing a
 * proposal or a run would make this one flake. Nothing else does today; if
 * something starts, both files need scoping and this case needs rethinking.
 *
 * The intelligence POLL is injected. Its own behaviour (parsing, digests,
 * timeouts, the SSRF-safe transport) is covered by
 * `reportFederationBlocklistCandidates.test.ts`; this file is about the decision
 * layer on top of it, and must not need a network to exercise a threshold.
 */

/** Stands in for the enforced set. Never written by anything under test. */
const h = vi.hoisted(() => ({ blocked: new Set<string>(), federationEnabled: true }));

vi.mock('../../../connectors/activitypub/constants', () => ({
  isBlockedDomain: (domain: string) => h.blocked.has(domain),
  // A getter, so a test can turn federation off and see the scheduler decline
  // to start — the flag is read when `start()` runs, not when this file loads.
  get FEDERATION_ENABLED() {
    return h.federationEnabled;
  },
}));

const { closePostgres, connectPostgres, getDb } = await import('../../../db/postgres');
const { blocklistProposalRuns, blocklistProposals } = await import('../../../db/schema/blocklist');
const { recordProposalRun, upsertOpenProposal } = await import(
  '../../../db/blocklist/blocklistProposalRepository'
);
const { FEDERATION_BLOCK_POLICY } = await import(
  '../../../connectors/activitypub/federationBlockPolicy'
);
const {
  MIN_CORROBORATING_OPERATORS,
  corroboratingOperators,
  declineProposal,
  listOpenProposals,
  renderProposalQueue,
  renderProposalReport,
  reopenProposal,
  runBlocklistProposalSweep,
} = await import('../../../services/federation/BlocklistProposalService');
const { BLOCKLIST_PROPOSAL_INTERVAL_MS, BlocklistProposalScheduler } = await import(
  '../../../services/federation/BlocklistProposalScheduler'
);

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterAll(async () => {
  const db = getDb();
  await db.delete(blocklistProposals);
  await db.delete(blocklistProposalRuns);
  await closePostgres();
});

beforeEach(async () => {
  // Observations and run sources go with their parents by ON DELETE CASCADE.
  const db = getDb();
  await db.delete(blocklistProposals);
  await db.delete(blocklistProposalRuns);
  h.blocked.clear();
  h.federationEnabled = true;
});

/** One proposal row, or `undefined`. Child rows are read through the service. */
async function proposalRow(domain: string) {
  const [row] = await getDb()
    .select()
    .from(blocklistProposals)
    .where(eq(blocklistProposals.domain, domain));
  return row;
}

/** How many proposals exist, optionally for one domain. */
async function proposalCount(domain?: string): Promise<number> {
  const rows = await getDb()
    .select({ domain: blocklistProposals.domain })
    .from(blocklistProposals);
  return domain === undefined ? rows.length : rows.filter((row) => row.domain === domain).length;
}

// --- fixtures ---------------------------------------------------------------

/** Real instances, so the operator collapse under test is the real mapping. */
const GMBH_A = 'mastodon.social';
const GMBH_B = 'mastodon.online'; // same operator as GMBH_A
const STUX = 'mstdn.social';
const TRUMPET = 'mas.to';
const JERRY = 'infosec.exchange';

interface ObservationSpec {
  instance: string;
  severity: BlockSeverity;
  comment?: string;
  masked?: boolean;
}

interface CandidateSpec {
  domain: string;
  observations: ObservationSpec[];
  posts?: number;
  actors?: number;
  localUsersFollowing?: number;
}

function toObservation(spec: ObservationSpec): SourceObservation {
  return {
    source: spec.instance,
    severity: spec.severity,
    comment: spec.comment,
    resolvedFromDigest: spec.masked ?? false,
  };
}

/** Count distinct instances at one severity, as the real report does. */
function distinctAt(specs: readonly ObservationSpec[], severity: BlockSeverity): number {
  return new Set(specs.filter((o) => o.severity === severity).map((o) => o.instance)).size;
}

function toCandidate(spec: CandidateSpec): BlocklistCandidate {
  const suspendSources = distinctAt(spec.observations, 'suspend');
  const silenceSources = distinctAt(spec.observations, 'silence');
  return {
    domain: spec.domain,
    sourceCount: suspendSources + silenceSources,
    suspendSources,
    silenceSources,
    noopSources: distinctAt(spec.observations, 'noop'),
    observations: spec.observations.map(toObservation),
    // Mirrors the real report, which reads the same predicate this test mocks.
    blockedLocally: h.blocked.has(spec.domain),
    footprint: {
      actors: spec.actors ?? 0,
      actorsWithoutLocalUser: 0,
      posts: spec.posts ?? 0,
      localUsersFollowing: spec.localUsersFollowing ?? 0,
      remoteActorsFollowed: 0,
      localUsersFollowed: 0,
    },
  };
}

function publishedSource(instance: string): SourcePollResult {
  return { source: instance, outcome: 'published', status: 200, entries: [], rejectedEntries: 0 };
}

interface ReportSpec {
  candidates?: CandidateSpec[];
  /** Instances that answered with a list. Defaults to every instance observed. */
  publishedBy?: string[];
  failedBy?: string[];
}

function intelReport(spec: ReportSpec = {}): BlocklistIntelReport {
  const candidates = (spec.candidates ?? []).map(toCandidate);
  const observed = new Set<string>();
  for (const candidate of spec.candidates ?? []) {
    for (const observation of candidate.observations) observed.add(observation.instance);
  }
  const published = spec.publishedBy ?? [...observed];

  return {
    minSources: MIN_CORROBORATING_OPERATORS,
    sources: [
      ...published.map(publishedSource),
      ...(spec.failedBy ?? []).map((instance) => ({
        source: instance,
        outcome: 'failed' as const,
        entries: [],
        rejectedEntries: 0,
        detail: 'ECONNREFUSED',
      })),
    ],
    domainsObserved: candidates.length,
    domainsBelowThreshold: 0,
    obfuscatedEntries: 0,
    obfuscatedResolved: 0,
    obfuscatedUnresolved: 0,
    candidates,
  };
}

/** Run the sweep against a fixed report. */
function sweep(spec: ReportSpec = {}) {
  const report = intelReport(spec);
  return runBlocklistProposalSweep({ trigger: 'manual', poll: async () => report });
}

/** A domain two INDEPENDENT operators suspend — the ordinary proposable case. */
function corroborated(domain: string, extra: Partial<CandidateSpec> = {}): CandidateSpec {
  return {
    domain,
    observations: [
      { instance: GMBH_A, severity: 'suspend', comment: 'Hate speech' },
      { instance: STUX, severity: 'suspend', comment: 'hate speech' },
    ],
    ...extra,
  };
}

// --- the threshold ----------------------------------------------------------

describe('corroboration is counted by operator', () => {
  it('does not clear the threshold when both instances are one operator', async () => {
    const result = await sweep({
      candidates: [
        {
          domain: 'onegmbh.example',
          observations: [
            { instance: GMBH_A, severity: 'suspend', comment: 'Hate speech' },
            { instance: GMBH_B, severity: 'suspend', comment: 'Hate speech' },
          ],
        },
      ],
      // A third, independent publisher so the RUN is usable — otherwise this
      // would pass because the poll was rejected, not because the count was.
      publishedBy: [GMBH_A, GMBH_B, TRUMPET],
    });

    expect(result.ok).toBe(true);
    expect(result.counts.clearedOperatorThreshold).toBe(0);
    expect(result.pending).toEqual([]);
    expect(await proposalCount()).toBe(0);
  });

  it('clears it when the same two verdicts come from two operators', async () => {
    const result = await sweep({ candidates: [corroborated('two.example')] });

    expect(result.counts.clearedOperatorThreshold).toBe(1);
    expect(result.counts.opened).toBe(1);
    expect(result.pending.map((p) => p.domain)).toEqual(['two.example']);
    // One instance per operator, transcribable straight into a policy entry.
    expect(result.pending[0].corroboratingSources).toEqual([GMBH_A, STUX]);
    expect(result.pending[0].operatorCount).toBe(2);
  });

  it('never merges suspend with silence, and never counts a noop', async () => {
    const result = await sweep({
      candidates: [
        {
          // One suspend + one silence is not two suspends.
          domain: 'mixed.example',
          observations: [
            { instance: GMBH_A, severity: 'suspend' },
            { instance: STUX, severity: 'silence' },
          ],
        },
        {
          // Two operators that only SILENCE decided something else entirely.
          domain: 'silenced.example',
          observations: [
            { instance: GMBH_A, severity: 'silence' },
            { instance: STUX, severity: 'silence' },
          ],
        },
        {
          // "Listed, no action taken" corroborates nothing at all.
          domain: 'listed.example',
          observations: [
            { instance: GMBH_A, severity: 'noop' },
            { instance: STUX, severity: 'noop' },
            { instance: TRUMPET, severity: 'suspend' },
          ],
        },
      ],
      publishedBy: [GMBH_A, STUX, TRUMPET],
    });

    expect(result.pending).toEqual([]);
    expect(result.counts.clearedOperatorThreshold).toBe(0);
  });

  it('votes once per instance and once per operator, so names match the count', () => {
    const corroboration = corroboratingOperators(
      [
        { source: GMBH_A, severity: 'suspend', resolvedFromDigest: false },
        { source: GMBH_A, severity: 'suspend', resolvedFromDigest: false },
        { source: GMBH_B, severity: 'suspend', resolvedFromDigest: false },
        { source: STUX, severity: 'suspend', resolvedFromDigest: false },
        { source: JERRY, severity: 'silence', resolvedFromDigest: false },
      ],
      'suspend',
    );

    expect(corroboration.operators).toEqual(['mastodon-gmbh', 'stux']);
    expect(corroboration.sources).toHaveLength(corroboration.operators.length);
    expect(corroboration.sources).toEqual([GMBH_A, STUX]);
    expect(corroboration.unregistered).toEqual([]);
  });
});

// --- only what is new -------------------------------------------------------

describe('only what is new reaches the queue', () => {
  it('does not propose a domain our own policy already refuses', async () => {
    h.blocked.add('known.example');

    const result = await sweep({
      candidates: [corroborated('known.example'), corroborated('fresh.example')],
    });

    expect(result.pending.map((p) => p.domain)).toEqual(['fresh.example']);
    expect(result.counts.suppressedBlocked).toBe(1);
    expect(await proposalCount('known.example')).toBe(0);
  });

  it('does not propose a domain a person already declined', async () => {
    await sweep({ candidates: [corroborated('rejected.example')] });
    await declineProposal({
      domain: 'rejected.example',
      decidedBy: 'nate',
      reason: 'Bridge account, not spam — no category fits',
    });

    const result = await sweep({ candidates: [corroborated('rejected.example')] });

    expect(result.pending).toEqual([]);
    expect(result.counts.suppressedDeclined).toBe(1);
    const row = await proposalRow('rejected.example');
    expect(row?.status).toBe('declined');
    expect(row?.decisionReason).toBe('Bridge account, not spam — no category fits');
  });

  it('keeps an unanswered proposal in the queue with the date it was raised', async () => {
    const first = await sweep({ candidates: [corroborated('waiting.example')] });
    const raisedAt = first.pending[0].firstProposedAt;

    const second = await sweep({ candidates: [corroborated('waiting.example')] });

    // Unreviewed is not the same as reviewed: it stays, and it stays dated.
    expect(second.counts.opened).toBe(0);
    expect(second.counts.pending).toBe(1);
    expect(second.pending[0].raisedThisRun).toBe(false);
    expect(second.pending[0].firstProposedAt.getTime()).toBe(raisedAt.getTime());
  });
});

// --- closing rows -----------------------------------------------------------

describe('rows the sweep closes on its own', () => {
  it('lapses a proposal whose corroboration went away', async () => {
    await sweep({ candidates: [corroborated('gone.example')] });

    const result = await sweep({
      candidates: [corroborated('other.example')],
      publishedBy: [GMBH_A, STUX],
    });

    expect(result.counts.lapsed).toBe(1);
    expect((await proposalRow('gone.example'))?.status).toBe('lapsed');
  });

  it('marks a proposal adopted once the policy refuses the domain', async () => {
    await sweep({ candidates: [corroborated('adopted.example')] });

    // The person wrote the entry and it shipped.
    h.blocked.add('adopted.example');
    const result = await sweep({ candidates: [corroborated('adopted.example')] });

    expect(result.counts.adopted).toBe(1);
    expect(result.counts.suppressedBlocked).toBe(1);
    expect(result.pending).toEqual([]);
    expect((await proposalRow('adopted.example'))?.status).toBe('adopted');
  });
});

// --- a poll that cannot support a verdict -----------------------------------

describe('a run that cannot reach a verdict', () => {
  it('records the run and leaves the queue untouched', async () => {
    await sweep({ candidates: [corroborated('standing.example')] });

    // One operator publishing can never corroborate anything, so the empty
    // candidate list means "we could not look", not "there is nothing".
    const result = await sweep({ publishedBy: [GMBH_A], failedBy: [STUX, TRUMPET] });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain('1 operator');
    // The dangerous failure this guards: lapsing every open proposal at once
    // because the sources were down.
    expect(result.counts.lapsed).toBe(0);
    expect((await proposalRow('standing.example'))?.status).toBe('open');
    const recorded = await getDb()
      .select({ ok: blocklistProposalRuns.ok })
      .from(blocklistProposalRuns);
    expect(recorded.filter((run) => !run.ok)).toHaveLength(1);
  });

  it('records the run when the poll itself throws', async () => {
    const result = await runBlocklistProposalSweep({
      trigger: 'scheduled',
      poll: async () => {
        throw new Error('DNS exploded');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain('DNS exploded');
    const [run] = await getDb().select().from(blocklistProposalRuns);
    expect(run?.ok).toBe(false);
    expect(run?.trigger).toBe('scheduled');
  });
});

// --- the human decision -----------------------------------------------------

describe('recording a decision', () => {
  beforeEach(async () => {
    await sweep({ candidates: [corroborated('decide.example')] });
  });

  it('refuses to resurrect a declined domain even when the sweep never saw the decline', async () => {
    // The DISCRIMINATING case for the `status <> 'declined'` guard, and the only
    // one that observes it. The sweep reads every candidate's status once at the
    // top and skips the declined ones there, so a sequential test exercises that
    // pre-check and passes with the guard deleted — mutation-verified, it did.
    //
    // What the guard is actually for is the window between that read and the
    // write: a person declining mid-sweep. Reproduced by writing the way the
    // sweep does, against a row that has since been declined.
    await declineProposal({
      domain: 'decide.example',
      decidedBy: 'nate',
      reason: 'Bridge account, not spam',
    });

    const result = await upsertOpenProposal({
      domain: 'decide.example',
      now: new Date(),
      operatorCount: 2,
      corroboratingSources: [GMBH_A, STUX],
      observations: [],
      footprint: {
        actors: 0,
        posts: 0,
        localUsersFollowing: 0,
        remoteActorsFollowed: 0,
        localUsersFollowed: 0,
      },
    });

    expect(result).toEqual({ raised: false, declinedFirst: true });
    // A decision somebody made, still standing — with its author and reason.
    const row = await proposalRow('decide.example');
    expect(row?.status).toBe('declined');
    expect(row?.decidedBy).toBe('nate');
    expect(row?.decisionReason).toBe('Bridge account, not spam');
  });

  it('refuses a decline with no author or no reason', async () => {
    await expect(
      declineProposal({ domain: 'decide.example', decidedBy: '  ', reason: 'no' }),
    ).rejects.toThrow(/who decided/);
    await expect(
      declineProposal({ domain: 'decide.example', decidedBy: 'nate', reason: '  ' }),
    ).rejects.toThrow(/why/);
  });

  it('refuses to overwrite a decline that already exists', async () => {
    await declineProposal({ domain: 'decide.example', decidedBy: 'nate', reason: 'first call' });

    await expect(
      declineProposal({ domain: 'decide.example', decidedBy: 'someone else', reason: 'second' }),
    ).rejects.toThrow(/already declined by nate/);
  });

  it('puts a reopened proposal back in the queue with the decision cleared', async () => {
    await declineProposal({ domain: 'decide.example', decidedBy: 'nate', reason: 'thin evidence' });
    expect(await listOpenProposals()).toEqual([]);

    const reopened = await reopenProposal('decide.example', 'nate');

    expect(reopened.status).toBe('open');
    // NULL, not absent: Mongo's `$unset` removed the field, Postgres sets the
    // column back. Both say "no decision stands", and every consumer already
    // coalesces (`row.decidedBy ?? 'someone'`). The one thing that would be
    // wrong is leaving the previous author in place — a row reading `open` while
    // still naming who declined it describes two decisions at once.
    expect(reopened.decidedBy).toBeNull();
    expect(reopened.decisionReason).toBeNull();
    expect(reopened.decidedAt).toBeNull();
    expect((await listOpenProposals()).map((p) => p.domain)).toEqual(['decide.example']);
  });
});

// --- what the reviewer reads ------------------------------------------------

describe('the rendered report', () => {
  it('carries the names, the verdicts and what we hold', async () => {
    const result = await sweep({
      candidates: [
        {
          domain: 'render.example',
          observations: [
            { instance: GMBH_A, severity: 'suspend', comment: 'Hate speech' },
            { instance: STUX, severity: 'suspend', comment: 'nazis', masked: true },
            { instance: TRUMPET, severity: 'silence', comment: 'spam' },
          ],
          posts: 340,
          actors: 12,
          localUsersFollowing: 2,
        },
      ],
    });

    const report = renderProposalReport(result).join('\n');

    // The corroborating instances BY NAME, in the form the policy entry takes.
    expect(report).toContain("corroboratingSources: ['mastodon.social', 'mstdn.social']");
    // Each operator's own published reason, and which name was read vs recovered.
    expect(report).toContain('Hate speech');
    expect(report).toContain('mstdn.social [stux] (masked, recovered from digest) "nazis"');
    // The lesser decision is shown and labelled, never folded into the count.
    expect(report).toContain('does not corroborate a suspend');
    expect(report).toContain('mas.to [trumpet] "spam"');
    // What a block would cost us.
    expect(report).toContain('340 posts, 12 actors');
    expect(report).toContain('NEW  render.example');
  });

  it('bounds the scheduled report and names the tail it did not print', async () => {
    // The first sweep inherits a backlog. Every proposal is in the ledger; a
    // run that writes a thousand log lines is a run nobody reads.
    const result = await sweep({
      candidates: Array.from({ length: 30 }, (_, index) =>
        corroborated(`bulk-${String(index).padStart(2, '0')}.example`)),
    });

    expect(result.counts.pending).toBe(30);
    const report = renderProposalReport(result).join('\n');
    expect(report).toContain('bulk-24.example');
    expect(report).not.toContain('bulk-25.example');
    expect(report).toContain('5 further proposals not shown here');

    // The CLI, where a person asked for the queue, prints all of it.
    expect(renderProposalQueue(result.pending, new Date()).join('\n'))
      .toContain('bulk-29.example');
  });
});

// --- the cadence ------------------------------------------------------------

describe('the scheduler decides when a sweep is due', () => {
  function stubScheduler() {
    const runs: string[] = [];
    const scheduler = new BlocklistProposalScheduler(async (options) => {
      runs.push(options.trigger);
      const result = await sweep();
      return result;
    });
    return { scheduler, runs };
  }

  it('sweeps when there is no run history at all', async () => {
    const { scheduler, runs } = stubScheduler();
    scheduler.start();

    await scheduler.tick();

    expect(runs).toEqual(['scheduled']);
    scheduler.stop();
  });

  it('does not sweep again inside the interval', async () => {
    await recordProposalRun(recordedRun(new Date(Date.now() - 60_000)));
    const { scheduler, runs } = stubScheduler();
    scheduler.start();

    await scheduler.tick();

    expect(runs).toEqual([]);
    scheduler.stop();
  });

  it('sweeps once the interval has elapsed — however often the process restarted', async () => {
    await recordProposalRun(
      recordedRun(new Date(Date.now() - BLOCKLIST_PROPOSAL_INTERVAL_MS - 1_000)),
    );
    const { scheduler, runs } = stubScheduler();
    scheduler.start();

    await scheduler.tick();

    expect(runs).toEqual(['scheduled']);
    scheduler.stop();
  });

  it('does nothing once stopped', async () => {
    const { scheduler, runs } = stubScheduler();
    scheduler.start();
    scheduler.stop();

    await scheduler.tick();

    expect(runs).toEqual([]);
  });

  it('does not start at all on an instance that does not federate', async () => {
    h.federationEnabled = false;
    const { scheduler, runs } = stubScheduler();

    scheduler.start();
    await scheduler.tick();

    // Nothing to protect and nothing it would cost, so thirteen strangers are
    // not polled weekly to answer a question this instance does not have.
    expect(runs).toEqual([]);
    scheduler.stop();
  });
});

/** A previous sweep, as the scheduler reads it. */
function recordedRun(startedAt: Date) {
  return {
    runId: `run-${startedAt.getTime()}`,
    trigger: 'scheduled' as const,
    startedAt,
    finishedAt: startedAt,
    minOperators: MIN_CORROBORATING_OPERATORS,
    sources: [],
    counts: {
      domainsObserved: 0,
      clearedOperatorThreshold: 0,
      opened: 0,
      pending: 0,
      suppressedDeclined: 0,
      suppressedBlocked: 0,
      lapsed: 0,
      adopted: 0,
    },
    ok: true,
  };
}

// --- the property the whole design rests on ---------------------------------

describe('the scheduled path cannot block anything', () => {
  const BACKEND_SRC = path.resolve(__dirname, '../../..');

  /**
   * Every file that runs unattended. If one of these could reach the block
   * configuration, the "we never adopt another operator's moderation
   * automatically" guarantee would be a comment rather than a property.
   */
  const SCHEDULED_PATH = [
    'services/federation/BlocklistProposalService.ts',
    'services/federation/BlocklistProposalScheduler.ts',
    'db/blocklist/blocklistProposalRepository.ts',
    'connectors/activitypub/blocklistSourceRegistry.ts',
  ];

  /**
   * Mongoose write methods. Zero of these remain — the queue is Postgres — and
   * the list stays precisely BECAUSE it should now find nothing: a Mongo write
   * reappearing on this path would be a second store nobody decided about.
   */
  const MONGO_WRITE_METHODS = [
    'bulkWrite',
    'updateOne',
    'updateMany',
    'insertOne',
    'insertMany',
    'deleteOne',
    'deleteMany',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findByIdAndUpdate',
    'findOneAndReplace',
    'replaceOne',
    'create',
    'save',
  ];

  /**
   * The drizzle write verbs. This half is what keeps the check ARMED after the
   * port: the two Mongoose models were deleted, so a scanner that only knew
   * `Model.updateOne(...)` would have found nothing on any file and reported a
   * clean pass for every possible violation — the exact shape of a check that
   * stops distinguishing. `db.insert(x)` / `db.update(x)` / `db.delete(x)` name
   * their TABLE as the first argument, which is what gets tested.
   */
  const DRIZZLE_WRITE_METHODS = ['insert', 'update', 'delete'];

  /** The only four tables the unattended path may write. */
  const WRITABLE = new Set([
    'blocklistProposals',
    'blocklistProposalObservations',
    'blocklistProposalRuns',
    'blocklistProposalRunSources',
  ]);

  it('writes nothing but the review queue, and never touches the block configuration', () => {
    const mongoWrite = new RegExp(
      `\\b([A-Za-z_$][\\w$]*)\\s*\\.\\s*(${MONGO_WRITE_METHODS.join('|')})\\s*\\(`,
      'g',
    );
    const drizzleWrite = new RegExp(
      `\\.\\s*(${DRIZZLE_WRITE_METHODS.join('|')})\\s*\\(\\s*([A-Za-z_$][\\w$]*)`,
      'g',
    );
    const foreignWrites: string[] = [];
    const policyReach: string[] = [];
    let scanned = 0;
    let writeCallsSeen = 0;

    for (const relative of SCHEDULED_PATH) {
      const source = readFileSync(path.join(BACKEND_SRC, relative), 'utf8');
      // Vacuity floor: a scanner pointed at an empty or wrong file would report
      // a clean pass for every pattern below.
      expect(source.length).toBeGreaterThan(1_000);
      scanned += 1;

      for (const match of source.matchAll(mongoWrite)) {
        // The full matched line, not the capture: a truncated group cannot tell
        // the three cases apart when someone has to read the failure.
        foreignWrites.push(`${relative}: ${match[0]}`);
      }

      for (const match of source.matchAll(drizzleWrite)) {
        writeCallsSeen += 1;
        if (!WRITABLE.has(match[2])) foreignWrites.push(`${relative}: ${match[0]}`);
      }

      // The committed policy is a source file; the only way an unattended path
      // could grow an entry is by reaching for it, so reaching for it at all is
      // the line. `isBlockedDomain` is imported instead — a read, from the
      // derived enforcement predicate.
      if (/federationBlockPolicy/.test(source)) {
        const importsIt = /from\s+'[^']*federationBlockPolicy'/.test(source);
        if (importsIt) policyReach.push(`${relative}: imports the policy module`);
      }
      if (/FEDERATION_BLOCKED_DOMAINS\s*=/.test(source)) {
        policyReach.push(`${relative}: assigns FEDERATION_BLOCKED_DOMAINS`);
      }
      if (/blockedDomains\s*(?:=|\.(?:add|push))/.test(source)) {
        policyReach.push(`${relative}: mutates a blocked-domain set`);
      }
    }

    expect(scanned).toBe(SCHEDULED_PATH.length);
    // Second vacuity floor, and the one the model deletion made necessary: an
    // empty `foreignWrites` proves nothing unless the scanner found the writes
    // that ARE there. The repository issues several per proposal and per run.
    expect(writeCallsSeen, 'write calls the scanner actually matched').toBeGreaterThan(4);
    expect(foreignWrites).toEqual([]);
    expect(policyReach).toEqual([]);
  });

  it('leaves the committed policy and the enforced set untouched by a sweep', async () => {
    const before = FEDERATION_BLOCK_POLICY.length;

    const result = await sweep({ candidates: [corroborated('proposed.example')] });

    // Proposed, loudly — and refused by nothing.
    expect(result.pending.map((p) => p.domain)).toEqual(['proposed.example']);
    expect(FEDERATION_BLOCK_POLICY.map((entry) => entry.domain)).not.toContain('proposed.example');
    expect(FEDERATION_BLOCK_POLICY.length).toBe(before);
    expect([...h.blocked]).toEqual([]);
  });
});
