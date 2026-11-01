import { api } from '@/utils/api';
import { useTrendsStore } from '@/stores/trendsStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@/utils/api', () => ({ api: { get: jest.fn() } }));

type TrendResponse = { data: { trending: { name: string }[] } };

function deferred() {
  let resolve!: (value: TrendResponse) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<TrendResponse>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: (name: string) => resolve({ data: { trending: [{ name }] } }),
    reject,
  };
}

const get = api.get as jest.Mock;
const names = () => useTrendsStore.getState().trends.map((trend) => trend.text);
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  useTrendsStore.getState().resetViewerState();
  useTrendsStore.setState({ readerLanguages: [] });
  get.mockReset();
});

it('does not let an earlier response replace a later successful read', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends({ silent: true });

  recent.resolve('new');
  await second;
  old.resolve('old');
  await first;
  expect(names()).toEqual(['new']);
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('does not show an old error after a later read succeeded', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends({ silent: true });

  recent.resolve('new');
  await second;
  old.reject(new Error('old failure'));
  await first;
  expect(names()).toEqual(['new']);
  expect(useTrendsStore.getState().error).toBeNull();
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('can use an earlier successful read if the later read fails', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends();

  recent.reject(new Error('offline'));
  await second;
  old.resolve('available');
  await first;
  expect(names()).toEqual(['available']);
  expect(useTrendsStore.getState().error).toBe('offline');
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('shows an earlier success while a later request is pending', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends({ silent: true });

  old.resolve('available');
  await first;
  expect(names()).toEqual(['available']);
  recent.resolve('new');
  await second;
  expect(names()).toEqual(['new']);
});

it('clears an earlier visible error when a later silent refresh succeeds', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends({ silent: true });

  old.reject(new Error('old failure'));
  await first;
  expect(useTrendsStore.getState().error).toBe('old failure');
  recent.resolve('new');
  await second;
  expect(names()).toEqual(['new']);
  expect(useTrendsStore.getState().error).toBeNull();
});

it('clears an earlier error even when a later successful list is unchanged', async () => {
  get.mockResolvedValueOnce({ data: { trending: [{ name: 'same' }] } });
  await useTrendsStore.getState().fetchTrends();
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends({ silent: true });

  old.reject(new Error('old failure'));
  await first;
  recent.resolve('same');
  await second;
  expect(names()).toEqual(['same']);
  expect(useTrendsStore.getState().error).toBeNull();
});

it('keeps the more recent visible error when two reads fail out of order', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends();

  recent.reject(new Error('recent failure'));
  await second;
  old.reject(new Error('old failure'));
  await first;
  expect(useTrendsStore.getState().error).toBe('recent failure');
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('orders a realtime refresh against the initial poll and releases both leases', async () => {
  jest.useFakeTimers();
  try {
    const old = deferred();
    const recent = deferred();
    get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
    const store = useTrendsStore.getState();
    const firstLease = store.startPolling();
    const secondLease = store.startPolling();
    store.refreshAfterUpdate();
    expect(get).toHaveBeenCalledTimes(2);

    recent.resolve('fresh');
    await settle();
    old.resolve('old');
    await settle();
    expect(names()).toEqual(['fresh']);

    store.stopPolling(firstLease);
    store.stopPolling(secondLease);
    jest.advanceTimersByTime(300_000);
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    useTrendsStore.getState().resetViewerState();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

it('discards responses from a previous language even after an ABA change', async () => {
  const firstEs = deferred();
  const french = deferred();
  const secondEs = deferred();
  get
    .mockReturnValueOnce(firstEs.promise)
    .mockReturnValueOnce(french.promise)
    .mockReturnValueOnce(secondEs.promise);
  useTrendsStore.getState().setReaderLanguages(['es']);
  const first = useTrendsStore.getState().fetchTrends();
  useTrendsStore.getState().setReaderLanguages(['fr']);
  useTrendsStore.getState().setReaderLanguages(['es']);
  expect(get.mock.calls.map((call) => call[1].lang)).toEqual(['es', 'fr', 'es']);

  secondEs.resolve('current');
  await settle();
  french.resolve('fr');
  firstEs.resolve('old');
  await first;
  await settle();
  expect(names()).toEqual(['current']);
});

it('discards a previous viewer response after account ABA resets', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  useTrendsStore.getState().resetViewerState();
  useTrendsStore.getState().resetViewerState();
  const second = useTrendsStore.getState().fetchTrends();

  recent.resolve('current');
  await second;
  old.resolve('old');
  await first;
  expect(names()).toEqual(['current']);
});
