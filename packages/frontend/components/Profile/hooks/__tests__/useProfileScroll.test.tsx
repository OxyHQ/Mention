import TestRenderer, { act } from 'react-test-renderer';
import { useProfileScroll } from '../useProfileScroll';
import type { ProfileTab } from '../../types';

/**
 * Which feed the profile pages, and where its jump goes.
 *
 * One hook serves every tab of every profile the reader visits, so the thing it
 * has to get right is WHICH slice a load-more belongs to: a lagging tab or
 * profile sends the request to the profile and tab you left, the
 * list on screen never grows and simply looks like it ended. Nothing errors, so
 * only an assertion on the read's ARGUMENTS catches it.
 */

const mockMore = jest.fn((_feed: { type: string; userId?: string }) => Promise.resolve());
const mockScrollToOffset = jest.fn();

// The feed source owns paging: it reads the next page only when there is one,
// and joins a read in flight (`@oxy.so/bloom-data`).
jest.mock('@/data/feeds', () => ({
  feedSource: { more: (feed: { type: string; userId?: string }) => mockMore(feed) },
}));
jest.mock('@oxy.so/bloom/screen', () => ({
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
  expect(mockMore).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'posts', userId: 'user-1' }),
  );
  await tree.rerender('user-2', 'replies');
  await loadMore();
  expect(mockMore).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: 'replies', userId: 'user-2' }),
  );
});

it('asks for nothing without a profile, or while a page is already being read', async () => {
  await mount(undefined, 'posts');
  await loadMore();
  expect(mockMore).not.toHaveBeenCalled();

  let finish!: () => void;
  mockMore.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
  await mount('user-1', 'posts');
  await act(async () => {
    latest.loadMore();
    latest.loadMore();
  });
  expect(mockMore).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});

it('jumps the scroller in front to the requested offset', async () => {
  await mount('user-1', 'posts');
  act(() => latest.scrollToContent(420));
  expect(mockScrollToOffset).toHaveBeenCalledWith(420);
});
