import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Who is offered a community-note flow, and what happens when they use it.
 *
 * The handlers are not a convenience wrapper: their PRESENCE is what
 * `useCommunityNoteSheets` reads as permission to offer the flow at all. So the
 * case that matters most here is the negative one — with CrowdSource off, or
 * unreachable, there must be no handler, because a "note submitted" sheet for a
 * note that went nowhere is worse than no menu entry.
 *
 * The hub's queue is the other half: it is drawn with a POST exactly once per
 * mount, because each draw ISSUES assignments, and a query that React Query
 * refetched on a window focus would consume a second batch every time the
 * reader tabbed away and back.
 */

const mockGet = jest.fn();
const mockPost = jest.fn();

const mockAuth: { user: { id: string } | null; isAuthenticated: boolean; canUsePrivateApi: boolean } = {
  user: { id: 'viewer-1' },
  isAuthenticated: true,
  canUsePrivateApi: true,
};

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockGet(...args),
    post: (...args: unknown[]) => mockPost(...args),
  },
}));

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@oxy.so/core/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { useCommunityNoteHandlers, useCommunityNotesHub } from '../useCommunityNotes';

type Handlers = ReturnType<typeof useCommunityNoteHandlers>;
type Hub = ReturnType<typeof useCommunityNotesHub>;

let latestHandlers: Handlers | null = null;
let latestHub: Hub | null = null;

function HandlersProbe() {
  latestHandlers = useCommunityNoteHandlers();
  return null;
}

function HubProbe() {
  latestHub = useCommunityNotesHub();
  return null;
}

const clients: QueryClient[] = [];
let renderer: TestRenderer.ReactTestRenderer | null = null;

function renderProbe(Probe: () => null) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  clients.push(client);
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return client;
}

/**
 * React Query notifies its subscribers on a macrotask, so flushing microtasks
 * alone leaves the cache written and the component not yet re-rendered — which
 * reads exactly like a fetch that never happened.
 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * The handlers, once the availability query has actually produced them.
 *
 * `settle()` waits ONE macrotask, which is enough on an idle machine and not
 * always enough on a loaded CI runner. Every call site used to reach for
 * `latestHandlers?.submitNote?.(…)`, and optional chaining turns "the handler
 * was not there yet" into a silent no-op that RESOLVES — so a test asserting a
 * rejection reported `Received promise resolved instead of rejected`, which
 * names neither the handler nor the timing. Measured: that is exactly how this
 * file failed in CI on 2026-09-19 while passing locally.
 *
 * So: settle until they appear, and fail naming what never appeared.
 */
async function readyHandlers(): Promise<Required<Pick<Handlers, 'submitNote' | 'rateNote'>>> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (typeof latestHandlers?.submitNote === 'function' && typeof latestHandlers?.rateNote === 'function') {
      return latestHandlers as Required<Pick<Handlers, 'submitNote' | 'rateNote'>>;
    }
    await settle();
  }
  throw new Error(
    'The community-note handlers never appeared. The availability query is what produces them, so this is that query not resolving — not a handler that is missing by design.',
  );
}

function availability(enabled: boolean) {
  mockGet.mockImplementation(async (path: string) => {
    if (path === '/community-notes/availability') return { data: { enabled } };
    return { data: { entries: [] } };
  });
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.user = { id: 'viewer-1' };
  mockAuth.isAuthenticated = true;
  mockAuth.canUsePrivateApi = true;
  latestHandlers = null;
  latestHub = null;
  availability(true);
  mockPost.mockResolvedValue({ data: { entries: [] } });
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = null;
  for (const client of clients.splice(0)) client.clear();
});

describe('the write handlers', () => {
  it('offers nothing at all until the deployment says it takes notes', async () => {
    availability(false);

    renderProbe(HandlersProbe);
    await settle();

    expect(latestHandlers).toEqual({});
  });

  it('offers nothing when the availability check itself fails', async () => {
    mockGet.mockRejectedValue(new Error('gateway'));

    renderProbe(HandlersProbe);
    await settle();

    expect(latestHandlers).toEqual({});
  });

  it('never asks while the viewer is signed out', async () => {
    mockAuth.user = null;
    mockAuth.isAuthenticated = false;

    renderProbe(HandlersProbe);
    await settle();

    expect(mockGet).not.toHaveBeenCalled();
    expect(latestHandlers).toEqual({});
  });

  it('sends a note, trimmed, with the one source the form collects', async () => {
    renderProbe(HandlersProbe);
    const handlers = await readyHandlers();
    mockPost.mockResolvedValue({ data: { note: { id: 'n1' } } });

    await act(async () => {
      await handlers.submitNote('p1', { text: '  context  ', sourceUrl: ' https://example.org/s ' });
    });

    expect(mockPost).toHaveBeenCalledWith('/community-notes', {
      postId: 'p1',
      text: 'context',
      sourceUrls: ['https://example.org/s'],
    });
  });

  it('sends a note with no source as a note with no sources, not an empty one', async () => {
    renderProbe(HandlersProbe);
    const handlers = await readyHandlers();
    mockPost.mockResolvedValue({ data: { note: { id: 'n1' } } });

    await act(async () => {
      await handlers.submitNote('p1', { text: 'context', sourceUrl: '   ' });
    });

    expect(mockPost.mock.calls[0]?.[1]).toMatchObject({ sourceUrls: [] });
  });

  it('sends a rating with its reasons', async () => {
    renderProbe(HandlersProbe);
    const handlers = await readyHandlers();
    mockPost.mockResolvedValue({ data: {} });

    await act(async () => {
      await handlers.rateNote('n1', 'helpful', ['relevant']);
    });

    expect(mockPost).toHaveBeenCalledWith('/community-notes/n1/ratings', {
      rating: 'helpful',
      reasons: ['relevant'],
    });
  });

  it('lets a refused write reach the caller, so the sheet does not claim success', async () => {
    renderProbe(HandlersProbe);
    const handlers = await readyHandlers();
    mockPost.mockRejectedValue(new Error('refused'));

    await expect(
      act(async () => {
        await handlers.submitNote('p1', { text: 'context', sourceUrl: '' });
      }),
    ).rejects.toThrow('refused');
  });
});

describe('the hub', () => {
  it('draws the queue once, and reads the two lists beside it', async () => {
    mockPost.mockResolvedValue({ data: { entries: [{ note: { id: 'n1' }, post: { id: 'p1' } }] } });
    mockGet.mockImplementation(async (path: string) => {
      if (path === '/community-notes/availability') return { data: { enabled: true } };
      if (path === '/community-notes/mine') return { data: { entries: [{ note: { id: 'n2' }, post: { id: 'p2' } }] } };
      return { data: { entries: [] } };
    });

    renderProbe(HubProbe);
    // Same reason as `readyHandlers`: two fixed macrotasks were enough on an
    // idle machine and not on a loaded CI runner (failed there 2026-09-24).
    // Settle until the hub has drawn, bounded, then assert what it drew.
    for (let attempt = 0; attempt < 20 && !(latestHub?.toRate?.length && latestHub?.written?.length); attempt += 1) {
      await settle();
    }

    expect(mockPost.mock.calls.filter(([path]) => path === '/community-notes/to-rate')).toHaveLength(1);
    expect(latestHub?.toRate).toHaveLength(1);
    expect(latestHub?.written).toHaveLength(1);
    expect(latestHub?.rated).toEqual([]);
  });

  it('draws nothing where notes are not offered, and does not sit spinning', async () => {
    availability(false);

    renderProbe(HubProbe);
    await settle();
    await settle();

    expect(mockPost).not.toHaveBeenCalled();
    expect(latestHub?.isPending).toBe(false);
    expect(latestHub?.handlers).toEqual({});
  });
});
