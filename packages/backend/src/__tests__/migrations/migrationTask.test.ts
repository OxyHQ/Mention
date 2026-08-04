import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('does not reconcile blocked domains when the policy names none', async () => {
    mocks.loadBlockedDomainPolicy.mockReturnValue([]);

    await runMigrationTask();

    // The branch that hid this whole path from the suite until the blocklist
    // gained entries. Asserted deliberately now, rather than relied upon.
    expect(mocks.reconcileBlockedDomainPurges).not.toHaveBeenCalled();
  });

  it('reconciles blocked domains once the policy names some', async () => {
    mocks.loadBlockedDomainPolicy.mockReturnValue([{
  domain: 'spam.example',
  severity: 'suspend' as const,
  category: 'spam' as const,
  reason: 'test',
  since: '2026-01-01',
  corroboratingSources: [] as readonly string[],
}]);

    await runMigrationTask();

    expect(mocks.reconcileBlockedDomainPurges).toHaveBeenCalledOnce();
    const input = mocks.reconcileBlockedDomainPurges.mock.calls[0][0];
    expect(input.policyEntries).toHaveLength(1);
    expect(input.policyEntries[0].domain).toBe('spam.example');
  });

  it('completes the migration task even when reconciliation throws', async () => {
    mocks.loadBlockedDomainPolicy.mockReturnValue([{
  domain: 'spam.example',
  severity: 'suspend' as const,
  category: 'spam' as const,
  reason: 'test',
  since: '2026-01-01',
  corroboratingSources: [] as readonly string[],
}]);
    mocks.reconcileBlockedDomainPurges.mockRejectedValue(new Error('reconcile exploded'));

    // Fail-soft on purpose: this runs inside the deploy one-shot, and a content
    // cleanup problem must never stop a release from shipping. Failing to delete
    // is the safe direction; blocking the deploy is not.
    await expect(runMigrationTask()).resolves.toBeUndefined();
    expect(mocks.runMigrations).toHaveBeenCalledOnce();
  });
});
