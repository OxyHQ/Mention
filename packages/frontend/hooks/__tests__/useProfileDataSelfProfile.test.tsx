import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { User } from '@oxyhq/core';

/**
 * The viewer's OWN profile paints from the session, not from a network race.
 *
 * `/you` is the tab a reader returns to constantly, and its whole page is gated
 * on one react-query entry: `ProfileShell` renders the full-page skeleton —
 * avatar placeholder, grey name bars, an empty tab strip — for exactly
 * `useProfileData`'s `loading`, which used to be the query's `isPending`, i.e.
 * "this key holds nothing yet". That entry is scoped by BOTH viewer and handle,
 * so it holds nothing on a fresh process, after an account switch (which clears
 * the whole client) and once the 30-minute `gcTime` has collected it — and in
 * every one of those cases the reader was shown placeholders for an account the
 * app was already holding a whole `User` for.
 *
 * A warm entry was never the problem and is not what these pin: react-query
 * serves cached data on the first render after a remount, so a mounted-and-
 * remounted screen never flashed. What these pin is the case where the entry is
 * EMPTY, which is the only way the skeleton can appear at all.
 */

const mockViewer: { current: User | null } = { current: null };
const mockFetchProfile = jest.fn<Promise<User | null>, [string | null]>();

jest.mock('@oxyhq/services', () => {
  const { useQuery } =
    jest.requireActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  const byUsername = (username: string, viewerId: string) => [
    'users',
    'detail',
    'username',
    username.trim().toLowerCase(),
    'viewer',
    viewerId,
  ];
  return {
    queryKeys: { users: { byUsername } },
    // The SDK hook's own options, verbatim — a 5-minute `staleTime`, a
    // 30-minute `gcTime`, `refetchOnMount: true` and the viewer in the key. The
    // point of running real react-query here rather than a stub is that
    // `isPending` has to mean what it means in the app: this key holds nothing.
    useUserByUsername: (username: string | null) =>
      useQuery({
        queryKey: byUsername(username ?? '', mockViewer.current?.id ?? ''),
        queryFn: () => mockFetchProfile(username),
        enabled: Boolean(username),
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        refetchOnMount: true,
      }),
  };
});

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: () => ({
    user: mockViewer.current,
    oxyServices: { resolveProfile: jest.fn() },
  }),
}));

jest.mock('@/stores/appearanceStore', () => ({
  useAppearanceStore: (selector: (state: unknown) => unknown) =>
    selector({ loadForUser: async () => null }),
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  APP_COLOR_PRESETS: { blue: {} },
  HEX_TO_APP_COLOR: {},
}));

jest.mock('@mention/shared-types/post', () => ({ MEDIA_VARIANT_BANNER: 'banner' }));

jest.mock('@/utils/imageUrlCache', () => ({
  getCachedFileDownloadUrlSync: () => undefined,
}));

import { useProfileData } from '@/hooks/useProfileData';

function user(id: string, username: string, displayName: string): User {
  return {
    id,
    username,
    name: { displayName },
  } as unknown as User;
}

interface Snapshot {
  loading: boolean;
  displayName: string | null;
}

function Probe({ handle, sink }: { handle: string; sink: Snapshot[] }) {
  const { data, loading } = useProfileData(handle);
  sink.push({ loading, displayName: data?.design.displayName ?? null });
  return null;
}

/** Lets react-query's batched notifications reach the tree. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function mountProbe(handle: string, sink: Snapshot[]) {
  const client = new QueryClient();
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(
      <QueryClientProvider client={client}>
        <Probe handle={handle} sink={sink} />
      </QueryClientProvider>,
    );
  });
  return renderer as TestRenderer.ReactTestRenderer;
}

describe('useProfileData — the viewer’s own profile', () => {
  beforeEach(() => {
    mockFetchProfile.mockReset();
    mockViewer.current = null;
  });

  it('paints the session account on the FIRST render, with an empty cache', async () => {
    mockViewer.current = user('viewer-1', 'nate', 'Nate Isern');
    mockFetchProfile.mockResolvedValue(user('viewer-1', 'nate', 'Nate Isern'));

    const sink: Snapshot[] = [];
    const renderer = mountProbe('nate', sink);

    // Before the fetch has answered: no skeleton, and the reader's own name.
    expect(sink[0]).toEqual({ loading: false, displayName: 'Nate Isern' });

    await settle();
    act(() => renderer.unmount());
  });

  it('still fetches, and the authoritative profile replaces the seed', async () => {
    mockViewer.current = user('viewer-1', 'nate', 'Nate');
    mockFetchProfile.mockResolvedValue(user('viewer-1', 'nate', 'Nate Isern'));

    const sink: Snapshot[] = [];
    const renderer = mountProbe('nate', sink);
    await settle();

    expect(mockFetchProfile).toHaveBeenCalledWith('nate');
    expect(sink[sink.length - 1]).toEqual({ loading: false, displayName: 'Nate Isern' });
    // Never a skeleton at any point, including while the fetch was in flight.
    expect(sink.every((snapshot) => snapshot.loading === false)).toBe(true);
    act(() => renderer.unmount());
  });

  it('matches the handle case-insensitively, the way the query key does', () => {
    mockViewer.current = user('viewer-1', 'Nate', 'Nate Isern');
    mockFetchProfile.mockResolvedValue(null);

    const sink: Snapshot[] = [];
    const renderer = mountProbe('nate', sink);

    expect(sink[0]).toEqual({ loading: false, displayName: 'Nate Isern' });
    act(() => renderer.unmount());
  });

  it('invents nothing for SOMEBODY ELSE’s profile — that one still loads', () => {
    mockViewer.current = user('viewer-1', 'nate', 'Nate Isern');
    mockFetchProfile.mockResolvedValue(user('other-1', 'ada', 'Ada'));

    const sink: Snapshot[] = [];
    const renderer = mountProbe('ada', sink);

    expect(sink[0]).toEqual({ loading: true, displayName: null });
    act(() => renderer.unmount());
  });

  it('invents nothing while the session is unresolved', () => {
    mockViewer.current = null;
    mockFetchProfile.mockResolvedValue(user('viewer-1', 'nate', 'Nate Isern'));

    const sink: Snapshot[] = [];
    const renderer = mountProbe('nate', sink);

    expect(sink[0]).toEqual({ loading: true, displayName: null });
    act(() => renderer.unmount());
  });
});
