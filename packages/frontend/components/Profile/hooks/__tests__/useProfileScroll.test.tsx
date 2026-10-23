import TestRenderer, { act } from 'react-test-renderer';
import { useProfileScroll } from '../useProfileScroll';
import type { ProfileTab } from '../../types';

/**
 * Which feed the profile pages, and where its jump goes.
 *
 * One hook serves every tab of every profile the reader visits, so the thing it
 * has to get right is WHICH slice a load-more belongs to: a lagging tab or
 * profile sends the request to `user:<profile you left>:<tab you left>`, the
 * list on screen never grows and simply looks like it ended. Nothing errors, so
 * only an assertion on the fetch ARGUMENTS catches it.
 */

interface FeedMeta {
  hasMore: boolean;
  nextCursor?: string;
}

const mockFetchUserFeed = jest.fn(() => Promise.resolve({ pending: false }));
const mockGetFeedMeta = jest.fn<FeedMeta, [string]>(() => ({
  hasMore: true,
  nextCursor: 'cursor-1',
}));
const mockScrollToOffset = jest.fn();

jest.mock('@/stores/postsStore', () => ({
  usePostsStore: { getState: () => ({ fetchUserFeed: mockFetchUserFeed, feedUI: {} }) },
}));
jest.mock('@/db/feedQueries', () => ({ getFeedMeta: (key: string) => mockGetFeedMeta(key) }));
jest.mock('@/context/ScreenReselectContext', () => ({
  useFrontScroller: () => () => ({ offset: () => 0, scrollToOffset: mockScrollToOffset }),
}));

let latest!: ReturnType<typeof useProfileScroll>;
function Probe({ profileId, currentTab }: { profileId?: string; currentTab: ProfileTab }) {
  latest = useProfileScroll({ profileId, currentTab });
  return null;
}

async function mount(profileId: string | undefined, currentTab: ProfileTab) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<Probe profileId={profileId} currentTab={currentTab} />);
  });
  return {
    rerender: (nextProfile: string | undefined, nextTab: ProfileTab) =>
      act(async () => {
        renderer.update(<Probe profileId={nextProfile} currentTab={nextTab} />);
      }),
  };
}

async function loadMore() {
  await act(async () => {
    latest.loadMore();
  });
}

beforeEach(() => jest.clearAllMocks());

it('pages the tab and the profile that are on screen NOW', async () => {
  const tree = await mount('user-1', 'posts');
  await loadMore();
  expect(mockFetchUserFeed).toHaveBeenLastCalledWith(
    'user-1',
    expect.objectContaining({ type: 'posts', cursor: 'cursor-1' }),
  );
  await tree.rerender('user-2', 'replies');
  await loadMore();
  expect(mockFetchUserFeed).toHaveBeenLastCalledWith(
    'user-2',
    expect.objectContaining({ type: 'replies' }),
  );
  expect(mockGetFeedMeta).toHaveBeenLastCalledWith('user:user-2:replies');
});

it('stops at the end of a feed, before its first page, and without a profile', async () => {
  mockGetFeedMeta.mockReturnValueOnce({ hasMore: false, nextCursor: 'cursor-1' });
  await mount('user-1', 'posts');
  await loadMore();
  mockGetFeedMeta.mockReturnValueOnce({ hasMore: true });
  await loadMore();
  await mount(undefined, 'posts');
  await loadMore();
  expect(mockFetchUserFeed).not.toHaveBeenCalled();
});

it('jumps the scroller in front to the requested offset', async () => {
  await mount('user-1', 'posts');
  act(() => latest.scrollToContent(420));
  expect(mockScrollToOffset).toHaveBeenCalledWith(420);
});
