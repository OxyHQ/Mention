jest.mock('@oxy.so/bloom/skeleton', () => require('@/test-support/bloomSkeleton'));
/**
 * A page that failed to load must not look like the end of the feed: with rows
 * on screen the footer offers to ask again, and says nothing otherwise.
 */

import TestRenderer, { act } from 'react-test-renderer';
import { FeedFooter } from '../FeedFooter';

(globalThis as { __DEV__?: boolean }).__DEV__ = false;

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: {} }) }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ isAuthenticated: true, isAuthResolved: true, signIn: jest.fn() }),
}));

function render(props: Partial<React.ComponentProps<typeof FeedFooter>>) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<FeedFooter hasMore isLoadingMore={false} hasItems {...props} />);
  });
  return tree;
}

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
    expect(render({}).toJSON()).toBeNull();
  });

  it('shows nothing when the feed ended, even if a failure is flagged', () => {
    expect(
      render({ hasMore: false, loadFailed: true, onRetryLoadMore: jest.fn() }).toJSON(),
    ).toBeNull();
  });
});
