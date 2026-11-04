import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PrivateMentionConversation } from '@mention/shared-types';
import { waitUntil } from '@/test-support/waitUntil';

/**
 * The private-mentions inbox: it pages the server's opaque cursor, reads nothing
 * before a usable bearer exists, and warms every participant in one batch. Only
 * the HTTP boundary and the user batch are mocked; the real QueryClient runs.
 */

const mockGet = jest.fn();
const mockPrewarm = jest.fn();
const mockAuth = {
  user: { id: 'viewer-1' } as { id: string } | null,
  canUsePrivateApi: true,
  oxyServices: { users: { getMany: jest.fn() } },
};

jest.mock('@/utils/api', () => ({
  api: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock('@/utils/userEnrichment', () => ({
  prewarmUsersByIds: (...args: unknown[]) => mockPrewarm(...args),
}));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));

import { usePrivateMentionConversations } from '../usePrivateMentionConversations';

type Hook = ReturnType<typeof usePrivateMentionConversations>;
let latest: Hook | null = null;
let renderer: TestRenderer.ReactTestRenderer | null = null;
let client: QueryClient;

function Probe() {
  latest = usePrivateMentionConversations();
  return null;
}

function conversation(rootId: string, participantIds: string[]): PrivateMentionConversation {
  return {
    rootId,
    lastActivityAt: '2026-11-01T00:00:00.000Z',
    postCount: 1,
    participantIds,
    latestPost: { id: rootId } as PrivateMentionConversation['latestPost'],
  };
}

function render() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

const rootIds = () => (latest?.conversations ?? []).map((item) => item.rootId);

describe('usePrivateMentionConversations', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    latest = null;
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.canUsePrivateApi = true;
    mockPrewarm.mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = null;
    client.clear();
  });

  it('pages the cursor and warms the participants in one batch', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: { items: [conversation('a', ['u1', 'u2'])], hasMore: true, nextCursor: 'c1' },
      })
      .mockResolvedValueOnce({
        data: { items: [conversation('b', ['u2', 'u3'])], hasMore: false },
      });

    render();
    await waitUntil(() => rootIds().length === 1, 'the first page');
    expect(mockGet).toHaveBeenCalledWith('/posts/private-mentions', undefined);
    expect(latest?.hasNextPage).toBe(true);

    act(() => latest?.loadMore());
    await waitUntil(() => rootIds().length === 2, 'the second page');
    expect(mockGet).toHaveBeenLastCalledWith('/posts/private-mentions', { cursor: 'c1' });
    expect(rootIds()).toEqual(['a', 'b']);
    expect(latest?.hasNextPage).toBe(false);

    await waitUntil(
      () => mockPrewarm.mock.calls.some(([ids]) => (ids as string[]).length === 3),
      'every participant to be warmed',
    );
    expect(mockPrewarm.mock.calls.at(-1)?.[0]).toEqual(['u1', 'u2', 'u3']);
  });

  it('reads nothing until the private API is usable', () => {
    mockAuth.user = null;
    mockAuth.canUsePrivateApi = false;

    render();

    expect(mockGet).not.toHaveBeenCalled();
    expect(latest?.conversations).toEqual([]);
    expect(latest?.isLoading).toBe(false);
  });
});
