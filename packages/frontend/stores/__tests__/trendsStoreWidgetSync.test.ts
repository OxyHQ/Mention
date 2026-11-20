import { useTrendsStore } from '@/stores/trendsStore';
import { api } from '@/utils/api';
import { syncTrendsWidget } from '@/modules/mention-widgets/trendsWidgetSync';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: () => Promise.resolve() },
}));

jest.mock('@/utils/api', () => ({
  api: { get: jest.fn() },
}));

jest.mock('@/modules/mention-widgets/trendsWidgetSync', () => ({
  syncTrendsWidget: jest.fn(),
}));

beforeEach(() => {
  useTrendsStore.getState().resetViewerState();
  useTrendsStore.setState({ readerLanguages: [] });
  jest.clearAllMocks();
});

it('hands every fetched batch token to the trends widget sync', async () => {
  (api.get as jest.Mock).mockResolvedValueOnce({
    data: { trending: [{ name: 'mention' }], recId: 'batch-7' },
  });

  await useTrendsStore.getState().fetchTrends();

  expect(syncTrendsWidget).toHaveBeenCalledWith('batch-7');
});

it('does not nudge the widget for a response that arrived after the reader moved on', async () => {
  let resolveOld: (response: unknown) => void = () => {
    throw new Error('Old request was not started');
  };
  (api.get as jest.Mock)
    .mockReturnValueOnce(new Promise((resolve) => (resolveOld = resolve)))
    .mockResolvedValueOnce({ data: { trending: [], recId: 'batch-new' } });
  const oldRequest = useTrendsStore.getState().fetchTrends();
  useTrendsStore.getState().setReaderLanguages(['es']);
  await Promise.resolve();
  resolveOld({ data: { trending: [], recId: 'batch-old' } });
  await oldRequest;

  expect(syncTrendsWidget).not.toHaveBeenCalledWith('batch-old');
});
