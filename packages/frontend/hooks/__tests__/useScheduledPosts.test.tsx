import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { HydratedPost } from '@mention/shared-types';

/**
 * The scheduled-post queue is the one composer surface that lives on the SERVER
 * while its neighbour (drafts) lives on the device, and the ways that goes wrong
 * are all invisible from reading the code:
 *
 *  1. Nobody calls the endpoint. That is the bug this hook exists to fix, so the
 *     request itself is asserted, by path.
 *  2. The list is cached on a key that is not viewer-scoped, and B is served A's
 *     unpublished posts after an account switch. The key is asserted directly,
 *     and a second viewer must not read the first one's answer.
 *  3. The client re-derives what the server already resolved. `GET /posts/scheduled`
 *     now serves the SAME hydrated DTO the feed gets, precisely so the preview can
 *     render through the feed's own `PostItem`; a hook that reshaped it would
 *     reintroduce the drift the hydration change removed. The DTO is asserted to
 *     arrive untouched.
 *
 * The real `QueryClient` runs here — only the HTTP boundary and the SDK modules
 * that ship untranspiled TS are mocked, so the cache key, the enablement gate
 * and the post-cancel cache write are the code under test.
 */

const mockGet = jest.fn();
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
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

jest.mock('@oxyhq/services/ui/client', () => ({ useAuth: () => mockAuth }));

import { useScheduledPosts } from '../useScheduledPosts';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { scheduledPostFixture } from '@/__fixtures__/scheduledPost';

type Hook = ReturnType<typeof useScheduledPosts>;
let latest: Hook | null = null;

function Probe() {
  latest = useScheduledPosts();
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
  // `gcTime: 0` on BOTH matters: a settled query or mutation is otherwise held
  // for the default five minutes, and that timer outlives the run and keeps
  // jest's worker open.
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

/** Re-render the SAME tree, the way a changing auth context does. */
function rerender(client: QueryClient) {
  act(() => {
    renderer?.update(tree(client));
  });
}

/**
 * Advance the world until `predicate` holds.
 *
 * CONDITION-based on purpose. The previous helper here flushed a FIXED number of
 * ticks (one microtask + one macrotask) and then let the assertions run, which
 * made every case in this file a race: react-query resolves a query across
 * several ticks and notifies its subscribers on a MACROtask, so on a slower or
 * more contended machine the probe had simply not re-rendered yet and the value
 * under assertion read `undefined`. It passed locally and took CI red.
 *
 * The iteration cap is a FAILURE ceiling, not the wait — it exists so a
 * condition that never becomes true reports itself by name instead of hanging
 * until jest's timeout, and it is far beyond what any of these cases need. What
 * makes the test deterministic is that nothing after the call runs until the
 * condition is actually true.
 */
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

/** The ids the hook is currently handing its caller. */
function renderedIds(): string[] {
  return (latest?.scheduledPosts ?? []).map((post) => post.id);
}

/** React-query's own verdict for one viewer's entry — the thing to key a wait
 *  on when the expected result is EMPTY and no rendered value can signal it. */
function queryStatus(client: QueryClient, viewerId: string): string | undefined {
  return client.getQueryState(viewerQueryKeys.scheduledPosts(viewerId))?.status;
}

/** The ids sitting in one viewer's cache entry. */
function cachedIds(client: QueryClient, viewerId: string): string[] | undefined {
  return client
    .getQueryData<HydratedPost[]>(viewerQueryKeys.scheduledPosts(viewerId))
    ?.map((post) => post.id);
}

const HYDRATED_POSTS = [
  scheduledPostFixture({ id: 'post-soon', scheduledFor: new Date('2026-08-02T09:30:00.000Z') }),
  scheduledPostFixture({ id: 'post-poll', scheduledFor: new Date('2026-08-05T18:00:00.000Z') }),
];

describe('useScheduledPosts', () => {
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
    mockGet.mockResolvedValue({ data: { posts: HYDRATED_POSTS } });
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

  it('reads GET /posts/scheduled and caches it under the viewer-scoped key', async () => {
    const client = renderProbe();
    await waitUntil(
      () => cachedIds(client, 'viewer-1')?.length === 2,
      "viewer-1's queue to land in the cache",
    );

    expect(mockGet).toHaveBeenCalledWith('/posts/scheduled');
    expect(cachedIds(client, 'viewer-1')).toEqual(['post-soon', 'post-poll']);
    // Spelled out, so renaming the factory cannot quietly move the key back into
    // a shared namespace while the assertion above still passes.
    expect(viewerQueryKeys.scheduledPosts('viewer-1')).toEqual([
      'viewer',
      'viewer-1',
      'posts',
      'scheduled',
    ]);
  });

  it('serves the hydrated DTO through untouched, so the preview renders the real post', async () => {
    renderProbe();
    await waitUntil(() => renderedIds().length === 2, 'the queue to reach the caller');

    // Identity, not deep-equality: any client-side reshaping would produce a new
    // object here and quietly become a second, drifting source of truth for what
    // a post looks like.
    expect(latest!.scheduledPosts[0]).toBe(HYDRATED_POSTS[0]);
    expect(latest!.scheduledPosts[0].content.text).toBe('Ship the scheduled queue');
    expect(latest!.scheduledPosts[0].user.username).toBe('author');
  });

  it('tolerates a response with no posts array instead of rendering undefined', async () => {
    mockGet.mockResolvedValue({ data: {} });

    const client = renderProbe();
    // The expected result is empty, so no rendered value can mark the arrival —
    // key the wait off the query's own status instead of a tick count.
    await waitUntil(() => queryStatus(client, 'viewer-1') === 'success', 'the read to succeed');

    expect(latest!.scheduledPosts).toEqual([]);
  });

  it('does not read the private endpoint while the bearer is unusable, and reads once it lands', async () => {
    mockAuth.user = null;
    mockAuth.isAuthenticated = false;
    mockAuth.canUsePrivateApi = false;

    const client = renderProbe();
    expect(latest!.scheduledPosts).toEqual([]);

    // The session resolves — the same thing a slow cold boot does.
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.isAuthenticated = true;
    mockAuth.canUsePrivateApi = true;
    rerender(client);
    await waitUntil(() => mockGet.mock.calls.length > 0, 'the read to fire once the session lands');

    // EXACTLY one: a read that had also fired while anonymous would show two
    // here. Asserting the absence directly could only ever be a race, because a
    // request that has not happened yet is indistinguishable from one that never
    // will.
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith('/posts/scheduled');
  });

  it('never serves one viewer the queue cached for another', async () => {
    const client = renderProbe();
    await waitUntil(() => renderedIds().length === 2, "viewer-1's queue");

    mockGet.mockResolvedValue({ data: { posts: [] } });
    mockAuth.user = { id: 'viewer-2' };
    rerender(client);
    await waitUntil(
      () => queryStatus(client, 'viewer-2') === 'success',
      "viewer-2's own read to succeed",
    );

    // B reads its OWN key rather than inheriting the two posts already cached
    // for A, which is the whole point of the viewer prefix.
    expect(viewerQueryKeys.scheduledPosts('viewer-2')).not.toEqual(
      viewerQueryKeys.scheduledPosts('viewer-1'),
    );
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(latest!.scheduledPosts).toEqual([]);
  });

  it('cancels through DELETE /posts/:id and revalidates against the server', async () => {
    const client = renderProbe();
    await waitUntil(() => renderedIds().length === 2, 'the queue to load');

    // The server now holds only the other post.
    mockGet.mockResolvedValue({ data: { posts: [HYDRATED_POSTS[1]] } });

    await act(async () => {
      await latest!.cancelScheduledPost('post-soon');
    });
    await waitUntil(
      () => mockGet.mock.calls.length === 2 && queryStatus(client, 'viewer-1') === 'success',
      'the revalidating read to come back',
    );

    expect(mockDelete).toHaveBeenCalledWith('/posts/post-soon');
    expect(cachedIds(client, 'viewer-1')).toEqual(['post-poll']);
  });

  it('removes the cancelled row before the revalidating read answers', async () => {
    const client = renderProbe();
    await waitUntil(() => renderedIds().length === 2, 'the queue to load');

    // The revalidation never comes back, so the local cache write is the ONLY
    // thing that can take the row off screen. Without it the user watches a
    // cancelled post sit in the list until the network decides otherwise — and
    // this wait would run out its ceiling and say so.
    mockGet.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await latest!.cancelScheduledPost('post-soon');
    });
    await waitUntil(
      () => cachedIds(client, 'viewer-1')?.length === 1,
      'the cancelled row to leave the cache without the network',
    );

    expect(cachedIds(client, 'viewer-1')).toEqual(['post-poll']);
  });

  it('surfaces a failed cancel to the caller and keeps the row', async () => {
    mockDelete.mockRejectedValue(new Error('404 from the API'));
    const client = renderProbe();
    await waitUntil(() => renderedIds().length === 2, 'the queue to load');

    await act(async () => {
      await expect(latest!.cancelScheduledPost('post-soon')).rejects.toThrow('404 from the API');
    });

    // Nothing to wait for: the rejection is already awaited, and the cache write
    // lives in `onSuccess`, which a rejected mutation never runs.
    // A row the server refused to delete must stay visible — silently dropping
    // it would tell the user a post was cancelled when it will still publish.
    expect(cachedIds(client, 'viewer-1')).toEqual(['post-soon', 'post-poll']);
  });
});
