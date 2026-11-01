import { api } from '@/utils/api';
import { useTrendsStore } from '@/stores/trendsStore';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('@/utils/api', () => ({ api: { get: jest.fn() } }));

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: () => resolve({ data: { trending: [] } }), reject };
}
const get = api.get as jest.Mock;
beforeEach(() => {
  useTrendsStore.getState().resetViewerState();
  useTrendsStore.setState({ readerLanguages: [] });
  get.mockReset();
});

it('keeps loading until the latest explicit request settles', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends();
  old.resolve();
  await first;
  expect(useTrendsStore.getState().isLoading).toBe(true);
  recent.resolve();
  await second;
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('does not wait for an earlier explicit request once the latest succeeds', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends();
  recent.resolve();
  await second;
  expect(useTrendsStore.getState().isLoading).toBe(false);
  old.resolve();
  await first;
});

it('settles a superseded explicit request when a later silent read succeeds', async () => {
  const visible = deferred();
  const silent = deferred();
  get.mockReturnValueOnce(visible.promise).mockReturnValueOnce(silent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends({ silent: true });
  silent.resolve();
  await second;
  expect(useTrendsStore.getState().isLoading).toBe(false);
  visible.resolve();
  await first;
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('does not let an older silent success settle a newer explicit read', async () => {
  const silent = deferred();
  const visible = deferred();
  get.mockReturnValueOnce(silent.promise).mockReturnValueOnce(visible.promise);
  const first = useTrendsStore.getState().fetchTrends({ silent: true });
  const second = useTrendsStore.getState().fetchTrends();
  silent.resolve();
  await first;
  expect(useTrendsStore.getState().isLoading).toBe(true);
  visible.resolve();
  await second;
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('ends explicit loading even when its stale failure is ignored after silent success', async () => {
  const visible = deferred();
  const silent = deferred();
  get.mockReturnValueOnce(visible.promise).mockReturnValueOnce(silent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends({ silent: true });
  silent.resolve();
  await second;
  visible.reject(new Error('obsolete'));
  await first;
  expect(useTrendsStore.getState().isLoading).toBe(false);
  expect(useTrendsStore.getState().error).toBeNull();
});

it('does not let a pending silent read keep the indicator after explicit completion', async () => {
  const silent = deferred();
  const visible = deferred();
  get.mockReturnValueOnce(silent.promise).mockReturnValueOnce(visible.promise);
  const first = useTrendsStore.getState().fetchTrends({ silent: true });
  expect(useTrendsStore.getState().isLoading).toBe(false);
  const second = useTrendsStore.getState().fetchTrends();
  visible.resolve();
  await second;
  expect(useTrendsStore.getState().isLoading).toBe(false);
  silent.resolve();
  await first;
});

it('does not report an older explicit failure while the newer one is pending', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  const second = useTrendsStore.getState().fetchTrends();
  old.reject(new Error('obsolete'));
  await first;
  expect(useTrendsStore.getState().isLoading).toBe(true);
  expect(useTrendsStore.getState().error).toBeNull();
  recent.reject(new Error('current'));
  await second;
  expect(useTrendsStore.getState().isLoading).toBe(false);
  expect(useTrendsStore.getState().error).toBe('current');
});

it('does not let an old viewer settle the new viewer indicator', async () => {
  const old = deferred();
  const recent = deferred();
  get.mockReturnValueOnce(old.promise).mockReturnValueOnce(recent.promise);
  const first = useTrendsStore.getState().fetchTrends();
  useTrendsStore.getState().resetViewerState();
  useTrendsStore.getState().resetViewerState();
  const second = useTrendsStore.getState().fetchTrends();
  old.resolve();
  await first;
  expect(useTrendsStore.getState().isLoading).toBe(true);
  recent.resolve();
  await second;
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('keeps the indicator owned by the current language after ABA changes', async () => {
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
  firstEs.resolve();
  await first;
  expect(useTrendsStore.getState().isLoading).toBe(true);
  secondEs.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(useTrendsStore.getState().isLoading).toBe(false);
  french.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(useTrendsStore.getState().isLoading).toBe(false);
});
