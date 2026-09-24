import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveAvatar } from '../LiveAvatar';
import { LivePresencePoller } from '@/components/providers/LivePresencePoller';
import { getLiveRoomId, resetLivePresence } from '@/stores/livePresenceStore';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

/*
 * Live presence is ONE poll for the app: LivePresencePoller owns the only
 * QueryObserver on `['live-users']` and every LiveAvatar reads its own key of
 * the live-presence store. Before this, each avatar held its own observer and
 * rebuilt the whole Map, so 50 post headers were 50 observers and one user
 * going live re-rendered all 50 avatars.
 */

const mockGetLiveUsers = jest.fn();
jest.mock('@/lib/syraApi', () => ({ getLiveUsers: () => mockGetLiveUsers() }));

let mockUser: { id: string } | null = { id: 'viewer-a' };
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: mockUser }) }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (...args: unknown[]) => mockPush(...args) } }));

interface AvatarProbeProps {
  testID?: string;
  live?: boolean;
  liveLabel?: string;
  onPress?: () => void;
}
const mockAvatarRenders = new Map<string, number>();
const mockAvatarProps = new Map<string, AvatarProbeProps>();
jest.mock('@oxy.so/bloom/avatar', () => ({
  Avatar: (props: AvatarProbeProps) => {
    const id = props.testID ?? '?';
    mockAvatarRenders.set(id, (mockAvatarRenders.get(id) ?? 0) + 1);
    mockAvatarProps.set(id, props);
    return null;
  },
}));

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
}

function tree(client: QueryClient, avatars: React.ReactNode) {
  return (
    <QueryClientProvider client={client}>
      <LivePresencePoller />
      {avatars}
    </QueryClientProvider>
  );
}

function avatars(count: number) {
  return Array.from({ length: count }, (_, i) => (
    <LiveAvatar key={i} userId={`u${i}`} testID={`u${i}`} />
  ));
}

function liveUsersQuery(client: QueryClient, viewerId: string | undefined) {
  return client.getQueryCache().find({ queryKey: viewerQueryKeys.liveUsers(viewerId), exact: true });
}

async function flush() {
  await act(async () => {
    // Enabling the query, the fetch, and TanStack's batched notify each take a
    // tick; drain a few so the result has reached the store and the avatars.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

let renderer: TestRenderer.ReactTestRenderer | null = null;
let client: QueryClient;

beforeEach(() => {
  mockUser = { id: 'viewer-a' };
  mockGetLiveUsers.mockReset();
  mockPush.mockReset();
  mockAvatarRenders.clear();
  mockAvatarProps.clear();
  resetLivePresence();
  client = newClient();
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = null;
  client.clear();
});

describe('live presence: one poll, keyed reads', () => {
  it('50 mounted avatars share ONE observer and ONE fetch', async () => {
    mockGetLiveUsers.mockResolvedValue([{ userId: 'u1', roomId: 'r1' }]);

    const started = performance.now();
    act(() => {
      renderer = TestRenderer.create(tree(client, avatars(50)));
    });
    const mountMs = performance.now() - started;
    await flush();

    const observers = client
      .getQueryCache()
      .getAll()
      .reduce((total, query) => total + query.getObserversCount(), 0);
    expect(liveUsersQuery(client, 'viewer-a')?.getObserversCount()).toBe(1);
    expect(observers).toBe(1);
    expect(mockGetLiveUsers).toHaveBeenCalledTimes(1);
    expect(mockAvatarProps.get('u1')?.live).toBe(true);
    expect(mockAvatarProps.get('u2')?.live).toBe(false);
    // Recorded for the PR, not asserted: timing is machine-dependent.
    console.log(`[live-presence] 50 avatars: observers=${observers} mountMs=${mountMs.toFixed(1)}`);
  });

  it('a presence change for one user re-renders only that avatar', async () => {
    mockGetLiveUsers.mockResolvedValue([{ userId: 'u1', roomId: 'r1' }]);
    act(() => {
      renderer = TestRenderer.create(tree(client, avatars(50)));
    });
    await flush();
    mockAvatarRenders.clear();

    mockGetLiveUsers.mockResolvedValue([
      { userId: 'u1', roomId: 'r1' },
      { userId: 'u2', roomId: 'r2' },
    ]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: viewerQueryKeys.liveUsers('viewer-a') });
    });
    await flush();

    expect(mockAvatarProps.get('u2')?.live).toBe(true);
    expect(mockAvatarRenders.get('u2')).toBe(1);
    expect(mockAvatarRenders.get('u1')).toBeUndefined();
    expect(mockAvatarRenders.get('u5')).toBeUndefined();
    const total = Array.from(mockAvatarRenders.values()).reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  it('does not poll while nothing reads presence', async () => {
    mockGetLiveUsers.mockResolvedValue([]);
    act(() => {
      renderer = TestRenderer.create(tree(client, null));
    });
    await flush();
    expect(mockGetLiveUsers).not.toHaveBeenCalled();

    act(() => {
      renderer!.update(tree(client, avatars(3)));
    });
    await flush();
    expect(mockGetLiveUsers).toHaveBeenCalledTimes(1);
  });

  it('keys the poll by viewer and drops the previous viewer\'s live set on switch', async () => {
    mockGetLiveUsers.mockResolvedValue([{ userId: 'u1', roomId: 'room-for-a' }]);
    act(() => {
      renderer = TestRenderer.create(tree(client, avatars(3)));
    });
    await flush();
    expect(getLiveRoomId('u1')).toBe('room-for-a');

    let resolveB: (value: unknown) => void = () => undefined;
    mockGetLiveUsers.mockReturnValue(new Promise((resolve) => { resolveB = resolve; }));
    mockUser = { id: 'viewer-b' };
    act(() => {
      renderer!.update(tree(client, avatars(3)));
    });
    // B's poll is in flight: A's live set must not show through.
    expect(getLiveRoomId('u1')).toBeUndefined();
    expect(mockAvatarProps.get('u1')?.live).toBe(false);

    await act(async () => {
      resolveB([{ userId: 'u2', roomId: 'room-for-b' }]);
    });
    await flush();
    expect(getLiveRoomId('u2')).toBe('room-for-b');
    expect(liveUsersQuery(client, 'viewer-a')?.getObserversCount() ?? 0).toBe(0);
    expect(liveUsersQuery(client, 'viewer-b')?.getObserversCount()).toBe(1);
  });

  it('keeps the last good list when a refresh fails', async () => {
    mockGetLiveUsers.mockResolvedValue([{ userId: 'u1', roomId: 'r1' }]);
    act(() => {
      renderer = TestRenderer.create(tree(client, avatars(2)));
    });
    await flush();

    mockGetLiveUsers.mockRejectedValue(new Error('syra down'));
    await act(async () => {
      await client.invalidateQueries({ queryKey: viewerQueryKeys.liveUsers('viewer-a') });
    });
    await flush();
    expect(mockAvatarProps.get('u1')?.live).toBe(true);
  });
});

describe('LiveAvatar badge and join behaviour', () => {
  it('a live user shows the LIVE badge and a tap joins the room', async () => {
    mockGetLiveUsers.mockResolvedValue([{ userId: 'host', roomId: 'room-1' }]);
    const onPress = jest.fn();
    act(() => {
      renderer = TestRenderer.create(
        tree(client, <LiveAvatar userId="host" testID="host" onPress={onPress} />),
      );
    });
    await flush();

    const props = mockAvatarProps.get('host')!;
    expect(props.live).toBe(true);
    expect(props.liveLabel).toBe('LIVE');
    act(() => props.onPress!());
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/live-rooms/live/[id]',
      params: { id: 'room-1' },
    });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('a non-live user forwards onPress, and is not pressable without one', async () => {
    mockGetLiveUsers.mockResolvedValue([]);
    const onPress = jest.fn();
    act(() => {
      renderer = TestRenderer.create(
        tree(client, (
          <>
            <LiveAvatar userId="quiet" testID="quiet" onPress={onPress} />
            <LiveAvatar userId="plain" testID="plain" />
          </>
        )),
      );
    });
    await flush();

    expect(mockAvatarProps.get('quiet')?.live).toBe(false);
    act(() => mockAvatarProps.get('quiet')!.onPress!());
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockAvatarProps.get('plain')?.onPress).toBeUndefined();
  });

  it('an explicit live prop wins, and a custom liveLabel is kept', async () => {
    mockGetLiveUsers.mockResolvedValue([{ userId: 'host', roomId: 'room-1' }]);
    act(() => {
      renderer = TestRenderer.create(
        tree(client, (
          <>
            <LiveAvatar userId="host" testID="forced-off" live={false} />
            <LiveAvatar testID="forced-on" live liveLabel="EN VIVO" />
          </>
        )),
      );
    });
    await flush();

    expect(mockAvatarProps.get('forced-off')?.live).toBe(false);
    expect(mockAvatarProps.get('forced-off')?.onPress).toBeUndefined();
    expect(mockAvatarProps.get('forced-on')?.live).toBe(true);
    expect(mockAvatarProps.get('forced-on')?.liveLabel).toBe('EN VIVO');
    // Forced live with no room to join: not pressable.
    expect(mockAvatarProps.get('forced-on')?.onPress).toBeUndefined();
  });
});
