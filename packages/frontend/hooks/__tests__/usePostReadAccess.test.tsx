import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePostReadAccess } from '../usePostReadAccess';

const mockRevalidate = jest.fn();
const mockAuth = { user: { id: 'child' } };
const mockSupervision = { ready: true, supervised: true, isError: false, refetch: jest.fn() };
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('../useSupervisionState', () => ({ useSupervisionState: () => mockSupervision }));
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: { getState: () => ({ revalidatePostById: mockRevalidate }) },
}));
let renderer: ReactTestRenderer;
let queryClient: QueryClient;
let result: ReturnType<typeof usePostReadAccess>;
function Probe() {
  result = usePostReadAccess('cached-post');
  return result.allowed ? <span>cached content</span> : null;
}
const tree = () => (
  <QueryClientProvider client={queryClient}>
    <Probe />
  </QueryClientProvider>
);
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
beforeEach(() => {
  mockAuth.user = { id: 'child' };
  Object.assign(mockSupervision, { ready: true, supervised: true, isError: false });
  mockRevalidate.mockReset();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  act(() => renderer?.unmount());
  queryClient.clear();
});

it('keeps warm cached content hidden when current supervised authority fails', async () => {
  mockRevalidate.mockResolvedValueOnce(null);
  act(() => {
    renderer = TestRenderer.create(tree());
  });
  expect(renderer.toJSON()).toBeNull();
  await flush();
  expect(result.failed).toBe(true);
  expect(renderer.toJSON()).toBeNull();
});
it('permits ordinary offline cached reading after central state identifies an adult', async () => {
  mockSupervision.supervised = false;
  mockRevalidate.mockRejectedValue(new Error('503'));
  act(() => {
    renderer = TestRenderer.create(tree());
  });
  await flush();
  expect(result.allowed).toBe(true);
  expect(mockRevalidate).not.toHaveBeenCalled();
});
it('hides retained success during a refresh and after a failed fresh decision', async () => {
  mockRevalidate.mockResolvedValueOnce({ id: 'cached-post' });
  act(() => {
    renderer = TestRenderer.create(tree());
  });
  await flush();
  expect(result.allowed).toBe(true);
  mockRevalidate.mockResolvedValueOnce(null);
  await act(async () => {
    await result.retry();
  });
  await flush();
  expect(result.allowed).toBe(false);
  expect(renderer.toJSON()).toBeNull();
});
it('never carries an adult cached allowance into a supervised account switch', async () => {
  mockAuth.user = { id: 'adult' };
  mockSupervision.supervised = false;
  act(() => {
    renderer = TestRenderer.create(tree());
  });
  await flush();
  expect(result.allowed).toBe(true);
  mockAuth.user = { id: 'child' };
  mockSupervision.ready = false;
  act(() => renderer.update(tree()));
  expect(result.allowed).toBe(false);
  mockSupervision.ready = true;
  mockSupervision.supervised = true;
  mockRevalidate.mockResolvedValueOnce(null);
  act(() => renderer.update(tree()));
  await flush();
  expect(renderer.toJSON()).toBeNull();
});
