import { useTrendsStore } from '@/stores/trendsStore';
import { api } from '@/utils/api';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: () => Promise.resolve() },
}));

jest.mock('@/utils/api', () => ({
  api: { get: jest.fn(() => Promise.resolve({ data: { trending: [], summary: '' } })) },
}));

beforeEach(() => {
  useTrendsStore.getState().resetViewerState();
  useTrendsStore.setState({ readerLanguages: [] });
  jest.clearAllMocks();
});

it('keeps the reader languages in their order of preference', () => {
  useTrendsStore.getState().setReaderLanguages(['es-ES', 'en-US', 'ca-ES', 'es-ES']);
  expect(useTrendsStore.getState().readerLanguages).toEqual(['es-ES', 'en-US', 'ca-ES']);
});

it('does not fetch trends on startup until a surface requests them', async () => {
  useTrendsStore.getState().setReaderLanguages(['es']);
  expect(api.get).not.toHaveBeenCalled();
  await useTrendsStore.getState().fetchTrends();
  expect(api.get).toHaveBeenCalledWith('/trending', { limit: 10, lang: 'es' });
});

it('retries a previous failed read when the language changes', async () => {
  (api.get as jest.Mock).mockRejectedValueOnce(new Error('offline'));
  await useTrendsStore.getState().fetchTrends();
  expect(useTrendsStore.getState().error).toBe('offline');
  useTrendsStore.getState().setReaderLanguages(['es']);
  await Promise.resolve();
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(useTrendsStore.getState().hasFetched).toBe(true);
});

it('keeps a slower response for the previous language from replacing the new list', async () => {
  type Response = { data: { trending: { name: string }[] } };
  let resolveOld!: (response: Response) => void;
  let resolveNew!: (response: Response) => void;
  (api.get as jest.Mock)
    .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveOld = resolve)))
    .mockReturnValueOnce(new Promise<Response>((resolve) => (resolveNew = resolve)));
  const oldRequest = useTrendsStore.getState().fetchTrends();
  useTrendsStore.getState().setReaderLanguages(['es']);
  expect(api.get).toHaveBeenCalledTimes(2);
  resolveNew({ data: { trending: [{ name: 'nuevo' }] } });
  await Promise.resolve();
  resolveOld({ data: { trending: [{ name: 'old' }] } });
  await oldRequest;
  expect(useTrendsStore.getState().trends.map((trend) => trend.text)).toEqual(['nuevo']);
  expect(useTrendsStore.getState().isLoading).toBe(false);
});

it('settles loading if the replacement language request fails', async () => {
  let resolveOld!: (response: { data: { trending: { name: string }[] } }) => void;
  (api.get as jest.Mock)
    .mockReturnValueOnce(new Promise((resolve) => (resolveOld = resolve)))
    .mockRejectedValueOnce(new Error('offline'));
  const oldRequest = useTrendsStore.getState().fetchTrends();
  useTrendsStore.getState().setReaderLanguages(['es']);
  await Promise.resolve();
  expect(useTrendsStore.getState().isLoading).toBe(false);
  expect(useTrendsStore.getState().error).toBe('offline');
  resolveOld({ data: { trending: [{ name: 'old' }] } });
  await oldRequest;
  expect(useTrendsStore.getState().trends).toEqual([]);
  expect(useTrendsStore.getState().error).toBe('offline');
});
