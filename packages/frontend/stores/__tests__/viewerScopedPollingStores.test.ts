import { api } from '@/utils/api';
import { getLiveRooms } from '@/lib/syraApi';
import { useLiveRoomsStore } from '../liveRoomsStore';
import { useTrendsStore } from '@/stores/trendsStore';

const mockRemoveItem = jest.fn((_key: string) => Promise.resolve());

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    removeItem: (key: string) => mockRemoveItem(key),
  },
}));

jest.mock('@/lib/syraApi', () => ({
  getLiveRooms: jest.fn(),
}));

jest.mock('@/utils/api', () => ({
  api: {
    get: jest.fn(),
  },
}));

const mockGetLiveRooms = getLiveRooms as jest.Mock;
const mockApiGet = api.get as jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const room = (id: string) => ({
  _id: id,
  title: id,
  host: `${id}-host`,
  type: 'talk' as const,
  status: 'live' as const,
  participants: [],
  speakers: [],
});

describe('viewer-owned polling stores', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useLiveRoomsStore.getState().resetViewerState();
    useTrendsStore.getState().resetViewerState();
  });

  it('discards A live rooms after reset and clears unowned hide state', async () => {
    const pendingA = deferred<ReturnType<typeof room>[]>();
    const pendingB = deferred<ReturnType<typeof room>[]>();
    mockGetLiveRooms.mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);

    useLiveRoomsStore.getState().hideRoom('a-hidden-room');
    const requestA = useLiveRoomsStore.getState().fetchLiveRooms();

    useLiveRoomsStore.getState().resetViewerState();
    expect(useLiveRoomsStore.getState().hiddenRoomIds).toEqual([]);
    expect(mockRemoveItem).toHaveBeenCalledWith('live-rooms-hidden');

    const requestB = useLiveRoomsStore.getState().fetchLiveRooms();
    pendingB.resolve([room('room-b')]);
    await requestB;
    expect(useLiveRoomsStore.getState().rooms.map((item) => item._id)).toEqual(['room-b']);

    pendingA.resolve([room('room-a')]);
    await requestA;
    expect(useLiveRoomsStore.getState().rooms.map((item) => item._id)).toEqual(['room-b']);
  });

  it('discards A trends after reset and clears unowned hide state', async () => {
    const pendingA = deferred<{
      data: { trending: { _id: string; name: string }[] };
    }>();
    const pendingB = deferred<{
      data: { trending: { _id: string; name: string }[] };
    }>();
    mockApiGet.mockReturnValueOnce(pendingA.promise).mockReturnValueOnce(pendingB.promise);

    useTrendsStore.getState().hideTrend('a-hidden-trend');
    const requestA = useTrendsStore.getState().fetchTrends();

    useTrendsStore.getState().resetViewerState();
    expect(useTrendsStore.getState().hiddenTrendIds).toEqual([]);
    expect(mockRemoveItem).toHaveBeenCalledWith('trends-hidden');

    const requestB = useTrendsStore.getState().fetchTrends();
    pendingB.resolve({
      data: { trending: [{ _id: 'trend-b', name: 'B' }] },
    });
    await requestB;
    // The client id is the trend's own identity, not the per-batch row `_id`
    // the wire carries — see `trendIdentity`.
    expect(useTrendsStore.getState().trends.map((item) => item.id)).toEqual(['hashtag:B']);

    pendingA.resolve({
      data: { trending: [{ _id: 'trend-a', name: 'A' }] },
    });
    await requestA;
    expect(useTrendsStore.getState().trends.map((item) => item.id)).toEqual(['hashtag:B']);
  });

  it('starts fresh polling after reset and ignores delayed old cleanup', () => {
    jest.useFakeTimers();
    try {
      mockGetLiveRooms.mockResolvedValue([]);
      const oldRoomsSubscription = useLiveRoomsStore.getState().startPolling();
      expect(mockGetLiveRooms).toHaveBeenCalledTimes(1);

      useLiveRoomsStore.getState().resetViewerState();
      const newRoomsSubscription = useLiveRoomsStore.getState().startPolling();
      expect(mockGetLiveRooms).toHaveBeenCalledTimes(2);

      useLiveRoomsStore.getState().stopPolling(oldRoomsSubscription);
      jest.advanceTimersByTime(300_000);
      expect(mockGetLiveRooms).toHaveBeenCalledTimes(3);
      useLiveRoomsStore.getState().stopPolling(newRoomsSubscription);

      mockApiGet.mockResolvedValue({ data: { trending: [] } });
      const oldTrendsSubscription = useTrendsStore.getState().startPolling();
      expect(mockApiGet).toHaveBeenCalledTimes(1);

      useTrendsStore.getState().resetViewerState();
      const newTrendsSubscription = useTrendsStore.getState().startPolling();
      expect(mockApiGet).toHaveBeenCalledTimes(2);

      useTrendsStore.getState().stopPolling(oldTrendsSubscription);
      jest.advanceTimersByTime(300_000);
      expect(mockApiGet).toHaveBeenCalledTimes(3);
      useTrendsStore.getState().stopPolling(newTrendsSubscription);
    } finally {
      useLiveRoomsStore.getState().resetViewerState();
      useTrendsStore.getState().resetViewerState();
      jest.useRealTimers();
    }
  });

  it('refreshes socket updates only while a rooms widget is observing', async () => {
    mockGetLiveRooms.mockResolvedValue([]);
    const store = useLiveRoomsStore.getState();
    store.refreshObservedLiveRooms();
    expect(mockGetLiveRooms).not.toHaveBeenCalled();

    const first = store.startPolling();
    const second = store.startPolling();
    expect(mockGetLiveRooms).toHaveBeenCalledTimes(1);
    store.refreshObservedLiveRooms();
    expect(mockGetLiveRooms).toHaveBeenCalledTimes(2);
    store.stopPolling(first);
    store.refreshObservedLiveRooms();
    expect(mockGetLiveRooms).toHaveBeenCalledTimes(3);
    store.stopPolling(second);
    store.refreshObservedLiveRooms();
    expect(mockGetLiveRooms).toHaveBeenCalledTimes(3);

    const reopened = store.startPolling();
    expect(mockGetLiveRooms).toHaveBeenCalledTimes(4);
    store.stopPolling(reopened);
    await Promise.resolve();
  });

  it('updates the displayed host when a room keeps the same id and participant count', async () => {
    mockGetLiveRooms
      .mockResolvedValueOnce([room('room')])
      .mockResolvedValueOnce([{ ...room('room'), host: 'new-host' }]);
    await useLiveRoomsStore.getState().fetchLiveRooms();
    await useLiveRoomsStore.getState().fetchLiveRooms({ silent: true });
    expect(useLiveRoomsStore.getState().rooms[0].host).toBe('new-host');
  });

  it('does not notify room subscribers when a refresh changes nothing', async () => {
    mockGetLiveRooms
      .mockResolvedValueOnce([room('room')])
      .mockResolvedValueOnce([room('room')])
      .mockResolvedValueOnce([{ ...room('room'), title: 'Updated' }]);
    await useLiveRoomsStore.getState().fetchLiveRooms();
    const notify = jest.fn();
    const unsubscribe = useLiveRoomsStore.subscribe(notify);
    await useLiveRoomsStore.getState().fetchLiveRooms({ silent: true });
    expect(notify).not.toHaveBeenCalled();
    await useLiveRoomsStore.getState().fetchLiveRooms({ silent: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(useLiveRoomsStore.getState().rooms[0].title).toBe('Updated');
    unsubscribe();
  });

  it('does not notify trend subscribers when a refresh changes nothing', async () => {
    mockApiGet
      .mockResolvedValueOnce({ data: { trending: [{ name: 'first' }] } })
      .mockResolvedValueOnce({ data: { trending: [{ name: 'first' }] } })
      .mockResolvedValueOnce({ data: { trending: [{ name: 'second' }] } });
    await useTrendsStore.getState().fetchTrends();
    const notify = jest.fn();
    const unsubscribe = useTrendsStore.subscribe(notify);
    await useTrendsStore.getState().fetchTrends({ silent: true });
    expect(notify).not.toHaveBeenCalled();
    await useTrendsStore.getState().fetchTrends({ silent: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(useTrendsStore.getState().trends[0].text).toBe('second');
    unsubscribe();
  });
});
