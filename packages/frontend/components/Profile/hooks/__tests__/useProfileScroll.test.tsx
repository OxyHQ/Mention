import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { useProfileScroll } from '../useProfileScroll';
import type { ProfileTab } from '../../types';

/**
 * Which feed the profile's near-bottom detector pages.
 *
 * The hook is one scroll listener serving nine tabs across every profile the
 * reader visits, so the only thing it really has to get right is WHICH slice a
 * load-more belongs to. It used to read the tab and the profile from refs
 * mirrored during render — illegal input for the React Compiler — and a lagging
 * pair sends the request to `user:<profile you left>:<tab you left>`: the list on
 * screen never grows and simply looks like it ended, while a slice the reader
 * cannot see fills up behind it. Nothing errors, so only an assertion on the
 * fetch ARGUMENTS catches it.
 */

const SCROLL_CHECK_THROTTLE = 180;

interface FeedMeta {
  hasMore: boolean;
  nextCursor?: string;
}

const mockFetchUserFeed = jest.fn(() => Promise.resolve({ pending: false }));
const mockGetFeedMeta = jest.fn<FeedMeta, [string]>(() => ({
  hasMore: true,
  nextCursor: 'cursor-1',
}));
let mockFeedUI: Record<string, { isLoading: boolean }> = {};

jest.mock('@/stores/postsStore', () => ({
  usePostsStore: {
    getState: () => ({
      fetchUserFeed: mockFetchUserFeed,
      feedUI: mockFeedUI,
    }),
  },
}));

jest.mock('@/db/feedQueries', () => ({
  getFeedMeta: (key: string) => mockGetFeedMeta(key),
}));

// `createAnimatedScrollHandler` hands back the listener untouched so a test can
// deliver a scroll the way the ScrollView would. Everything else on the context
// is inert here — this hook's job under test is pagination, not the header
// animation the shared `scrollY` also drives.
jest.mock('@/context/LayoutScrollContext', () => ({
  useLayoutScroll: () => ({
    scrollY: { addListener: () => 'listener-1', removeListener: () => {} },
    createAnimatedScrollHandler: (listener: (event: unknown) => void) => listener,
    registerScrollable: () => () => {},
    scrollToOffset: () => {},
    setScrollY: () => {},
  }),
  extractOffsetY: (event: { nativeEvent: { contentOffset: { y: number } } }) =>
    event.nativeEvent.contentOffset.y,
}));

type ScrollResult = ReturnType<typeof useProfileScroll>;

let latest: ScrollResult | null = null;

function Probe({ profileId, currentTab }: { profileId?: string; currentTab: ProfileTab }) {
  latest = useProfileScroll({ profileId, currentTab });
  return null;
}

/**
 * A scroll that lands within `LOAD_MORE_THRESHOLD` of the bottom. The hook
 * throttles to one check per 180ms, so each delivery advances the clock past it
 * — otherwise the second scroll of a test is silently swallowed and the test
 * passes for the wrong reason.
 */
function scrollToBottom() {
  jest.advanceTimersByTime(SCROLL_CHECK_THROTTLE + 1);
  act(() => {
    latest!.onScroll({
      nativeEvent: {
        contentOffset: { y: 900 },
        layoutMeasurement: { height: 800 },
        contentSize: { height: 1750 },
      },
    });
  });
}

async function mount(profileId: string | undefined, currentTab: ProfileTab) {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe profileId={profileId} currentTab={currentTab} />);
  });
  return renderer!;
}

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockFeedUI = {};
  mockGetFeedMeta.mockReturnValue({ hasMore: true, nextCursor: 'cursor-1' });
  latest = null;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useProfileScroll load-more targeting', () => {
  it('pages the tab that is on screen NOW, not the one it mounted with', async () => {
    const renderer = await mount('user-1', 'posts');

    scrollToBottom();
    expect(mockFetchUserFeed).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({ type: 'posts' }),
    );

    // Switch to Replies. The detector is the same listener; only the tab moved.
    await act(async () => {
      renderer.update(<Probe profileId="user-1" currentTab="replies" />);
    });

    scrollToBottom();
    expect(mockFetchUserFeed).toHaveBeenLastCalledWith(
      'user-1',
      expect.objectContaining({ type: 'replies' }),
    );
    expect(mockFetchUserFeed).toHaveBeenCalledTimes(2);

    act(() => renderer.unmount());
  });

  it('pages the profile that is on screen NOW, not the one it mounted with', async () => {
    const renderer = await mount('user-1', 'posts');

    scrollToBottom();
    expect(mockFetchUserFeed).toHaveBeenLastCalledWith('user-1', expect.anything());

    await act(async () => {
      renderer.update(<Probe profileId="user-2" currentTab="posts" />);
    });

    scrollToBottom();
    // The dangerous failure is not an error — it is this call naming `user-1`,
    // which grows a slice nobody is looking at while user-2's list stalls.
    expect(mockFetchUserFeed).toHaveBeenLastCalledWith('user-2', expect.anything());

    act(() => renderer.unmount());
  });

  it('reads the slice for the current tab, so hasMore is the right feed\'s', async () => {
    const renderer = await mount('user-1', 'posts');

    scrollToBottom();
    expect(mockGetFeedMeta).toHaveBeenLastCalledWith('user:user-1:posts');

    await act(async () => {
      renderer.update(<Probe profileId="user-1" currentTab="likes" />);
    });
    scrollToBottom();
    expect(mockGetFeedMeta).toHaveBeenLastCalledWith('user:user-1:likes');

    act(() => renderer.unmount());
  });

  it('stops paging a feed that says it has no more', async () => {
    mockGetFeedMeta.mockReturnValue({ hasMore: false });
    const renderer = await mount('user-1', 'posts');

    scrollToBottom();
    expect(mockFetchUserFeed).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('does not page while still far from the bottom', async () => {
    const renderer = await mount('user-1', 'posts');

    jest.advanceTimersByTime(SCROLL_CHECK_THROTTLE + 1);
    act(() => {
      latest!.onScroll({
        nativeEvent: {
          contentOffset: { y: 0 },
          layoutMeasurement: { height: 800 },
          contentSize: { height: 9000 },
        },
      });
    });
    expect(mockFetchUserFeed).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });

  it('does not page a profile it has no id for', async () => {
    const renderer = await mount(undefined, 'posts');

    scrollToBottom();
    expect(mockFetchUserFeed).not.toHaveBeenCalled();

    act(() => renderer.unmount());
  });
});
