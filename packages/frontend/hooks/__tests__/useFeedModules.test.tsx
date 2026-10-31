import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import TestRenderer, { act } from 'react-test-renderer';
import { useFeedModules } from '../useFeedModules';

const mockGet = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: { get: (...args: unknown[]) => mockGet(...args) },
}));

function Probe({ enabled }: { enabled: boolean }) {
  useFeedModules(enabled);
  return null;
}

it('reads the catalog only once a usable session enables the builder', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mockGet.mockResolvedValue({ data: { sources: [], filters: [], signals: [] } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rendered: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  await act(async () => {
    rendered.current = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe enabled={false} />
      </QueryClientProvider>,
    );
  });
  const renderer = rendered.current;
  if (!renderer) throw new Error('Feed module probe did not render');
  expect(mockGet).not.toHaveBeenCalled();

  await act(async () => {
    renderer.update(
      <QueryClientProvider client={client}>
        <Probe enabled />
      </QueryClientProvider>,
    );
  });
  expect(mockGet).toHaveBeenCalledTimes(1);
  expect(mockGet).toHaveBeenCalledWith('/feed/modules');
  act(() => renderer.unmount());
  client.clear();
});
