import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PostInsightsSheet from '../PostInsightsSheet';
import { insightsService } from '@/services/insightsService';

let mockViewer = 'viewer-a';
let mockPrivateApi = false;
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: mockViewer }, canUsePrivateApi: mockPrivateApi }),
}));
jest.mock('@/services/insightsService', () => ({
  insightsService: { getPostInsights: jest.fn() },
}));
jest.mock('@/services/commerceService', () => ({ commerceService: { metrics: jest.fn() } }));
jest.mock('@/stores/postsStore', () => ({ usePostSelector: () => undefined }));
jest.mock('@oxy.so/bloom/page-header', () => ({ PageHeader: 'PageHeader' }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/bloom/chart-cards', () => ({
  BarListCard: 'BarListCard',
  ChartCardSurface: 'ChartCardSurface',
  ChartHeadline: 'ChartHeadline',
  ChartStatTiles: 'ChartStatTiles',
}));
jest.mock('@/components/loading/ContentSkeleton', () => ({ InsightsSkeleton: 'InsightsSkeleton' }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: 'EmptyState' }));

it('keeps private analytics disabled until the session is ready and partitions cache by viewer', async () => {
  const getInsights = jest.mocked(insightsService.getPostInsights);
  getInsights.mockReset();
  getInsights.mockImplementation(
    async () =>
      ({
        stats: {
          views: mockViewer === 'viewer-a' ? 100 : 200,
          likes: 1,
          replies: 2,
          boosts: 0,
          shares: 0,
          quotes: 0,
        },
        engagement: { totalInteractions: 3, engagementRate: 3, reach: 0 },
      }) as Awaited<ReturnType<typeof insightsService.getPostInsights>>,
  );
  mockViewer = 'viewer-a';
  mockPrivateApi = false;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <PostInsightsSheet postId="post-1" onClose={jest.fn()} />
    </QueryClientProvider>
  );
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = TestRenderer.create(tree());
  });
  expect(getInsights).not.toHaveBeenCalled();
  mockPrivateApi = true;
  await act(async () => {
    renderer?.update(tree());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(getInsights).toHaveBeenCalledTimes(1);
  mockViewer = 'viewer-b';
  await act(async () => {
    renderer?.update(tree());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(getInsights).toHaveBeenCalledTimes(2);
  expect(getInsights).toHaveBeenLastCalledWith('post-1');
  const populated = client
    .getQueryCache()
    .getAll()
    .filter((query) => query.state.data !== undefined);
  expect(populated).toHaveLength(2);
  await act(async () => renderer?.unmount());
  client.clear();
});
