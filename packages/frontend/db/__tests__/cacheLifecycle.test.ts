import { getDb, resetDb } from '../database';
import { memClearAll } from '../memoryStore';
import { claimViewerCache } from '../cacheLifecycle';

let mockOwner: string | null = null;
let mockFailTransactions = false;

const mockDb = {
  execSync: jest.fn((sql: string) => {
    if (mockFailTransactions && sql === 'BEGIN IMMEDIATE') {
      throw new Error('sqlite write failed');
    }
    if (sql.includes('DELETE FROM cache_metadata')) {
      mockOwner = null;
    }
  }),
  runSync: jest.fn((sql: string, ...params: unknown[]) => {
    if (sql.includes('INSERT OR REPLACE INTO cache_metadata')) {
      mockOwner = String(params[1]);
    }
    return { changes: 1, lastInsertRowId: 0 };
  }),
  getFirstSync: jest.fn(() =>
    mockOwner === null ? null : { value: mockOwner },
  ),
  getAllSync: jest.fn(() => []),
  closeSync: jest.fn(),
};

jest.mock('../database', () => ({
  getDb: jest.fn(),
  resetDb: jest.fn(),
}));

jest.mock('../memoryStore', () => ({
  memClearAll: jest.fn(),
}));

const mockGetDb = getDb as jest.Mock;
const mockResetDb = resetDb as jest.Mock;
const mockMemClearAll = memClearAll as jest.Mock;
const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(
  globalThis,
  'localStorage',
);

describe('viewer-owned cache lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOwner = 'viewer-a';
    mockFailTransactions = false;
    mockGetDb.mockReturnValue(mockDb);
  });

  afterEach(() => {
    if (originalLocalStorageDescriptor) {
      Object.defineProperty(
        globalThis,
        'localStorage',
        originalLocalStorageDescriptor,
      );
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });

  it('reuses persistence only when its owner matches the resolved viewer', () => {
    expect(claimViewerCache('viewer-a')).toEqual({
      reset: false,
      previousViewerId: 'viewer-a',
      trusted: true,
    });

    expect(mockMemClearAll).not.toHaveBeenCalled();
    expect(mockDb.execSync).not.toHaveBeenCalled();
  });

  it('wipes a different viewer cache and writes the new owner atomically', () => {
    expect(claimViewerCache('viewer-b')).toEqual({
      reset: true,
      previousViewerId: 'viewer-a',
      trusted: true,
    });

    expect(mockMemClearAll).toHaveBeenCalledTimes(1);
    expect(mockDb.execSync).toHaveBeenNthCalledWith(1, 'BEGIN IMMEDIATE');
    expect(mockDb.execSync.mock.calls[1]?.[0]).toContain(
      'DELETE FROM posts',
    );
    expect(mockDb.execSync).toHaveBeenLastCalledWith('COMMIT');
    expect(mockOwner).toBe('viewer-b');
  });

  it('treats ownerless legacy persistence as untrusted', () => {
    mockOwner = null;

    expect(claimViewerCache('viewer-a')).toEqual({
      reset: true,
      previousViewerId: null,
      trusted: true,
    });

    expect(mockMemClearAll).toHaveBeenCalledTimes(1);
    expect(mockOwner).toBe('viewer-a');
  });

  it('keeps the UI gated if SQLite cannot be wiped after recovery', () => {
    mockFailTransactions = true;

    expect(claimViewerCache('viewer-b')).toEqual({
      reset: true,
      previousViewerId: 'viewer-a',
      trusted: false,
    });

    expect(mockResetDb).toHaveBeenCalledTimes(1);
    expect(mockOwner).toBe('viewer-a');
  });

  it('uses the persisted browser owner when SQLite is unavailable', () => {
    const values = new Map<string, string>([
      ['mention.viewer-cache-owner.v1', 'viewer-a'],
    ]);
    const browserStorage = {
      getItem: jest.fn((key: string) => values.get(key) ?? null),
      setItem: jest.fn((key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as Storage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: browserStorage,
    });
    mockGetDb.mockReturnValue(null);

    expect(claimViewerCache('viewer-b')).toEqual({
      reset: true,
      previousViewerId: 'viewer-a',
      trusted: true,
    });

    expect(mockMemClearAll).toHaveBeenCalledTimes(1);
    expect(browserStorage.setItem).toHaveBeenCalledWith(
      'mention.viewer-cache-owner.v1',
      'viewer-b',
    );
  });
});
