import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PurgeCounts,
  PurgeOptions,
  PurgeReport,
} from '../../../scripts/purgeBlockedDomainContent';

/**
 * The reconciliation that turns "a domain was added to the policy file" into
 * "its content is gone", unattended.
 *
 * Against a real MongoDB, because every property here is a property of the
 * LEDGER: which rows exist, what state they are in after a run that died, and
 * whether a domain gets swept twice. A mocked model cannot fail for any of
 * those. The purge itself is injected — this file is about the decision, and
 * `purgeBlockedDomainContent.test.ts` is about the deletion.
 */
vi.unmock('mongoose');

const mongoose = (await import('mongoose')).default;
const { default: BlockedDomainPurge } = await import('../../../models/BlockedDomainPurge');
const { emptyCounts } = await import('../../../scripts/purgeBlockedDomainContent');
const { reconcileBlockedDomainPurges } = await import(
  '../../../services/federation/BlockedDomainPurgeReconciler'
);

let server: MongoMemoryReplSet;

beforeAll(async () => {
  server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(server.getUri(), { dbName: 'blocked-domain-reconciler' });
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await BlockedDomainPurge.deleteMany({});
});

/** A corpus big enough that ordinary per-domain counts clear every ceiling. */
const CORPUS = { federatedPosts: 100_000, federatedActors: 40_000 };

/** A domain present the first time the policy is ever observed. */
const SEED_DOMAIN = 'seed.example';

interface StubOptions {
  /** Per-domain post counts the stubbed purge reports. */
  posts?: Record<string, number>;
  /** Per-domain local follows — the value that trips the sharpest ceiling. */
  localFollows?: Record<string, number>;
  /** Throw on the LIVE run, to exercise the failure path. */
  failLive?: boolean;
}

interface StubbedPurge {
  runPurge: (domains: ReadonlySet<string>, options: PurgeOptions) => Promise<PurgeReport>;
  calls: Array<{ domains: string[]; dryRun: boolean }>;
}

function stubPurge(stub: StubOptions = {}): StubbedPurge {
  const calls: Array<{ domains: string[]; dryRun: boolean }> = [];
  return {
    calls,
    runPurge: async (domains, options) => {
      calls.push({ domains: [...domains].sort(), dryRun: options.dryRun });
      if (stub.failLive && !options.dryRun) throw new Error('purge exploded');

      const byDomain = new Map<string, PurgeCounts>();
      const totals = emptyCounts();
      for (const domain of domains) {
        const counts = emptyCounts();
        counts.posts = stub.posts?.[domain] ?? 10;
        counts.actors = 1;
        counts.localFollowsRemoved = stub.localFollows?.[domain] ?? 0;
        byDomain.set(domain, counts);
        totals.posts += counts.posts;
        totals.actors += counts.actors;
        totals.localFollowsRemoved += counts.localFollowsRemoved;
      }
      return {
        dryRun: options.dryRun,
        domains: domains.size,
        corpus: CORPUS,
        totals,
        byDomain,
        issues: {
          preflightBlocked: 0,
          mediaObjectDeleteFailed: 0,
          cursorWriteFailed: 0,
          engagementResidue: 0,
          cascadeResidue: 0,
        },
      };
    },
  };
}

/**
 * Establish the baseline the way production will: a policy file that ALREADY
 * names domains when it first lands. The baseline is "the first policy content
 * this ledger ever saw", so seeding it with a real domain is what makes every
 * later domain a genuine delta.
 */
async function establishBaseline(purge: StubbedPurge): Promise<void> {
  await reconcileBlockedDomainPurges({
    policyDomains: [SEED_DOMAIN],
    runPurge: purge.runPurge,
  });
}

async function stateOf(domain: string): Promise<string | undefined> {
  const row = await BlockedDomainPurge.findOne({ domain }).lean();
  return row?.state;
}

describe('the first reconciliation establishes a baseline, it does not purge a backlog', () => {
  it('records every pre-existing policy domain WITHOUT purging it', async () => {
    const purge = stubPurge();

    const result = await reconcileBlockedDomainPurges({
      policyDomains: ['a.example', 'b.example', 'c.example'],
      runPurge: purge.runPurge,
    });

    // "Everything blocked so far" is exactly the batch an unattended run must
    // never take on itself — it is reviewed and run by a person, once.
    expect(result.baselined.sort()).toEqual(['a.example', 'b.example', 'c.example']);
    expect(result.purged).toEqual([]);
    expect(purge.calls).toEqual([]);
    expect(await stateOf('a.example')).toBe('baseline');
  });

  it('baselines the first domain it ever sees even when the policy started EMPTY', async () => {
    // The baseline is "the first policy content this ledger ever saw", not "the
    // first time the reconciler ran". An empty policy records nothing, so the
    // first real domain is still the first thing seen and is held for review
    // rather than swept unattended. Conservative on purpose: the failure
    // direction of an automatic deleter must always be to delete less.
    const purge = stubPurge();
    await reconcileBlockedDomainPurges({ policyDomains: [], runPurge: purge.runPurge });

    const result = await reconcileBlockedDomainPurges({
      policyDomains: ['first.example'],
      runPurge: purge.runPurge,
    });

    expect(result.baselined).toEqual(['first.example']);
    expect(result.purged).toEqual([]);
    expect(purge.calls).toEqual([]);
  });

  it('purges a domain added AFTER the baseline exists', async () => {
    const purge = stubPurge();
    await reconcileBlockedDomainPurges({
      policyDomains: ['a.example'],
      runPurge: purge.runPurge,
    });

    const result = await reconcileBlockedDomainPurges({
      policyDomains: ['a.example', 'new.example'],
      runPurge: purge.runPurge,
    });

    expect(result.purged).toEqual(['new.example']);
    expect(await stateOf('new.example')).toBe('purged');
    // The baseline domain is NOT swept along with it.
    expect(await stateOf('a.example')).toBe('baseline');
    expect(purge.calls.map((call) => call.domains)).toEqual([['new.example'], ['new.example']]);
  });
});

describe('it acts on the delta, not the whole policy', () => {
  it('does not re-sweep a domain it already purged', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'one.example'],
      runPurge: purge.runPurge,
    });
    const callsAfterFirst = purge.calls.length;

    const again = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'one.example'],
      runPurge: purge.runPurge,
    });

    expect(again.purged).toEqual([]);
    expect(purge.calls.length).toBe(callsAfterFirst);
  });

  it('measures ONLY the newly blocked domains, never the whole policy', async () => {
    const purge = stubPurge();
    await reconcileBlockedDomainPurges({
      policyDomains: ['old1.example', 'old2.example'],
      runPurge: purge.runPurge,
    });

    await reconcileBlockedDomainPurges({
      policyDomains: ['old1.example', 'old2.example', 'fresh.example'],
      runPurge: purge.runPurge,
    });

    for (const call of purge.calls) expect(call.domains).toEqual(['fresh.example']);
  });
});

describe('removing a domain from the policy undoes nothing', () => {
  it('marks it out-of-policy and restores no content', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'gone.example'],
      runPurge: purge.runPurge,
    });

    const result = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN],
      runPurge: purge.runPurge,
    });

    expect(result.departed).toEqual(['gone.example']);
    const row = await BlockedDomainPurge.findOne({ domain: 'gone.example' }).lean();
    // Deletion is one-way: the row still says purged, and nothing anywhere
    // restores what was removed.
    expect(row?.inPolicy).toBe(false);
    expect(row?.state).toBe('purged');
  });

  it('treats a REMOVED-then-RE-ADDED domain as newly blocked again', async () => {
    // Content can have arrived while it was allowed, so the second block must
    // purge just like the first.
    const purge = stubPurge();
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'back.example'],
      runPurge: purge.runPurge,
    });
    await establishBaseline(purge);
    const before = purge.calls.length;

    const result = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'back.example'],
      runPurge: purge.runPurge,
    });

    expect(result.purged).toEqual(['back.example']);
    expect(purge.calls.length).toBeGreaterThan(before);
  });
});

describe('the circuit breaker', () => {
  it('HOLDS a batch that breaches a ceiling and deletes nothing', async () => {
    const purge = stubPurge({ localFollows: { 'typo.example': 3 } });
    await establishBaseline(purge);

    const result = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'typo.example'],
      runPurge: purge.runPurge,
    });

    expect(result.held).toEqual(['typo.example']);
    expect(result.purged).toEqual([]);
    // Measured, then refused: the ONLY purge call is the read-only one.
    expect(purge.calls).toEqual([{ domains: ['typo.example'], dryRun: true }]);
    const row = await BlockedDomainPurge.findOne({ domain: 'typo.example' }).lean();
    expect(row?.state).toBe('held');
    expect(row?.heldReason).toContain('localFollowsPerDomain');
    expect(row?.measured?.localFollowsRemoved).toBe(3);
  });

  it('does not retry a held domain on the next deploy — it waits for a human', async () => {
    const purge = stubPurge({ localFollows: { 'typo.example': 3 } });
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'typo.example'],
      runPurge: purge.runPurge,
    });
    const afterHold = purge.calls.length;

    const again = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'typo.example'],
      runPurge: purge.runPurge,
    });

    expect(again.held).toEqual([]);
    expect(again.purged).toEqual([]);
    expect(purge.calls.length).toBe(afterHold);
  });

  it('always measures with a DRY RUN before it decides', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);

    await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'ok.example'],
      runPurge: purge.runPurge,
    });

    // Read-only first, destructive second — never the other way round.
    expect(purge.calls[0].dryRun).toBe(true);
    expect(purge.calls[1].dryRun).toBe(false);
  });
});

describe('running twice, and dying half way', () => {
  it('records what a completed run removed', async () => {
    const purge = stubPurge({ posts: { 'spam.example': 42 } });
    await establishBaseline(purge);

    await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'spam.example'],
      runPurge: purge.runPurge,
    });

    const row = await BlockedDomainPurge.findOne({ domain: 'spam.example' }).lean();
    // "It vanished and nobody knows when or why" is the outcome this prevents.
    expect(row?.removed?.posts).toBe(42);
    expect(row?.purgedAt).toBeInstanceOf(Date);
    expect(row?.runId).toBeTruthy();
  });

  it('marks a failed purge for retry instead of claiming success', async () => {
    const purge = stubPurge({ failLive: true });
    await establishBaseline(purge);

    const result = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'boom.example'],
      runPurge: purge.runPurge,
    });

    expect(result.failed).toEqual(['boom.example']);
    expect(await stateOf('boom.example')).toBe('failed');
  });

  it('retries a failed domain on the next reconciliation', async () => {
    const failing = stubPurge({ failLive: true });
    await establishBaseline(failing);
    await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'boom.example'],
      runPurge: failing.runPurge,
    });

    const healthy = stubPurge();
    const result = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'boom.example'],
      runPurge: healthy.runPurge,
    });

    expect(result.purged).toEqual(['boom.example']);
    expect(await stateOf('boom.example')).toBe('purged');
  });

  it('leaves a domain claimed when a run dies, and re-arms it only once the claim is stale', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await BlockedDomainPurge.create({
      domain: 'stuck.example',
      inPolicy: true,
      state: 'in_progress',
      firstObservedAt: new Date(),
      lastObservedAt: new Date(),
      claimedAt: new Date(),
      runId: 'dead-run',
    });

    // A claim made moments ago belongs to a run that may still be working.
    const soon = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'stuck.example'],
      runPurge: purge.runPurge,
    });
    expect(soon.purged).toEqual([]);
    expect(await stateOf('stuck.example')).toBe('in_progress');

    // Once the claim is old, the work is redone rather than abandoned.
    await BlockedDomainPurge.updateOne(
      { domain: 'stuck.example' },
      { $set: { claimedAt: new Date(Date.now() - 3 * 60 * 60 * 1_000) } },
    );
    const later = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'stuck.example'],
      runPurge: purge.runPurge,
    });

    expect(later.purged).toEqual(['stuck.example']);
  });

  it('is safe to run twice over: the second run finds nothing to claim', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'twice.example'],
      runPurge: purge.runPurge,
    });
    const calls = purge.calls.length;

    const second = await reconcileBlockedDomainPurges({
      policyDomains: [SEED_DOMAIN, 'twice.example'],
      runPurge: purge.runPurge,
    });

    expect(second.purged).toEqual([]);
    expect(purge.calls.length).toBe(calls);
  });
});

describe('a reviewed manual run settles the same ledger', () => {
  it('lets a baselined backlog become purged, so the record stops saying otherwise', async () => {
    // The lead runs the pre-existing 196 by hand after reviewing the numbers.
    // If that never reached the ledger, every one of those domains would read
    // "baseline — never purged" forever, and any surface rendering it would be
    // showing something false.
    const purge = stubPurge();
    await reconcileBlockedDomainPurges({
      policyDomains: ['backlog.example'],
      runPurge: purge.runPurge,
    });
    expect(await stateOf('backlog.example')).toBe('baseline');

    // What `main()` does after a reviewed live run, through the same model.
    await BlockedDomainPurge.updateOne(
      { domain: 'backlog.example' },
      { $set: { state: 'purged', purgedAt: new Date(), runId: 'manual-test' } },
    );

    const after = await reconcileBlockedDomainPurges({
      policyDomains: ['backlog.example'],
      runPurge: purge.runPurge,
    });

    expect(after.purged).toEqual([]);
    expect(await stateOf('backlog.example')).toBe('purged');
  });
});

describe('no policy source', () => {
  it('does nothing at all when the policy names no domain', async () => {
    const purge = stubPurge();

    const result = await reconcileBlockedDomainPurges({
      policyDomains: [],
      runPurge: purge.runPurge,
    });

    expect(result.purged).toEqual([]);
    expect(purge.calls).toEqual([]);
    expect(await BlockedDomainPurge.countDocuments({})).toBe(0);
  });
});
