import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import {
  NEW_POSTS_JITTER_MS,
  NEW_POSTS_MIN_INTERVAL_MS,
  NEW_POSTS_PROBE_LIMIT,
  useNewPosts,
} from '../useNewPosts';

const mockSubscribe = jest.fn();
const mockGetMtnFeed = jest.fn();
let mockVisible = true;
jest.mock('@oxy.so/bloom/screen', () => ({
  ...jest.requireActual('@oxy.so/bloom/screen'),
  useScreenVisible: () => mockVisible,
}));
jest.mock('@/services/socketService', () => ({
  socketService: { subscribeToFeedUpdates: (...args: unknown[]) => mockSubscribe(...args) },
}));
jest.mock('@/services/feedService', () => ({
  feedService: { getMtnFeed: (...args: unknown[]) => mockGetMtnFeed(...args) },
}));

const post = (id: string, minute: number) => ({
  id,
  metadata: { createdAt: new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString() },
});

type Result = ReturnType<typeof useNewPosts>;
type Props = Parameters<typeof useNewPosts>[0];

describe('useNewPosts', () => {
  let tree: ReactTestRenderer;
  let result: Result;
  let publish: () => void;
  let unsubscribe: jest.Mock;
  const loaded = [post('old', 1), post('older', 0)];
  const base: Props = { enabled: true, feedKey: 'viewer:following', items: loaded };

  function Probe(props: Props) {
    result = useNewPosts(props);
    return null;
  }
  const render = (props: Props = base) => {
    act(() => {
      if (tree) tree.update(<Probe {...props} />);
      else tree = create(<Probe {...props} />);
    });
  };
  const wait = async (ms = NEW_POSTS_MIN_INTERVAL_MS + NEW_POSTS_JITTER_MS) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockVisible = true;
    unsubscribe = jest.fn();
    mockSubscribe.mockImplementation((_type, callback) => {
      publish = callback;
      return unsubscribe;
    });
    mockGetMtnFeed.mockResolvedValue({
      items: [post('new-2', 3), post('new-1', 2), post('old', 1)],
    });
  });
  afterEach(() => {
    act(() => tree?.unmount());
    tree = undefined as unknown as ReactTestRenderer;
    jest.useRealTimers();
  });

  it('counts the posts newer than the loaded head, after one rate-limited check', async () => {
    render();
    expect(mockSubscribe).toHaveBeenCalledWith('following', expect.any(Function));
    publish();
    publish();
    await wait(NEW_POSTS_MIN_INTERVAL_MS - 1);
    expect(mockGetMtnFeed).not.toHaveBeenCalled();
    await wait();
    expect(mockGetMtnFeed).toHaveBeenCalledTimes(1);
    expect(mockGetMtnFeed).toHaveBeenCalledWith(
      'following',
      expect.objectContaining({ limit: NEW_POSTS_PROBE_LIMIT }),
    );
    expect(result.count).toBe(2);
    expect(result.overflow).toBe(false);
  });

  it('clears once the feed holds those posts, and on dismiss', async () => {
    render();
    publish();
    await wait();
    render({ ...base, items: [post('new-1', 2), ...loaded] });
    expect(result.count).toBe(1);
    act(() => result.dismiss());
    expect(result.count).toBe(0);
  });

  it('reports a full page of unseen posts as overflow', async () => {
    mockGetMtnFeed.mockResolvedValue({
      items: Array.from({ length: NEW_POSTS_PROBE_LIMIT }, (_, i) => post(`n${i}`, 10 + i)),
    });
    render();
    publish();
    await wait();
    expect(result.overflow).toBe(true);
  });

  it('stays quiet while the screen is hidden and checks on return', async () => {
    render();
    mockVisible = false;
    render();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await wait();
    expect(mockGetMtnFeed).not.toHaveBeenCalled();
    mockVisible = true;
    render();
    await wait(NEW_POSTS_JITTER_MS);
    expect(mockGetMtnFeed).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled or before the feed has loaded', async () => {
    render({ ...base, enabled: false });
    expect(mockSubscribe).not.toHaveBeenCalled();
    render({ ...base, items: [] });
    publish();
    await wait();
    expect(mockGetMtnFeed).not.toHaveBeenCalled();
  });

  it('keeps the page as it is when a check fails', async () => {
    mockGetMtnFeed.mockRejectedValue(new Error('offline'));
    render();
    publish();
    await wait();
    expect(result.count).toBe(0);
  });
});
