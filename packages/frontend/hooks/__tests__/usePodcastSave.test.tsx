import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { usePodcastSave } from '../usePodcastSave';

/**
 * The podcast card's save button is the viewer's Syra subscription.
 *
 * Pinned here: the saved state is read from the ONE subscriptions list (not a
 * request per card), a tap writes through the Syra SDK and shows the new state
 * before the write settles, a refused write puts the old state back, and a
 * signed-out tap asks for sign-in instead of sending a request that has no token.
 */

const mockAuth = { user: { id: 'viewer-1' } as { id: string } | null, isAuthenticated: true, signIn: jest.fn() };
const mockClient = {
  listPodcastSubscriptions: jest.fn(),
  subscribeToPodcast: jest.fn(),
  unsubscribeFromPodcast: jest.fn(),
};

jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));
jest.mock('@/lib/syraPodcasts', () => ({ getSyraClient: () => Promise.resolve(mockClient) }));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: { success: jest.fn(), error: jest.fn() } }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}));

type Result = ReturnType<typeof usePodcastSave>;

function renderHook(podcastId: string | undefined) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const result: { current: Result | null } = { current: null };
  function Probe() {
    result.current = usePodcastSave(podcastId);
    return null;
  }
  act(() => {
    TestRenderer.create(
      <QueryClientProvider client={queryClient}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  return result;
}

// react-query schedules its notifications on timers, so a microtask flush is
// not enough to see a settled query.
const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
});

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.user = { id: 'viewer-1' };
  mockAuth.isAuthenticated = true;
  mockClient.listPodcastSubscriptions.mockResolvedValue([{ podcast: { id: 'saved-show', title: 'Saved' } }]);
  mockClient.subscribeToPodcast.mockResolvedValue(undefined);
  mockClient.unsubscribeFromPodcast.mockResolvedValue(undefined);
});

it('reads the saved state from the subscriptions list', async () => {
  const saved = renderHook('saved-show');
  const other = renderHook('other-show');
  await flush();

  expect(saved.current?.isSaved).toBe(true);
  expect(other.current?.isSaved).toBe(false);
});

it('subscribes on tap and shows it saved before the write settles', async () => {
  let settle: () => void = () => undefined;
  mockClient.subscribeToPodcast.mockReturnValue(new Promise<void>((resolve) => { settle = resolve; }));
  const hook = renderHook('other-show');
  await flush();

  act(() => hook.current?.toggleSave());
  await flush();

  expect(mockClient.subscribeToPodcast).toHaveBeenCalledWith('other-show');
  expect(hook.current?.isSaved).toBe(true);
  await act(async () => settle());
});

it('unsubscribes a saved show', async () => {
  const hook = renderHook('saved-show');
  await flush();

  act(() => hook.current?.toggleSave());
  await flush();

  expect(mockClient.unsubscribeFromPodcast).toHaveBeenCalledWith('saved-show');
  expect(hook.current?.isSaved).toBe(false);
});

it('puts the previous state back when Syra refuses the write', async () => {
  mockClient.subscribeToPodcast.mockRejectedValue(new Error('404'));
  const hook = renderHook('other-show');
  await flush();

  act(() => hook.current?.toggleSave());
  await flush();

  expect(hook.current?.isSaved).toBe(false);
});

it('asks a signed-out viewer to sign in and sends nothing', async () => {
  mockAuth.user = null;
  mockAuth.isAuthenticated = false;
  mockAuth.signIn.mockResolvedValue(undefined);
  const hook = renderHook('other-show');
  await flush();

  act(() => hook.current?.toggleSave());
  await flush();

  expect(mockAuth.signIn).toHaveBeenCalledTimes(1);
  expect(mockClient.listPodcastSubscriptions).not.toHaveBeenCalled();
  expect(mockClient.subscribeToPodcast).not.toHaveBeenCalled();
});
