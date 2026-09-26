import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HydratedPost } from '@mention/shared-types';

/**
 * The drafts saved to the viewer's ACCOUNT — posts an automation stored with
 * `status: 'draft'` — as the composer's drafts tab reads and acts on them.
 *
 * Asserted against a real `QueryClient`, with only the HTTP boundary and the SDK
 * auth hook mocked, the same way `useScheduledPosts.test.tsx` is:
 *
 *  1. The read is `GET /posts/drafts`, cached on a VIEWER-scoped key and not
 *     fired before a usable bearer exists.
 *  2. Publishing is `POST /posts/:id/publish` — the route the server runs a
 *     draft through the scheduled pipeline on — and the row leaves the list.
 *  3. A refused publish keeps the row: dropping it would tell the person the
 *     draft went out when it did not.
 */

const mockGet = jest.fn();
const mockPost = jest.fn();
const mockDelete = jest.fn();

const mockAuth: {
  user: { id: string } | null;
  isAuthenticated: boolean;
  canUsePrivateApi: boolean;
} = {
  user: { id: 'viewer-1' },
  isAuthenticated: true,
  canUsePrivateApi: true,
};

jest.mock('@/utils/api', () => ({
  api: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));

import { useServerDrafts } from '../useServerDrafts';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { scheduledPostFixture } from '@/__fixtures__/scheduledPost';

type Hook = ReturnType<typeof useServerDrafts>;
let latest: Hook | null = null;

function Probe() {
  latest = useServerDrafts();
  return null;
}

const clients: QueryClient[] = [];
let renderer: TestRenderer.ReactTestRenderer | null = null;

function tree(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>
  );
}

function renderProbe() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  clients.push(client);
  act(() => {
    renderer = TestRenderer.create(tree(client));
  });
  return client;
}

function rerender(client: QueryClient) {
  act(() => {
    renderer?.update(tree(client));
  });
}

/** Condition-based, for the reason spelled out in `useScheduledPosts.test.tsx`. */
async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const FAILURE_CEILING = 500;
  for (let attempt = 0; attempt < FAILURE_CEILING; attempt += 1) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error(`waitUntil never saw: ${description}`);
}

function cachedIds(client: QueryClient): string[] | undefined {
  return client
    .getQueryData<HydratedPost[]>(viewerQueryKeys.serverDrafts('viewer-1'))
    ?.map((post) => post.id);
}

const DRAFTS = [
  scheduledPostFixture({ id: 'draft-release-notes' }),
  scheduledPostFixture({ id: 'draft-older' }),
];

describe('useServerDrafts', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    latest = null;
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.isAuthenticated = true;
    mockAuth.canUsePrivateApi = true;
    mockGet.mockResolvedValue({ data: { posts: DRAFTS } });
    mockPost.mockResolvedValue({ data: DRAFTS[0] });
    mockDelete.mockResolvedValue({ data: { message: 'Post deleted successfully' } });
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
    for (const client of clients.splice(0)) {
      client.cancelQueries();
      client.clear();
      client.unmount();
    }
  });

  it('reads GET /posts/drafts under the viewer-scoped key', async () => {
    const client = renderProbe();
    // The cache fills a render before the hook returns it, so wait for both.
    await waitUntil(
      () => cachedIds(client)?.length === 2 && latest?.serverDrafts.length === 2,
      'the drafts to land in the cache and reach the hook',
    );

    expect(mockGet).toHaveBeenCalledWith('/posts/drafts');
    expect(viewerQueryKeys.serverDrafts('viewer-1')).toEqual(['viewer', 'viewer-1', 'posts', 'drafts']);
    // The hydrated DTO arrives untouched, so the preview renders the real post.
    expect(latest!.serverDrafts[0]).toBe(DRAFTS[0]);
  });

  it('does not read the private endpoint before the bearer is usable', async () => {
    mockAuth.canUsePrivateApi = false;
    const client = renderProbe();
    expect(latest!.serverDrafts).toEqual([]);

    mockAuth.canUsePrivateApi = true;
    rerender(client);
    await waitUntil(() => mockGet.mock.calls.length > 0, 'the read to fire once the bearer lands');

    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('publishes through POST /posts/:id/publish and drops the row', async () => {
    const client = renderProbe();
    await waitUntil(() => cachedIds(client)?.length === 2, 'the drafts to load');
    // The revalidation never answers, so only the local write can drop the row.
    mockGet.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await latest!.publishServerDraft('draft-release-notes');
    });
    await waitUntil(() => cachedIds(client)?.length === 1, 'the published row to leave the cache');

    expect(mockPost).toHaveBeenCalledWith('/posts/draft-release-notes/publish');
    expect(cachedIds(client)).toEqual(['draft-older']);
  });

  it('deletes through DELETE /posts/:id and drops the row', async () => {
    const client = renderProbe();
    await waitUntil(() => cachedIds(client)?.length === 2, 'the drafts to load');
    mockGet.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await latest!.deleteServerDraft('draft-older');
    });
    await waitUntil(() => cachedIds(client)?.length === 1, 'the deleted row to leave the cache');

    expect(mockDelete).toHaveBeenCalledWith('/posts/draft-older');
    expect(cachedIds(client)).toEqual(['draft-release-notes']);
  });

  it('takes the row off OPTIMISTICALLY, before the server has answered', async () => {
    const client = renderProbe();
    await waitUntil(() => cachedIds(client)?.length === 2, 'the drafts to load');
    mockPost.mockReturnValue(new Promise(() => {}));

    act(() => {
      void latest!.publishServerDraft('draft-release-notes');
    });
    await waitUntil(() => cachedIds(client)?.length === 1, 'the row to leave while the publish is in flight');

    expect(cachedIds(client)).toEqual(['draft-older']);
  });

  it('surfaces a refused publish and puts the row back', async () => {
    mockPost.mockRejectedValue(new Error('409 from the API'));
    const client = renderProbe();
    await waitUntil(() => cachedIds(client)?.length === 2, 'the drafts to load');

    await act(async () => {
      await expect(latest!.publishServerDraft('draft-release-notes')).rejects.toThrow('409 from the API');
    });

    expect(cachedIds(client)).toEqual(['draft-release-notes', 'draft-older']);
  });
});
