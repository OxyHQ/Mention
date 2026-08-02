import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectToDatabase: vi.fn(),
  assertMongoTransactionalTopology: vi.fn(),
  runMigrations: vi.fn(),
  reconcileBlockedDomainPurges: vi.fn(),
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
 * the subject of this file, and it is mocked for the same reason `runMigrations`
 * is: this file asserts which connection options the task opens, nothing more.
 *
 * Leaving it real made the suite fail the moment the committed blocklist became
 * non-empty — not because reconciling is slow, but because there is no database
 * here (`__tests__/setup.ts` no-ops `mongoose.connect`), so the first model call
 * sat in Mongoose's buffer until it gave up. Measured: the test took 10.01s, one
 * `bufferTimeoutMS`, of which zero was real work; the task's own fail-soft catch
 * then swallowed the error and the assertions passed. A 5s default turned that
 * into a timeout that reads like a performance regression and is not one.
 */
vi.mock('../../services/federation/BlockedDomainPurgeReconciler', () => ({
  reconcileBlockedDomainPurges: mocks.reconcileBlockedDomainPurges,
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
  });

  it('uses a bounded migration-only pool and a 15-minute socket timeout', async () => {
    await runMigrationTask();

    expect(mocks.connectToDatabase).toHaveBeenCalledOnce();
    expect(mocks.connectToDatabase).toHaveBeenCalledWith({
      socketTimeoutMS: 15 * 60 * 1_000,
      minPoolSize: 0,
      maxPoolSize: 10,
      readPreference: 'primary',
    });
    expect(MIGRATION_DATABASE_CONNECTION_OPTIONS).toEqual({
      socketTimeoutMS: 900_000,
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
});
