import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import type {
  PurgeCounts,
  PurgeOptions,
  PurgeReport,
} from '../../../scripts/purgeBlockedDomainContent';
import type { FederationBlockPolicyEntry } from '../../../connectors/activitypub/federationBlockPolicy';

/**
 * The reconciliation that turns "a domain was added to the policy file" into
 * "its content is gone", unattended.
 *
 * Against a real database, because every property here is a property of the
 * LEDGER: which rows exist, what state they are in after a run that died, and
 * whether a domain gets swept twice. A mocked model cannot fail for any of
 * those. The purge itself is injected — this file is about the decision, and
 * `purgeBlockedDomainContent.test.ts` is about the deletion.
 *
 * That database is Postgres now. **This file owns `blocked_domain_purges` and
 * `blocked_domain_purge_runs` for the duration of a run**: its cleanup is
 * unscoped because one case asserts that NO row exists after an empty policy,
 * which is a claim about the whole table rather than about this file's rows.
 * Vitest runs files in parallel against one database; nothing else writes these
 * two tables today, and if something starts, both files need scoping and that
 * case needs rethinking.
 */

const { closePostgres, connectPostgres, getDb } = await import('../../../db/postgres');
const { blockedDomainPurges, blockedDomainPurgeRuns } = await import(
  '../../../db/schema/blocklist'
);
const { emptyCounts } = await import('../../../scripts/purgeBlockedDomainContent');
const { reconcileBlockedDomainPurges } = await import(
  '../../../services/federation/BlockedDomainPurgeReconciler'
);

beforeAll(async () => {
  await connectPostgres();
}, 60_000);

afterAll(async () => {
  const db = getDb();
  await db.delete(blockedDomainPurges);
  await db.delete(blockedDomainPurgeRuns);
  await closePostgres();
});

beforeEach(async () => {
  const db = getDb();
  await db.delete(blockedDomainPurges);
  await db.delete(blockedDomainPurgeRuns);
});

/** One state row, or `undefined`. */
async function purgeRow(domain: string) {
  const [row] = await getDb()
    .select()
    .from(blockedDomainPurges)
    .where(eq(blockedDomainPurges.domain, domain));
  return row;
}

/** Every history row for one domain, oldest run first. */
async function historyRows(domain: string) {
  return getDb()
    .select()
    .from(blockedDomainPurgeRuns)
    .where(eq(blockedDomainPurgeRuns.domain, domain))
    .orderBy(asc(blockedDomainPurgeRuns.runAt));
}

/** A corpus big enough that ordinary per-domain counts clear every ceiling. */
const CORPUS = { federatedPosts: 100_000, federatedActors: 40_000 };

/** A domain present the first time the policy is ever observed. */
const SEED_DOMAIN = 'seed.example';

/**
 * Policy entries in the shape `getBlockedDomainPolicy()` returns.
 *
 * `since` is given a value here precisely so it is visible that nothing reads it
 * to decide newness — it is a date the author declares, not a commit timestamp,
 * and correcting a typo in it must never re-trigger a deletion.
 */
function entries(domains: readonly string[]): FederationBlockPolicyEntry[] {
  return domains.map((domain) => ({
    domain,
    severity: 'suspend',
    category: 'spam',
    reason: `${domain} was blocked for testing`,
    since: '2026-01-01',
    corroboratingSources: ['mastodon.social'],
  }));
}

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
 * Put one already-handled domain in the ledger, so a later assertion about "a
 * NEWLY blocked domain" is distinguishable from "every domain in the policy".
 * This sweeps the seed domain, which is now the ordinary first-batch behaviour.
 */
async function establishBaseline(_purge: StubbedPurge): Promise<void> {
  // Written straight to the ledger rather than reconciled, so seeding costs no
  // purge calls and cannot leak state into what a test is actually asserting.
  await getDb().insert(blockedDomainPurges).values({
    domain: SEED_DOMAIN,
    inPolicy: true,
    state: 'purged',
    firstObservedAt: new Date(),
    lastObservedAt: new Date(),
    purgedAt: new Date(),
    runId: 'seed-run',
  });
}

async function stateOf(domain: string): Promise<string | undefined> {
  return (await purgeRow(domain))?.state;
}

describe('the first batch takes the ordinary path — measured, then swept or held', () => {
  it('purges a pre-existing policy on the first reconciliation', async () => {
    // There is no "backlog" special case. Whether a batch is safe is decided by
    // MEASURING it, never by how old the policy entry is — an earlier version
    // recorded the first batch and skipped it, which silently suppressed the one
    // deletion that actually had content behind it.
    const purge = stubPurge();

    const result = await reconcileBlockedDomainPurges({
      policyEntries: entries(['a.example', 'b.example', 'c.example']),
      runPurge: purge.runPurge,
    });

    expect(result.purged.sort()).toEqual(['a.example', 'b.example', 'c.example']);
    expect(await stateOf('a.example')).toBe('purged');
    expect(purge.calls[0].dryRun).toBe(true);
    expect(purge.calls[1].dryRun).toBe(false);
  });

  it('HOLDS an unusual first batch rather than skipping it silently', async () => {
    // The outcome the removed baseline used to produce, except now it is a
    // decision taken from real numbers, recorded with the ceiling that refused
    // it, and resolvable by a human. Skipping and holding look the same from
    // outside; only one of them leaves evidence.
    const purge = stubPurge({ localFollows: { 'huge.example': 4 } });

    const result = await reconcileBlockedDomainPurges({
      policyEntries: entries(['huge.example']),
      runPurge: purge.runPurge,
    });

    expect(result.purged).toEqual([]);
    expect(result.held).toEqual(['huge.example']);
    const row = await purgeRow('huge.example');
    expect(row?.heldReason).toContain('localFollowsPerDomain');
    expect(row?.measuredLocalFollowsRemoved).toBe(4);
  });

  it('purges the first domain it ever sees even when the policy started EMPTY', async () => {
    const purge = stubPurge();
    await reconcileBlockedDomainPurges({ policyEntries: [], runPurge: purge.runPurge });

    const result = await reconcileBlockedDomainPurges({
      policyEntries: entries(['first.example']),
      runPurge: purge.runPurge,
    });

    expect(result.purged).toEqual(['first.example']);
  });

  it('sweeps only the domain added AFTER an earlier run, not the whole policy again', async () => {
    const purge = stubPurge();
    await reconcileBlockedDomainPurges({
      policyEntries: entries(['a.example']),
      runPurge: purge.runPurge,
    });
    const callsAfterFirst = purge.calls.length;

    const result = await reconcileBlockedDomainPurges({
      policyEntries: entries(['a.example', 'new.example']),
      runPurge: purge.runPurge,
    });

    expect(result.purged).toEqual(['new.example']);
    expect(await stateOf('new.example')).toBe('purged');
    // Already handled, so it is not swept a second time.
    expect(await stateOf('a.example')).toBe('purged');
    expect(purge.calls.slice(callsAfterFirst).map((call) => call.domains))
      .toEqual([['new.example'], ['new.example']]);
  });
});

describe('it acts on the delta, not the whole policy', () => {
  it('does not re-sweep a domain it already purged', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'one.example']),
      runPurge: purge.runPurge,
    });
    const callsAfterFirst = purge.calls.length;

    const again = await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'one.example']),
      runPurge: purge.runPurge,
    });

    expect(again.purged).toEqual([]);
    expect(purge.calls.length).toBe(callsAfterFirst);
  });

  it('measures ONLY the newly blocked domains, never the whole policy', async () => {
    const purge = stubPurge();
    await reconcileBlockedDomainPurges({
      policyEntries: entries(['old1.example', 'old2.example']),
      runPurge: purge.runPurge,
    });
    const callsAfterFirst = purge.calls.length;

    await reconcileBlockedDomainPurges({
      policyEntries: entries(['old1.example', 'old2.example', 'fresh.example']),
      runPurge: purge.runPurge,
    });

    for (const call of purge.calls.slice(callsAfterFirst)) {
      expect(call.domains).toEqual(['fresh.example']);
    }
  });
});

describe('removing a domain from the policy undoes nothing', () => {
  it('marks it out-of-policy and restores no content', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'gone.example']),
      runPurge: purge.runPurge,
    });

    const result = await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN]),
      runPurge: purge.runPurge,
    });

    expect(result.departed).toEqual(['gone.example']);
    const row = await purgeRow('gone.example');
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
      policyEntries: entries([SEED_DOMAIN, 'back.example']),
      runPurge: purge.runPurge,
    });
    expect(await stateOf('back.example')).toBe('purged');

    // Removed from the policy — nothing is undone, the row is just flagged.
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN]),
      runPurge: purge.runPurge,
    });
    const before = purge.calls.length;

    // Re-added. Content can have arrived while it was allowed, so this is a
    // fresh block and must be swept like the first one.
    const result = await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'back.example']),
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
      policyEntries: entries([SEED_DOMAIN, 'typo.example']),
      runPurge: purge.runPurge,
    });

    expect(result.held).toEqual(['typo.example']);
    expect(result.purged).toEqual([]);
    // Measured, then refused: the ONLY purge call is the read-only one.
    expect(purge.calls).toEqual([{ domains: ['typo.example'], dryRun: true }]);
    expect(purge.calls.some((call) => !call.dryRun)).toBe(false);
    const row = await purgeRow('typo.example');
    expect(row?.state).toBe('held');
    expect(row?.heldReason).toContain('localFollowsPerDomain');
    expect(row?.measuredLocalFollowsRemoved).toBe(3);
  });

  it('does not retry a held domain on the next deploy — it waits for a human', async () => {
    const purge = stubPurge({ localFollows: { 'typo.example': 3 } });
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'typo.example']),
      runPurge: purge.runPurge,
    });
    const afterHold = purge.calls.length;

    const again = await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'typo.example']),
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
      policyEntries: entries([SEED_DOMAIN, 'ok.example']),
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
      policyEntries: entries([SEED_DOMAIN, 'spam.example']),
      runPurge: purge.runPurge,
    });

    const row = await purgeRow('spam.example');
    expect(row?.purgedAt).toBeInstanceOf(Date);
    expect(row?.runId).toBeTruthy();

    // "It vanished and nobody knows when or why" is the outcome this prevents.
    const [history] = await historyRows('spam.example');
    expect(history?.removedPosts).toBe(42);
    expect(history?.trigger).toBe('policy_added');
    expect(history?.runAt).toBeInstanceOf(Date);
    // The policy's own words ride with the record, so a deletion is never
    // unexplained even if the entry is later reworded or removed.
    expect(history?.reason).toContain('spam.example');
    expect(history?.corroboratingSources).toEqual(['mastodon.social']);
  });

  it('marks a failed purge for retry instead of claiming success', async () => {
    const purge = stubPurge({ failLive: true });
    await establishBaseline(purge);

    const result = await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'boom.example']),
      runPurge: purge.runPurge,
    });

    expect(result.failed).toEqual(['boom.example']);
    expect(await stateOf('boom.example')).toBe('failed');
  });

  it('retries a failed domain on the next reconciliation', async () => {
    const failing = stubPurge({ failLive: true });
    await establishBaseline(failing);
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'boom.example']),
      runPurge: failing.runPurge,
    });

    const healthy = stubPurge();
    const result = await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'boom.example']),
      runPurge: healthy.runPurge,
    });

    expect(result.purged).toEqual(['boom.example']);
    expect(await stateOf('boom.example')).toBe('purged');
  });

  it('leaves a domain claimed when a run dies, and re-arms it only once the claim is stale', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await getDb().insert(blockedDomainPurges).values({
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
      policyEntries: entries([SEED_DOMAIN, 'stuck.example']),
      runPurge: purge.runPurge,
    });
    expect(soon.purged).toEqual([]);
    expect(await stateOf('stuck.example')).toBe('in_progress');

    // Once the claim is old, the work is redone rather than abandoned.
    await getDb()
      .update(blockedDomainPurges)
      .set({ claimedAt: new Date(Date.now() - 3 * 60 * 60 * 1_000) })
      .where(eq(blockedDomainPurges.domain, 'stuck.example'));
    const later = await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'stuck.example']),
      runPurge: purge.runPurge,
    });

    expect(later.purged).toEqual(['stuck.example']);
  });

  it('is safe to run twice over: the second run finds nothing to claim', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'twice.example']),
      runPurge: purge.runPurge,
    });
    const calls = purge.calls.length;

    const second = await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'twice.example']),
      runPurge: purge.runPurge,
    });

    expect(second.purged).toEqual([]);
    expect(purge.calls.length).toBe(calls);
  });
});

describe('the run history is append-only', () => {
  it('keeps BOTH results when a domain is blocked, unblocked and blocked again', async () => {
    // The reason history is a separate collection from state. Storing counts on
    // the state row would overwrite the first purge with the second, and any
    // per-domain total would then be quietly wrong.
    const purge = stubPurge({ posts: { 'again.example': 7 } });
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'again.example']),
      runPurge: purge.runPurge,
    });
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN]),
      runPurge: purge.runPurge,
    });

    const second = stubPurge({ posts: { 'again.example': 5 } });
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'again.example']),
      runPurge: second.runPurge,
    });

    const history = await historyRows('again.example');
    expect(history).toHaveLength(2);
    expect(history.map((row) => row.removedPosts).sort()).toEqual([5, 7]);
    // Summing per domain is the query a transparency surface wants, and it is
    // only correct because neither row overwrote the other.
    expect(history.reduce((sum, row) => sum + row.removedPosts, 0)).toBe(12);
  });

  it('does not append a duplicate when the same run records a domain twice', async () => {
    const purge = stubPurge();
    await establishBaseline(purge);
    await reconcileBlockedDomainPurges({
      policyEntries: entries([SEED_DOMAIN, 'once.example']),
      runPurge: purge.runPurge,
    });

    expect(await historyRows('once.example')).toHaveLength(1);
  });
});

describe('a reviewed manual run settles the same ledger', () => {
  it('lets a held domain become purged, so the record stops saying otherwise', async () => {
    // A human resolves a held domain by running the reviewed one-shot. If that
    // never reached the ledger, the domain would read "held — never purged"
    // forever and any surface rendering it would be showing something false.
    const purge = stubPurge({ localFollows: { 'backlog.example': 2 } });
    await reconcileBlockedDomainPurges({
      policyEntries: entries(['backlog.example']),
      runPurge: purge.runPurge,
    });
    expect(await stateOf('backlog.example')).toBe('held');

    // What `main()` does after a reviewed live run, through the same model.
    await getDb()
      .update(blockedDomainPurges)
      .set({ state: 'purged', purgedAt: new Date(), runId: 'manual-test' })
      .where(eq(blockedDomainPurges.domain, 'backlog.example'));

    const after = await reconcileBlockedDomainPurges({
      policyEntries: entries(['backlog.example']),
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
      policyEntries: [],
      runPurge: purge.runPurge,
    });

    expect(result.purged).toEqual([]);
    expect(purge.calls).toEqual([]);
    expect(await getDb().select().from(blockedDomainPurges)).toEqual([]);
  });
});
