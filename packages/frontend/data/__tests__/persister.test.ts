const mockOpenDatabaseSync = jest.fn((_name: string) => ({
  execSync: jest.fn(),
  runSync: jest.fn(),
  getAllSync: jest.fn(() => []),
  execAsync: jest.fn(),
  runAsync: jest.fn(),
  getAllAsync: jest.fn(async () => []),
  withTransactionAsync: jest.fn(),
  closeAsync: jest.fn(),
}));
jest.mock('expo-sqlite', () => ({
  openDatabaseSync: (name: string) => mockOpenDatabaseSync(name),
}));

import { accountPersister as nativePersister } from '../persister.native';

describe('account persisters', () => {
  it('give each account its own file, opened synchronously for the boot read', () => {
    const persister = nativePersister('01a0-b/c');
    expect(mockOpenDatabaseSync).not.toHaveBeenCalled();
    expect(persister.openNow?.({ versions: { post: 16 }, maxAgeMs: 1000 })).toBe(true);
    expect(mockOpenDatabaseSync).toHaveBeenCalledWith('mention-data-01a0-b_c.db');
  });

  it('keep no copy on web', () => {
    const { accountPersister: webPersister } = jest.requireActual('../persister.ts') as {
      accountPersister: (account: string) => unknown;
    };
    expect(webPersister('anyone')).toBeUndefined();
  });
});
