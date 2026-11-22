jest.mock('@oxy.so/bloom/skeleton', () => require('@/test-support/bloomSkeleton'));
/**
 * A page that failed to load must not look like the end of the feed: with rows
 * on screen the footer offers to ask again, and says nothing otherwise.
 */

import TestRenderer, { act, type ReactTestRendererJSON } from 'react-test-renderer';
import { FeedFooter } from '../FeedFooter';
// The subject draws language text, whose Painted leaf reads Bloom's theme from the app's provider.
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  ...jest.requireActual('@oxy.so/bloom/theme'),
  useTheme: () => ({ colors: {} }),
}));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ isAuthenticated: true, isAuthResolved: true, signIn: jest.fn() }),
}));

function render(props: Partial<React.ComponentProps<typeof FeedFooter>>) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {<FeedFooter hasMore isLoadingMore={false} hasItems {...props} />}
      </BloomThemeProvider>,
    );
  });
  return tree;
}

/** What the footer drew: the hosts inside the theme provider's own root view. */
const drawn = (tree: TestRenderer.ReactTestRenderer) =>
  (tree.toJSON() as ReactTestRendererJSON).children;

describe('FeedFooter after a failed page', () => {
  it('offers to load more again, with the rows kept', () => {
    const onRetryLoadMore = jest.fn();
    const tree = render({ loadFailed: true, onRetryLoadMore });
    const button = tree.root.findByType('Button' as never);
    expect(button.props.children).toBe('common.loadMore');
    act(() => button.props.onPress());
    expect(onRetryLoadMore).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when idle with no failure', () => {
    expect(drawn(render({}))).toBeNull();
  });

  it('shows nothing when the feed ended, even if a failure is flagged', () => {
    expect(
      drawn(render({ hasMore: false, loadFailed: true, onRetryLoadMore: jest.fn() })),
    ).toBeNull();
  });
});

/**
 * A feed that loads on request (a minor's account, oxy ADR 0068) offers its next
 * page instead of fetching it; and a home timeline read to its end says so.
 */
describe('FeedFooter on a feed that loads on request', () => {
  it('offers the next page, and loads it when asked', () => {
    const onRetryLoadMore = jest.fn();
    const tree = render({ loadOnRequest: true, onRetryLoadMore });
    const button = tree.root.findByType('Button' as never);
    expect(button.props.children).toBe('common.loadMore');
    act(() => button.props.onPress());
    expect(onRetryLoadMore).toHaveBeenCalledTimes(1);
  });

  it('offers nothing once there is no next page', () => {
    expect(
      drawn(render({ loadOnRequest: true, hasMore: false, onRetryLoadMore: jest.fn() })),
    ).toBeNull();
  });

  it('offers nothing before there are rows', () => {
    expect(
      drawn(render({ loadOnRequest: true, hasItems: false, onRetryLoadMore: jest.fn() })),
    ).toBeNull();
  });
});

describe('FeedFooter at the end of a home timeline', () => {
  const text = (tree: ReturnType<typeof render>) => JSON.stringify(tree.toJSON());

  it('says the reader is caught up', () => {
    expect(text(render({ hasMore: false, caughtUp: true }))).toContain('feed.caughtUp');
  });

  it('says nothing while there is more to load', () => {
    expect(drawn(render({ hasMore: true, caughtUp: true }))).toBeNull();
  });

  it('says nothing unless the feed asks for it', () => {
    expect(drawn(render({ hasMore: false }))).toBeNull();
  });
});
