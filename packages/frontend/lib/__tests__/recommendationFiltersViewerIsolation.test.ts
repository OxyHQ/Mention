import {
  DEFAULT_RECOMMENDATION_FILTERS,
  getRecommendationFilters,
  getRecommendationFiltersStorageKey,
  resetRecommendationFiltersViewer,
  saveRecommendationFilters,
} from '../recommendationFilters';

const mockStorageGet = jest.fn();
const mockStorageSet = jest.fn();
const mockStorageRemove = jest.fn(
  (_key: string) => Promise.resolve(true),
);

jest.mock('@/utils/storage', () => ({
  Storage: {
    get: (...args: unknown[]) => mockStorageGet(...args),
    set: (...args: unknown[]) => mockStorageSet(...args),
    remove: (key: string) => mockStorageRemove(key),
  },
}));

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

describe('recommendation filter viewer isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStorageRemove.mockResolvedValue(true);
  });

  it('uses distinct persistence keys for A and B', () => {
    expect(getRecommendationFiltersStorageKey('viewer-a')).not.toBe(
      getRecommendationFiltersStorageKey('viewer-b'),
    );
  });

  it('discards A filters when their read resolves after A is reset', async () => {
    const pendingA = deferred<{
      showFederated: boolean;
      showAgents: boolean;
      showAutomated: boolean;
    } | null>();
    mockStorageGet.mockReturnValueOnce(pendingA.promise);

    const requestA = getRecommendationFilters('late-reader-a');
    resetRecommendationFiltersViewer('late-reader-a');
    pendingA.resolve({
      showFederated: false,
      showAgents: false,
      showAutomated: false,
    });

    await expect(requestA).resolves.toEqual(
      DEFAULT_RECOMMENDATION_FILTERS,
    );
  });

  it('orders old write → reset remove → new write for A → B → A', async () => {
    const pendingWrite = deferred<boolean>();
    mockStorageSet
      .mockReturnValueOnce(pendingWrite.promise)
      .mockResolvedValueOnce(true);
    const viewerId = 'late-writer-a';
    const storageKey = getRecommendationFiltersStorageKey(viewerId);

    const firstWrite = saveRecommendationFilters(
      {
        showFederated: false,
        showAgents: true,
        showAutomated: false,
      },
      viewerId,
    );
    await flushQueue();
    expect(mockStorageSet).toHaveBeenCalledTimes(1);

    resetRecommendationFiltersViewer(viewerId);
    const secondWrite = saveRecommendationFilters(
      {
        showFederated: true,
        showAgents: false,
        showAutomated: true,
      },
      viewerId,
    );
    await flushQueue();
    expect(mockStorageSet).toHaveBeenCalledTimes(1);

    pendingWrite.resolve(true);
    await Promise.all([firstWrite, secondWrite]);
    await flushQueue();

    expect(mockStorageSet).toHaveBeenCalledTimes(2);
    const scopedRemoveIndex = mockStorageRemove.mock.calls.findIndex(
      ([key]) => key === storageKey,
    );
    expect(scopedRemoveIndex).toBeGreaterThanOrEqual(0);
    const firstSetOrder = mockStorageSet.mock.invocationCallOrder[0];
    const resetRemoveOrder =
      mockStorageRemove.mock.invocationCallOrder[scopedRemoveIndex];
    const secondSetOrder = mockStorageSet.mock.invocationCallOrder[1];
    expect(firstSetOrder).toBeLessThan(resetRemoveOrder);
    expect(resetRemoveOrder).toBeLessThan(secondSetOrder);
  });
});
