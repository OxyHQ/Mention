import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  connectToDatabase: vi.fn(),
  assertMongoTransactionalTopology: vi.fn(),
  runMigrations: vi.fn(),
  reconcileBlockedDomainPurges: vi.fn(),
  loadBlockedDomainPolicy: vi.fn(),
}));

vi.mock('../../utils/database', () => ({
  connectToDatabase: mocks.connectToDatabase,
}));

vi.mock('../../migrations/runner', () => ({
  runMigrations: mocks.runMigrations,
}));

vi.mock('../../utils/mongoTopology', () => ({
  assertMongoTransactionalTopology: mocks.assertMongoTransactionalTopology,
}));

/**
 * The blocked-domain reconciliation is a COLLABORATOR of the migration task, not
 * the subject of it, so it is mocked for the same reason `runMigrations` is.
 *
 * WHY THIS FILE BROKE WHEN THE BLOCKLIST GAINED ENTRIES, AND WHAT THE 10s WAS
 *
 * `reconcileBlockedDomains` returns early on an EMPTY policy, so while the
 * committed blocklist was empty this path was never reached and nobody noticed
 * it was unmocked. The moment the policy had entries, the reconciler ran here —
 * against no database, because `__tests__/setup.ts` no-ops `mongoose.connect`.
 * The first model call therefore sat in Mongoose's buffer until
 * `bufferTimeoutMS` (default 10000ms, mongoose 8.24.1) gave up and threw; the
 * task's fail-soft catch swallowed that, so with a longer ceiling the test
 * PASSED — in 10.01s, of which zero was work.
 *
 * That fixed ~10s is a property of running with no connection, NOT of the
 * reconciler and NOT of the deploy. Measured against a real server, a
 * first-ever reconciliation of 118 domains on a freshly-indexed empty
 * collection takes 82ms. In production `runMigrationTask` calls
 * `connectToDatabase` before it reconciles, so nothing ever buffers.
 *
 * The lesson worth keeping is the coverage one rather than the timing one: a
 * branch guarded by "is the policy empty" was invisible until data made it
 * reachable. Hence the wiring tests below, which exercise it deliberately.
 */
vi.mock('../../services/federation/BlockedDomainPurgeReconciler', () => ({
  reconcileBlockedDomainPurges: mocks.reconcileBlockedDomainPurges,
}));

vi.mock('../../services/federation/blockedDomainPolicySource', () => ({
  loadBlockedDomainPolicy: mocks.loadBlockedDomainPolicy,
}));

import {
  MIGRATION_DATABASE_CONNECTION_OPTIONS,
  runMigrationTask,
} from '../../migrations/task';

describe('migration task database isolation', () => {
  beforeEach(() => {
    mocks.connectToDatabase.mockReset().mockResolvedValue(undefined);
    mocks.assertMongoTransactionalTopology.mockReset().mockResolvedValue('replica_set');
    mocks.runMigrations.mockReset().mockResolvedValue(undefined);
    mocks.reconcileBlockedDomainPurges.mockReset().mockResolvedValue({
      runId: 'test', purged: [], held: [], failed: [], departed: [], breaches: [], removed: null,
    });
    mocks.loadBlockedDomainPolicy.mockReset().mockReturnValue([]);
  });

  it('uses a bounded migration-only pool and a ONE-MINUTE socket timeout', async () => {
    await runMigrationTask();

    expect(mocks.connectToDatabase).toHaveBeenCalledOnce();
    expect(mocks.connectToDatabase).toHaveBeenCalledWith({
      // 60s, not 15 minutes: this task runs inside the cutover window with the
      // service stopped, and `socketTimeoutMS` bounds one operation's inactivity.
      // A stalled connection used to burn 15 of the deploy's 20-minute deadline.
      socketTimeoutMS: 60 * 1_000,
      minPoolSize: 0,
      maxPoolSize: 10,
      readPreference: 'primary',
    });
    expect(MIGRATION_DATABASE_CONNECTION_OPTIONS).toEqual({
      socketTimeoutMS: 60_000,
      minPoolSize: 0,
      maxPoolSize: 10,
      readPreference: 'primary',
    });
    expect(mocks.assertMongoTransactionalTopology).toHaveBeenCalledOnce();
    expect(mocks.runMigrations).toHaveBeenCalledOnce();
    expect(mocks.connectToDatabase.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.assertMongoTransactionalTopology.mock.invocationCallOrder[0]);
    expect(mocks.assertMongoTransactionalTopology.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.runMigrations.mock.invocationCallOrder[0]);
  });

  it('does not run schema changes when the database connection fails', async () => {
    mocks.connectToDatabase.mockRejectedValueOnce(new Error('offline'));

    await expect(runMigrationTask()).rejects.toThrow('offline');
    expect(mocks.assertMongoTransactionalTopology).not.toHaveBeenCalled();
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it('does not run schema changes when the topology is standalone', async () => {
    mocks.assertMongoTransactionalTopology.mockRejectedValueOnce(
      new Error('MongoDB standalone topology detected'),
    );

    await expect(runMigrationTask()).rejects.toThrow('standalone topology');
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });

  it('no longer reconciles blocked domains at all', () => {
    // The payload MOVED to `scripts/reconcileBlockedDomains.ts`, its own deploy
    // step, because it is Postgres-only and carrying it inside the MONGO
    // migration one-shot meant removing Mongo from the deploy would have removed
    // the purge with it. This asserts the departure rather than the behaviour:
    // whether the purge still works is `__tests__/scripts/reconcileBlockedDomains.test.ts`,
    // which runs the real entry point against a real database instead of
    // asserting a mock was called.
    //
    // Read on SOURCE, not through a spy, because a spy can only observe a symbol
    // this module still imports — and the point is that it imports none of them.
    const source = readFileSync(
      path.resolve(__dirname, '../../migrations/task.ts'),
      'utf8',
    );
    expect(source).not.toContain('reconcileBlockedDomainPurges');
    expect(source).not.toContain('purgeBlockedDomainContent');
    expect(source).not.toContain('loadBlockedDomainPolicy');
    // Floor: the file was actually read and is the one under test.
    expect(source).toContain('export async function runMigrationTask');
  });
});
