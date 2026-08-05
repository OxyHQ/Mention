/**
 * The blocked-domain reconciliation, driven END TO END against a real database.
 *
 * ## What this file exists to catch, and why a mock cannot
 *
 * This work used to be the tail of `runMigrationTask`. It is Postgres-only, and
 * when the purge was ported (2026-08-02, `cd122151`) the entry point stopped
 * opening a Postgres pool while every symbol stayed exactly where it was: the
 * callee's own `connectPostgres` lives inside a `require.main === module` block,
 * which does not run for an importer. The result was `PostgreSQL is not
 * connected` thrown on the first `getDb()`, caught by the deliberate fail-soft,
 * and a deploy that reported success while blocking a domain purged nothing.
 * Nothing went red — `tsc` cannot see a runtime connection, and a test that
 * substitutes `runPurge` or asserts a spy was called would still pass with no
 * pool open at all.
 *
 * So this file substitutes NOTHING, and it does not IMPORT the entry point
 * either — it runs the file as a process, with the real committed policy and the
 * real purge, and reads the database afterwards. Importing it would execute the
 * exported function while the TEST held the pool open, which passes just as well
 * against an entry point that opens none.
 * `blockedDomainPurgeReconciler.test.ts` covers the reconciler's own decisions
 * (batching, ceilings, holds) with injected inputs; that is the right shape for
 * those, and it is why they are not repeated here.
 *
 * ## The two assertions, and why the second one is not redundant
 *
 * The FIRST is the wiring: the ledger goes from empty to non-empty. That is
 * precisely what the historical bug would have failed — with no pool, the
 * reconciler never writes a row and the fail-soft hides it — and it cannot pass
 * vacuously, because the table is asserted empty first.
 *
 * The SECOND is that the purge reached ROWS: for every domain the ledger records
 * as `purged`, no post from that domain survives. A run that wrote its ledger and
 * then failed to delete anything satisfies the first assertion and fails this
 * one. It is floored on the purged set being non-empty, so a run that purged
 * nothing cannot pass it by having nothing to check.
 *
 * This file needs its OWN database (see `isolatedDatabaseFiles.ts`): the sweep is
 * unscoped by construction — its candidate set is every domain in the committed
 * policy — so another file's federated post from a blocked domain is a candidate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { eq, inArray } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { blockedDomainPurges } from '../../db/schema/blocklist';
import { posts } from '../../db/schema/posts';
import { loadBlockedDomainPolicy } from '../../services/federation/blockedDomainPolicySource';

const run = promisify(execFile);

/** The entry point, run the way ECS runs it. */
const ENTRY_POINT = join(__dirname, '..', '..', 'scripts', 'reconcileBlockedDomains.ts');

/**
 * A federated post attributed to `domain`, in the shape the purge selects on:
 * `federation_activity_id` carries the origin host, which is what
 * `purgeBlockedDomainContent` matches.
 */
async function seedFederatedPost(domain: string, suffix: string): Promise<string> {
  const id = `blocked-${suffix}`;
  await getDb()
    .insert(posts)
    .values({
      id,
      oxyUserId: `actor-${suffix}`,
      visibility: 'public',
      status: 'published',
      federationActivityId: `https://${domain}/activities/${suffix}`,
      federationActorUri: `https://${domain}/users/${suffix}`,
    });
  return id;
}

/** Domains the committed policy blocks, in the order the reconciler sees them. */
const POLICY_DOMAINS = loadBlockedDomainPolicy().map((entry) => entry.domain);

describe('the blocked-domain reconciliation entry point', () => {
  const seeded = new Map<string, string>();

  beforeAll(async () => {
    await connectPostgres();

    // The floor for the whole file: a committed policy that names nothing would
    // make `reconcileBlockedDomains` a documented no-op and every assertion
    // below vacuously true.
    expect(POLICY_DOMAINS.length).toBeGreaterThan(0);

    // One post per blocked domain, so whichever domains this run reaches, there
    // is content for them to remove. Seeding only a guessed subset would make the
    // second assertion depend on the reconciler's batching, which is another
    // file's subject.
    for (const [index, domain] of POLICY_DOMAINS.entries()) {
      seeded.set(domain, await seedFederatedPost(domain, String(index)));
    }
    expect(seeded.size).toBe(POLICY_DOMAINS.length);

    const before = await getDb().select({ domain: blockedDomainPurges.domain }).from(blockedDomainPurges);
    expect(before, 'the ledger must start empty, or the first assertion proves nothing').toEqual([]);

    // RUN IT AS A PROCESS, not as an imported function. That is the whole point:
    // the bug this file exists for lived in the `require.main === module` block,
    // which an importer never executes — so a test that called the exported
    // function would open the pool ITSELF and pass against an entry point that
    // opens none. Mutation-tested: deleting `connectPostgres()` from that block
    // turns both cases below red, and no in-process call can do that.
    await run('bun', [ENTRY_POINT], {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      timeout: 120_000,
    });
  }, 180_000);

  afterAll(async () => {
    await closePostgres().catch(() => undefined);
  });

  it('writes its ledger, which it can only do with a pool this entry point opened', async () => {
    const rows = await getDb()
      .select({ domain: blockedDomainPurges.domain, state: blockedDomainPurges.state })
      .from(blockedDomainPurges);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('removes the content of every domain it recorded as purged', async () => {
    const purgedDomains = (
      await getDb()
        .select({ domain: blockedDomainPurges.domain })
        .from(blockedDomainPurges)
        .where(eq(blockedDomainPurges.state, 'purged'))
    ).map((row) => row.domain);

    // Floor: "no surviving post among an empty set" is true of a run that
    // deleted nothing at all.
    expect(purgedDomains.length).toBeGreaterThan(0);

    const shouldBeGone = purgedDomains
      .map((domain) => seeded.get(domain))
      .filter((id): id is string => id !== undefined);
    expect(shouldBeGone.length).toBe(purgedDomains.length);

    const survivors = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(inArray(posts.id, shouldBeGone));
    expect(survivors.map((row) => row.id)).toEqual([]);
  });
});
