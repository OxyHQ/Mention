import { Profiler } from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { TrendsWidget } from '../TrendsWidget';
import { useTrendsStore } from '@/stores/trendsStore';
import { api } from '@/utils/api';

const mockNavigateToTrend = jest.fn();
const mockPush = jest.fn();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { removeItem: () => Promise.resolve() },
}));
jest.mock('@/utils/api', () => ({ api: { get: jest.fn() } }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/theme', () => ({
  useTheme: () => ({ colors: { textSecondary: '#777' } }),
}));
jest.mock('@oxy.so/bloom/skeleton', () => ({ Box: 'skeleton-box' }));
jest.mock('@oxy.so/bloom/typography', () => ({ Text: 'text' }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'button' }));
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('@/hooks/useTrendNavigation', () => ({
  useTrendNavigation: () => ({ navigateToTrend: mockNavigateToTrend }),
}));
jest.mock('@/hooks/useTrendItemMenu', () => ({ useTrendItemMenu: () => jest.fn() }));
jest.mock('../BaseWidget', () => ({ BaseWidget: 'widget' }));
jest.mock('@/components/trending/TrendItemRow', () => ({
  TrendItemRow: 'trend-row',
  TrendItemRowSkeleton: 'trend-skeleton',
}));

const trendResponse = (summary: string) => ({
  data: { trending: [{ name: 'fixture', type: 'hashtag', score: 1, volume: 2 }], summary },
});
let renderer: ReactTestRenderer | undefined;
let commits: number;

beforeEach(() => {
  useTrendsStore.getState().resetViewerState();
  jest.mocked(api.get).mockReset();
  mockNavigateToTrend.mockReset();
  mockPush.mockReset();
  commits = 0;
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  useTrendsStore.getState().resetViewerState();
  jest.useRealTimers();
});

function screen() {
  if (!renderer) throw new Error('TrendsWidget is not mounted');
  return renderer;
}

function mount() {
  act(() => {
    renderer = TestRenderer.create(
      <Profiler id="trends" onRender={() => commits++}>
        <TrendsWidget />
      </Profiler>,
    );
  });
}

it('retains loading, changes and hidden trends while skipping an unchanged refresh', async () => {
  let resolveInitial!: (value: ReturnType<typeof trendResponse>) => void;
  jest.mocked(api.get).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveInitial = resolve;
    }),
  );
  const start = useTrendsStore.getState().startPolling;
  const stop = useTrendsStore.getState().stopPolling;
  mount();
  expect(screen().root.findAll((node) => String(node.type) === 'trend-skeleton').length).toBe(5);
  await act(async () => {
    resolveInitial(trendResponse('Initial summary'));
    await Promise.resolve();
  });
  expect(JSON.stringify(screen().toJSON())).toContain('Initial summary');
  expect(
    screen()
      .root.findAll((node) => String(node.type) === 'trend-row')
      .map((row) => row.props.trend.text),
  ).toEqual(['fixture']);
  const row = screen().root.find((node) => String(node.type) === 'trend-row');
  act(() => row.props.onPress(row.props.trend));
  expect(mockNavigateToTrend).toHaveBeenCalledWith(row.props.trend, 'widget', 1);
  act(() => screen().root.findByType('button').props.onPress());
  expect(mockPush).toHaveBeenCalledWith('/explore/trending');

  let resolveRefresh!: (value: ReturnType<typeof trendResponse>) => void;
  jest.mocked(api.get).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveRefresh = resolve;
    }),
  );
  const before = commits;
  let refresh!: Promise<void>;
  act(() => {
    refresh = useTrendsStore.getState().fetchTrends();
  });
  expect(useTrendsStore.getState().isLoading).toBe(true);
  expect(commits).toBe(before);
  await act(async () => {
    resolveRefresh(trendResponse('Initial summary'));
    await refresh;
  });
  expect(commits).toBe(before);
  expect(useTrendsStore.getState().startPolling).toBe(start);
  expect(useTrendsStore.getState().stopPolling).toBe(stop);

  jest.mocked(api.get).mockResolvedValueOnce(trendResponse('Updated summary'));
  await act(async () => {
    await useTrendsStore.getState().fetchTrends();
  });
  expect(JSON.stringify(screen().toJSON())).toContain('Updated summary');
  expect(api.get).toHaveBeenCalledTimes(3);
  act(() => useTrendsStore.getState().hideTrend('hashtag:fixture'));
  expect(screen().toJSON()).toBeNull();
});

it('settles an initial error and retains visible trends on a later error', async () => {
  jest.mocked(api.get).mockRejectedValueOnce(new Error('offline'));
  mount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(useTrendsStore.getState().error).toBe('offline');
  expect(screen().toJSON()).toBeNull();
  jest.mocked(api.get).mockResolvedValueOnce(trendResponse('Recovered'));
  await act(async () => {
    await useTrendsStore.getState().fetchTrends();
  });
  expect(JSON.stringify(screen().toJSON())).toContain('Recovered');
  jest.mocked(api.get).mockRejectedValueOnce(new Error('offline again'));
  await act(async () => {
    await useTrendsStore.getState().fetchTrends();
  });
  expect(JSON.stringify(screen().toJSON())).toContain('Recovered');
});

it('keeps the shared poll alive for a second surface when the widget unmounts', async () => {
  jest.useFakeTimers();
  jest.mocked(api.get).mockResolvedValue(trendResponse('Polling'));
  mount();
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.get).toHaveBeenCalledTimes(1);
  const pageSubscription = useTrendsStore.getState().startPolling();
  expect(api.get).toHaveBeenCalledTimes(1);
  act(() => {
    screen().unmount();
    renderer = undefined;
  });
  await act(async () => {
    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
  });
  expect(api.get).toHaveBeenCalledTimes(2);
  useTrendsStore.getState().stopPolling(pageSubscription);
  await act(async () => {
    jest.advanceTimersByTime(300_000);
    await Promise.resolve();
  });
  expect(api.get).toHaveBeenCalledTimes(2);
});
