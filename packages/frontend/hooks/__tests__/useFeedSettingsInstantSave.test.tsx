import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * The two failure modes an instant-save settings screen has, neither of which
 * is visible by reading the code:
 *
 *  1. A toggle that APPEARS to change and did not persist. With no draft and no
 *     save button, the optimistic write is the only thing the user sees, so a
 *     rejected write that does not roll back leaves the screen showing a value
 *     the server refused — silently. These assertions require the value to
 *     return to what it was AND a toast to be raised.
 *  2. A screen that never recovers from cold boot. The session resolves 5-25s
 *     after mount; a query that is not keyed on the viewer fetches once while
 *     anonymous and keeps that answer forever. The last case asserts the read
 *     does not happen at all while anonymous, and DOES happen once the session
 *     lands.
 *
 * The real `QueryClient` runs here — only the HTTP boundary and the SDK modules
 * that ship untranspiled TS are mocked, so the optimistic write, the rollback
 * and the cache key are the code under test rather than a re-implementation.
 */

const mockGet = jest.fn();
const mockPut = jest.fn();
const mockToast = jest.fn();

const mockAuth: { user: { id: string } | null; canUsePrivateApi: boolean } = {
  user: { id: 'viewer-1' },
  canUsePrivateApi: true,
};

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockGet(...args),
    put: (...args: unknown[]) => mockPut(...args),
  },
  isUnauthorizedError: () => false,
  isNotFoundError: () => false,
}));

jest.mock('@oxyhq/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@oxyhq/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, vars?: { defaultValue?: string }) => vars?.defaultValue ?? _key,
  }),
}));
jest.mock('@oxyhq/core/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { useFeedSettings, DEFAULT_FEED_SETTINGS } from '../useFeedSettings';

type Hook = ReturnType<typeof useFeedSettings>;
let latest: Hook | null = null;

function Probe() {
  latest = useFeedSettings();
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
 * updated and the component not yet re-rendered — which reads exactly like a
 * cache write that never happened.
 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const SERVER_SETTINGS = {
  ...DEFAULT_FEED_SETTINGS,
  quality: { boostHighQuality: true },
};

describe('useFeedSettings — instant save', () => {
  beforeAll(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    latest = null;
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.canUsePrivateApi = true;
    mockGet.mockResolvedValue({ data: { feedSettings: SERVER_SETTINGS } });
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

  it('shows the new value immediately, before the server has answered', async () => {
    const next = { ...SERVER_SETTINGS, quality: { boostHighQuality: false } };
    let resolvePut: ((value: unknown) => void) = () => {};
    mockPut.mockReturnValue(new Promise((resolve) => { resolvePut = resolve; }));

    const client = renderProbe();
    await settle();
    expect(latest!.settings.quality.boostHighQuality).toBe(true);

    await act(async () => {
      latest!.save(next);
      await Promise.resolve();
    });

    // The PUT is still in flight — nothing has come back from the server.
    expect(mockPut).toHaveBeenCalledTimes(1);
    // And the cache already holds the new value, which is what the screen reads.
    const key = ['viewer', 'viewer-1', 'feed-settings'];
    expect(client.getQueryData<typeof SERVER_SETTINGS>(key)?.quality.boostHighQuality).toBe(false);

    await act(async () => {
      resolvePut({ data: { feedSettings: next } });
      await Promise.resolve();
    });
    await settle();
  });

  it('rolls the value back and raises a toast when the write fails', async () => {
    mockPut.mockRejectedValue(new Error('500 from the API'));
    // The revalidation `onSettled` fires must NOT be able to restore the value
    // for us: if it could, this test would pass with the rollback deleted, which
    // is exactly what it did before this line existed. With the refetch failing,
    // the snapshot restore in `onError` is the only thing that can put the old
    // value back.
    mockGet
      .mockResolvedValueOnce({ data: { feedSettings: SERVER_SETTINGS } })
      .mockRejectedValue(new Error('refetch unavailable'));

    renderProbe();
    await settle();
    expect(latest!.settings.quality.boostHighQuality).toBe(true);

    await act(async () => {
      latest!.save({ ...SERVER_SETTINGS, quality: { boostHighQuality: false } });
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();

    // Back to what the server actually holds — not left showing the refused value.
    expect(latest!.settings.quality.boostHighQuality).toBe(true);
    // And the user was told. A silent revert is the failure this guards.
    expect(mockToast).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't save"),
      { type: 'error' },
    );
  });

  it('previews without writing, so a slider drag makes no requests', async () => {
    const client = renderProbe();
    await settle();

    act(() => {
      latest!.preview({ ...SERVER_SETTINGS, recency: { halfLifeHours: 48, maxAgeHours: 168 } });
    });
    await settle();

    const key = ['viewer', 'viewer-1', 'feed-settings'];
    expect(client.getQueryData<typeof SERVER_SETTINGS>(key)?.recency.halfLifeHours).toBe(48);
    expect(latest!.settings.recency.halfLifeHours).toBe(48);
    // The whole point: a drag moves the displayed value and touches no network.
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('does not read the private endpoint while anonymous, and reads once the session lands', async () => {
    mockAuth.user = null;
    mockAuth.canUsePrivateApi = false;

    const client = renderProbe();
    await settle();

    expect(mockGet).not.toHaveBeenCalled();
    expect(latest!.settings).toEqual(DEFAULT_FEED_SETTINGS);

    // The session resolves — the same thing a slow cold boot does.
    mockAuth.user = { id: 'viewer-1' };
    mockAuth.canUsePrivateApi = true;
    rerender(client);
    await settle();

    expect(mockGet).toHaveBeenCalled();
  });
});
