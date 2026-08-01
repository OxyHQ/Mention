import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The scheduled-post queue is the one composer surface that lives on the SERVER
 * while its neighbour (drafts) lives on the device, and the three ways that goes
 * wrong are all invisible from reading the code:
 *
 *  1. Nobody calls the endpoint. That is the bug this hook exists to fix — the
 *     route has shipped and been routed for a long time with no caller — so the
 *     request itself is asserted, by path.
 *  2. The list is cached on a key that is not viewer-scoped, and B is served A's
 *     unpublished posts after an account switch. The key is asserted directly,
 *     and a second viewer must not read the first one's answer.
 *  3. The response is bound to as if it were a hydrated post DTO. It is not:
 *     `GET /posts/scheduled` returns RAW lean Mongo documents, so the id is
 *     `_id` and the body is `content.variants[0].text` with no resolved
 *     `content.text` anywhere. The normalization is asserted field by field.
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
import type { ScheduledPost } from '../useScheduledPosts';

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
 * Let the query/mutation work settle. React Query batches its subscriber
 * notifications onto a MACROtask, so flushing microtasks alone leaves the cache
 * updated and the component not yet re-rendered.
 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Exactly the shape `res.json(await Post.find(...).lean())` puts on the wire:
 * `_id`, no `id`, the body only inside `content.variants[0].text`, and no author
 * object at all.
 */
const RAW_DOCUMENTS = [
  {
    _id: 'post-soon',
    scheduledFor: '2026-08-02T09:30:00.000Z',
    createdAt: '2026-08-01T09:00:00.000Z',
    content: {
      variants: [
        { tag: 'en-US', source: 'author', text: '  Ship the scheduled queue  ' },
        { tag: 'es-ES', source: 'author', text: 'Publicar la cola programada' },
      ],
      media: [
        { id: 'media-1', type: 'image' },
        { id: 'media-2', type: 'image' },
      ],
    },
  },
  {
    _id: 'post-poll',
    scheduledFor: '2026-08-05T18:00:00.000Z',
    createdAt: '2026-08-01T09:05:00.000Z',
    content: {
      variants: [{ tag: 'en-US', source: 'author', text: '' }],
      pollId: 'poll-9',
      article: { title: '  Long read  ', body: 'body' },
    },
  },
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
    mockGet.mockResolvedValue({ data: RAW_DOCUMENTS });
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
    await settle();

    expect(mockGet).toHaveBeenCalledWith('/posts/scheduled');

    const cached = client.getQueryData<ScheduledPost[]>(
      viewerQueryKeys.scheduledPosts('viewer-1'),
    );
    expect(cached?.map((post) => post.id)).toEqual(['post-soon', 'post-poll']);
    // Spelled out, so renaming the factory cannot quietly move the key back into
    // a shared namespace while the assertion above still passes.
    expect(viewerQueryKeys.scheduledPosts('viewer-1')).toEqual([
      'viewer',
      'viewer-1',
      'posts',
      'scheduled',
    ]);
  });

  it('projects the raw lean document, not a hydrated post DTO', async () => {
    renderProbe();
    await settle();

    expect(latest!.scheduledPosts[0]).toEqual({
      id: 'post-soon',
      // From `content.variants[0].text`, trimmed. There is no `content.text` on
      // this route, so a hook that read one would produce '' here.
      text: 'Ship the scheduled queue',
      scheduledFor: new Date('2026-08-02T09:30:00.000Z'),
      mediaCount: 2,
      hasPoll: false,
      articleTitle: null,
    });
    expect(latest!.scheduledPosts[1]).toEqual({
      id: 'post-poll',
      text: '',
      scheduledFor: new Date('2026-08-05T18:00:00.000Z'),
      mediaCount: 0,
      hasPoll: true,
      articleTitle: 'Long read',
    });
  });

  it('survives a document with no usable scheduledFor instead of rendering an invalid date', async () => {
    mockGet.mockResolvedValue({
      data: [
        { _id: 'post-broken', content: { variants: [{ text: 'no time' }] } },
        { _id: 'post-garbage', scheduledFor: 'not-a-date', content: {} },
      ],
    });

    renderProbe();
    await settle();

    expect(latest!.scheduledPosts.map((post) => post.scheduledFor)).toEqual([null, null]);
  });

  it('does not read the private endpoint while the bearer is unusable, and reads once it lands', async () => {
    mockAuth.user = null;
    mockAuth.isAuthenticated = false;
    mockAuth.canUsePrivateApi = false;

    const client = renderProbe();
    await settle();

    expect(mockGet).not.toHaveBeenCalled();
    expect(latest!.scheduledPosts).toEqual([]);

    // The session resolves — the same thing a slow cold boot does.
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.isAuthenticated = true;
    mockAuth.canUsePrivateApi = true;
    rerender(client);
    await settle();

    expect(mockGet).toHaveBeenCalledWith('/posts/scheduled');
  });

  it('never serves one viewer the queue cached for another', async () => {
    const client = renderProbe();
    await settle();
    expect(latest!.scheduledPosts).toHaveLength(2);

    mockGet.mockResolvedValue({ data: [] });
    mockAuth.user = { id: 'viewer-2' };
    rerender(client);
    await settle();

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
    await settle();

    // The server now holds only the other post.
    mockGet.mockResolvedValue({ data: [RAW_DOCUMENTS[1]] });

    await act(async () => {
      await latest!.cancelScheduledPost('post-soon');
    });
    await settle();

    expect(mockDelete).toHaveBeenCalledWith('/posts/post-soon');
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(
      client
        .getQueryData<ScheduledPost[]>(viewerQueryKeys.scheduledPosts('viewer-1'))
        ?.map((post) => post.id),
    ).toEqual(['post-poll']);
  });

  it('removes the cancelled row before the revalidating read answers', async () => {
    const client = renderProbe();
    await settle();

    // The revalidation never comes back, so the local cache write is the ONLY
    // thing that can take the row off screen. Without it the user watches a
    // cancelled post sit in the list until the network decides otherwise.
    mockGet.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      await latest!.cancelScheduledPost('post-soon');
    });
    await settle();

    expect(
      client
        .getQueryData<ScheduledPost[]>(viewerQueryKeys.scheduledPosts('viewer-1'))
        ?.map((post) => post.id),
    ).toEqual(['post-poll']);
  });

  it('surfaces a failed cancel to the caller and keeps the row', async () => {
    mockDelete.mockRejectedValue(new Error('404 from the API'));
    const client = renderProbe();
    await settle();

    await act(async () => {
      await expect(latest!.cancelScheduledPost('post-soon')).rejects.toThrow('404 from the API');
    });
    await settle();

    // A row the server refused to delete must stay visible — silently dropping
    // it would tell the user a post was cancelled when it will still publish.
    expect(
      client
        .getQueryData<ScheduledPost[]>(viewerQueryKeys.scheduledPosts('viewer-1'))
        ?.map((post) => post.id),
    ).toEqual(['post-soon', 'post-poll']);
  });
});
