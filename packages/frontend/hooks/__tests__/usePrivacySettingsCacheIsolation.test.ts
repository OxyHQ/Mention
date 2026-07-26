import {
  createPrivacySettingsCacheLease,
  resetCurrentUserPrivacySettingsCache,
  updatePrivacySettingsCache,
} from '../usePrivacySettings';

const mockGetItem = jest.fn();
const mockSetItem = jest.fn(
  (_key: string, _value: string) => Promise.resolve(),
);
const mockRemoveItem = jest.fn(
  (_key: string) => Promise.resolve(),
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushQueue(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (...args: unknown[]) => mockGetItem(...args),
    setItem: (key: string, value: string) => mockSetItem(key, value),
    removeItem: (key: string) => mockRemoveItem(key),
  },
}));

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: jest.fn(),
  },
  isUnauthorizedError: jest.fn(() => false),
  isNotFoundError: jest.fn(() => false),
}));

jest.mock('@/lib/logger', () => ({
  createScopedLogger: jest.fn(() => ({
    debug: jest.fn(),
  })),
}));

describe('current-user privacy cache viewer isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
    mockRemoveItem.mockResolvedValue(undefined);
  });

  it('rejects an A mutation that finishes after A has been reset', async () => {
    const viewerId = 'privacy-viewer-a';
    const oldLease = createPrivacySettingsCacheLease(viewerId);

    resetCurrentUserPrivacySettingsCache(viewerId);
    await updatePrivacySettingsCache(
      { hideLikeCounts: true },
      oldLease,
    );

    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('orders old write → reset remove → new write for A → B → A', async () => {
    const viewerId = 'privacy-viewer-returning-a';
    const storageKey = '@mention_privacy_settings:v2:privacy-viewer-returning-a';
    const oldWriteGate = deferred<void>();
    mockSetItem
      .mockReturnValueOnce(oldWriteGate.promise)
      .mockResolvedValueOnce(undefined);
    const firstSessionLease = createPrivacySettingsCacheLease(viewerId);

    const firstWrite = updatePrivacySettingsCache(
      { profileVisibility: 'private' },
      firstSessionLease,
    );
    await flushQueue();
    expect(mockSetItem).toHaveBeenCalledTimes(1);

    resetCurrentUserPrivacySettingsCache(viewerId);
    const secondSessionLease = createPrivacySettingsCacheLease(viewerId);
    const secondWrite = updatePrivacySettingsCache(
      { profileVisibility: 'public' },
      secondSessionLease,
    );
    await flushQueue();
    expect(mockSetItem).toHaveBeenCalledTimes(1);

    oldWriteGate.resolve();
    await Promise.all([firstWrite, secondWrite]);
    await flushQueue();

    expect(mockSetItem).toHaveBeenCalledTimes(2);
    const scopedRemoveIndex = mockRemoveItem.mock.calls.findIndex(
      ([key]) => key === storageKey,
    );
    expect(scopedRemoveIndex).toBeGreaterThanOrEqual(0);
    const firstSetOrder = mockSetItem.mock.invocationCallOrder[0];
    const resetRemoveOrder =
      mockRemoveItem.mock.invocationCallOrder[scopedRemoveIndex];
    const secondSetOrder = mockSetItem.mock.invocationCallOrder[1];
    expect(firstSetOrder).toBeLessThan(resetRemoveOrder);
    expect(resetRemoveOrder).toBeLessThan(secondSetOrder);
    expect(mockSetItem).toHaveBeenLastCalledWith(
      storageKey,
      JSON.stringify({ profileVisibility: 'public' }),
    );
  });
});
