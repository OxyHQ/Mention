import { api } from '@/utils/api';
import { useTrendsStore } from '@/stores/trendsStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: () => Promise.resolve() },
}));

jest.mock('@/utils/api', () => ({
  api: { get: jest.fn() },
}));

const mockApiGet = api.get as jest.Mock;

/** One trend as `GET /trending` serves it, with an optional volume series. */
function trend(name: string, series?: unknown) {
  return {
    _id: name,
    name,
    type: 'hashtag',
    score: 10,
    volume: 5,
    momentum: 0.5,
    rank: 1,
    calculatedAt: '2026-07-29T06:00:00.000Z',
    ...(series === undefined ? {} : { series }),
  };
}

function respond(trending: unknown[], recId = 'batch-1') {
  mockApiGet.mockResolvedValueOnce({ data: { trending, summary: '', recId } });
}

beforeEach(() => {
  mockApiGet.mockReset();
  useTrendsStore.getState().resetViewerState();
});

describe('trendsStore series', () => {
  it('carries a wire series onto the trend', async () => {
    respond([trend('tech', [1, 2, 3, 4, 5, 6])]);
    await useTrendsStore.getState().fetchTrends();
    expect(useTrendsStore.getState().trends[0].series).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('leaves series absent when the server omits it (below the coverage floor)', async () => {
    respond([trend('ukraine')]);
    await useTrendsStore.getState().fetchTrends();
    expect(useTrendsStore.getState().trends[0].series).toBeUndefined();
  });

  it.each([
    ['a non-array', 'nope'],
    ['a null hole', [1, 2, null, 4]],
    ['a NaN', [1, 2, Number.NaN, 4]],
    ['an Infinity', [1, Number.POSITIVE_INFINITY, 3]],
    ['string points', ['1', '2', '3']],
  ])('drops a malformed series (%s) rather than feeding it to the chart', async (_label, bad) => {
    // One bad point poisons a whole polyline, so the series is rejected outright
    // and the row falls back to drawing no chart.
    respond([trend('tech', bad)]);
    await useTrendsStore.getState().fetchTrends();
    expect(useTrendsStore.getState().trends[0].series).toBeUndefined();
  });

  it('replaces the series when a new batch advances it', async () => {
    respond([trend('tech', [1, 2, 3, 4, 5, 6])], 'batch-1');
    await useTrendsStore.getState().fetchTrends();
    respond([trend('tech', [2, 3, 4, 5, 6, 7])], 'batch-2');
    await useTrendsStore.getState().fetchTrends({ silent: true });
    expect(useTrendsStore.getState().trends[0].series).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('commits a series-only change even when the batch token is missing', async () => {
    // `recId` is absent whenever a cache entry predates it. If the series were
    // left to that token for change detection, the chart would silently keep
    // yesterday's shape — the quiet version of the invented geometry it replaced.
    respond([trend('tech', [1, 2, 3, 4, 5, 6])], '');
    await useTrendsStore.getState().fetchTrends();
    const before = useTrendsStore.getState().trends;
    respond([trend('tech', [1, 2, 3, 4, 5, 9])], '');
    await useTrendsStore.getState().fetchTrends({ silent: true });
    const after = useTrendsStore.getState().trends;
    expect(after).not.toBe(before);
    expect(after[0].series).toEqual([1, 2, 3, 4, 5, 9]);
  });
});

describe('resyncAfterReconnect', () => {
  it('refetches the WHOLE list, never appending the batch it missed', async () => {
    respond([trend('tech', [1, 2, 3, 4, 5, 6])]);
    await useTrendsStore.getState().fetchTrends();

    // The client slept through five batches; the server's current series shares
    // no points with the one on screen. A delta/append would leave a gap here —
    // the assertion is that the result is the SERVER's series exactly.
    respond([trend('tech', [11, 12, 13, 14, 15, 16])], 'batch-7');
    useTrendsStore.getState().resyncAfterReconnect();
    await Promise.resolve();
    await Promise.resolve();

    expect(useTrendsStore.getState().trends[0].series).toEqual([11, 12, 13, 14, 15, 16]);
    expect(mockApiGet).toHaveBeenCalledTimes(2);
  });

  it('issues no request for a client that has never rendered a trend', () => {
    // Most clients never mount a trends surface. A reconnect storm must not turn
    // into one API call per connected client.
    expect(useTrendsStore.getState().hasFetched).toBe(false);
    useTrendsStore.getState().resyncAfterReconnect();
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it('stays silent — a reconnect never flashes the list back to a spinner', async () => {
    respond([trend('tech', [1, 2, 3, 4, 5, 6])]);
    await useTrendsStore.getState().fetchTrends();

    respond([trend('tech', [2, 3, 4, 5, 6, 7])], 'batch-2');
    useTrendsStore.getState().resyncAfterReconnect();
    expect(useTrendsStore.getState().isLoading).toBe(false);
  });
});
