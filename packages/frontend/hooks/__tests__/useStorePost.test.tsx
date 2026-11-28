import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * `useStorePost` reads the shared posts store and asks the network only when the
 * store has no copy — or always, for a surface that needs fresh viewer state.
 */

const mockCached = new Map<string, { id: string }>();
const mockGetPostById = jest.fn(async (id: string) => ({ id }));
const mockRevalidatePostById = jest.fn(async (id: string) => ({ id }));

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: { id: 'viewer-1' } }) }));
jest.mock('@/stores/postsStore', () => ({
  usePostSelector: (id: string | undefined) => (id ? (mockCached.get(id) ?? null) : null),
  usePostsStore: {
    getState: () => ({
      getPostById: mockGetPostById,
      revalidatePostById: mockRevalidatePostById,
    }),
  },
}));

import { useStorePost } from '../useStorePost';

function Probe({ postId, fresh }: { postId: string; fresh?: boolean }) {
  useStorePost(postId, { fresh });
  return null;
}

async function render(postId: string, fresh?: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe postId={postId} fresh={fresh} />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => renderer.unmount());
  client.clear();
}

describe('useStorePost', () => {
  beforeEach(() => {
    mockCached.clear();
    jest.clearAllMocks();
  });

  it('loads a post the store does not have', async () => {
    await render('missing');
    expect(mockGetPostById).toHaveBeenCalledWith('missing');
  });

  it('asks nothing for a cached post, unless the surface needs it fresh', async () => {
    mockCached.set('cached', { id: 'cached' });
    await render('cached');
    expect(mockGetPostById).not.toHaveBeenCalled();

    await render('cached', true);
    expect(mockRevalidatePostById).toHaveBeenCalledWith('cached');
  });
});
