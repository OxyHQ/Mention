import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connectToDatabase: vi.fn(),
  runMigrations: vi.fn(),
}));

vi.mock('../../utils/database', () => ({
  connectToDatabase: mocks.connectToDatabase,
}));

vi.mock('../../migrations/runner', () => ({
  runMigrations: mocks.runMigrations,
}));

import {
  MIGRATION_DATABASE_CONNECTION_OPTIONS,
  runMigrationTask,
} from '../../migrations/task';

describe('migration task database isolation', () => {
  beforeEach(() => {
    mocks.connectToDatabase.mockReset().mockResolvedValue(undefined);
    mocks.runMigrations.mockReset().mockResolvedValue(undefined);
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
    expect(mocks.runMigrations).toHaveBeenCalledOnce();
  });

  it('does not run schema changes when the database connection fails', async () => {
    mocks.connectToDatabase.mockRejectedValueOnce(new Error('offline'));

    await expect(runMigrationTask()).rejects.toThrow('offline');
    expect(mocks.runMigrations).not.toHaveBeenCalled();
  });
});
