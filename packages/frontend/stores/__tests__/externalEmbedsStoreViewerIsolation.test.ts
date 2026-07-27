import { authenticatedClient } from '@/utils/api';
import { useExternalEmbedsStore } from '../externalEmbedsStore';

const mockGetItem = jest.fn();
const mockSetItem = jest.fn(
  (_key: string, _value: string) => Promise.resolve(),
);
const mockRemoveItem = jest.fn(
  (_key: string) => Promise.resolve(),
);

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => mockGetItem(key),
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
    put: jest.fn(),
  },
}));

jest.mock('@/lib/logger', () => ({
  createScopedLogger: jest.fn(() => ({
    debug: jest.fn(),
    error: jest.fn(),
  })),
}));

const mockSettingsGet = authenticatedClient.get as jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushQueue(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

describe('external embeds persistence isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetItem.mockResolvedValue(null);
    mockSetItem.mockResolvedValue(undefined);
    mockRemoveItem.mockResolvedValue(undefined);
  });

  it('orders old cache write → reset remove → returning viewer hydrate', async () => {
    const viewerId = 'external-viewer-a';
    const storageKey =
      '@mention_external_embeds:v2:external-viewer-a';
    const oldWriteGate = deferred<void>();
    mockSetItem
      .mockReturnValueOnce(oldWriteGate.promise)
      .mockResolvedValueOnce(undefined);
    mockSettingsGet
      .mockResolvedValueOnce({
        data: { externalEmbeds: { youtube: 'hide' } },
      })
      .mockResolvedValueOnce({
        data: { externalEmbeds: { youtube: 'show' } },
      });

    const firstHydrate = useExternalEmbedsStore
      .getState()
      .hydrate(true, viewerId);
    await flushQueue();
    await flushQueue();
    expect(mockSetItem).toHaveBeenCalledTimes(1);

    useExternalEmbedsStore
      .getState()
      .resetViewerState(viewerId);
    const secondHydrate = useExternalEmbedsStore
      .getState()
      .hydrate(true, viewerId);
    await flushQueue();
    expect(mockSetItem).toHaveBeenCalledTimes(1);
    expect(mockGetItem).toHaveBeenCalledTimes(1);

    oldWriteGate.resolve();
    await Promise.all([firstHydrate, secondHydrate]);
    await flushQueue();

    expect(mockSetItem).toHaveBeenCalledTimes(2);
    expect(mockGetItem).toHaveBeenCalledTimes(2);
    const scopedRemoveIndex = mockRemoveItem.mock.calls.findIndex(
      ([key]) => key === storageKey,
    );
    expect(scopedRemoveIndex).toBeGreaterThanOrEqual(0);
    const firstSetOrder = mockSetItem.mock.invocationCallOrder[0];
    const resetRemoveOrder =
      mockRemoveItem.mock.invocationCallOrder[scopedRemoveIndex];
    const secondGetOrder = mockGetItem.mock.invocationCallOrder[1];
    const secondSetOrder = mockSetItem.mock.invocationCallOrder[1];
    expect(firstSetOrder).toBeLessThan(resetRemoveOrder);
    expect(resetRemoveOrder).toBeLessThan(secondGetOrder);
    expect(secondGetOrder).toBeLessThan(secondSetOrder);
    expect(useExternalEmbedsStore.getState().prefs).toEqual({
      youtube: 'show',
    });
  });
});
