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
const mockSignIn = jest.fn(() => Promise.resolve());
const mockOpenAccountDialog = jest.fn();
const mockAuthState = {
  isAuthenticated: true,
  isAuthResolved: true,
  signIn: () => mockSignIn(),
};

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => mockAuthState,
  useOxy: () => ({ openAccountDialog: mockOpenAccountDialog }),
}));

beforeEach(() => {
  mockAuthState.isAuthenticated = true;
  mockAuthState.isAuthResolved = true;
  mockSignIn.mockClear();
  mockOpenAccountDialog.mockClear();
});

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
      render({ loadOnRequest: true, hasMore: false, onRetryLoadMore: jest.fn() }).toJSON(),
    ).toBeNull();
  });

  it('offers nothing before there are rows', () => {
    expect(
      render({ loadOnRequest: true, hasItems: false, onRetryLoadMore: jest.fn() }).toJSON(),
    ).toBeNull();
  });
});

/**
 * Anonymous readers keep paging. The footer is the invitation to join, with
 * Create account as the primary action, and it is not a cap on how many posts
 * they can read.
 */
describe('FeedFooter for an anonymous reader', () => {
  const text = (tree: ReturnType<typeof render>) => JSON.stringify(tree.toJSON());

  beforeEach(() => {
    mockAuthState.isAuthenticated = false;
    mockAuthState.isAuthResolved = true;
  });

  it('offers create account first and sign in second', () => {
    const tree = render({});
    expect(text(tree)).toContain('auth.gate.title');
    const buttons = tree.root.findAllByType('Button' as never);
    expect(buttons.map((button) => button.props.children)).toEqual([
      'auth.banner.createAccount',
      'auth.banner.signIn',
    ]);
    expect(buttons[0]?.props.testID).toBe('anonymous-feed-gate-create-account');
    act(() => buttons[0]?.props.onPress());
    expect(mockOpenAccountDialog).toHaveBeenCalledWith('signup');
    expect(mockSignIn).not.toHaveBeenCalled();
    act(() => buttons[1]?.props.onPress());
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(mockOpenAccountDialog).toHaveBeenCalledTimes(1);
  });

  it('stays available while more pages exist, without a load-more stand-in', () => {
    const tree = render({ hasMore: true, isLoadingMore: true });
    expect(tree.root.findAllByType('Button' as never)).toHaveLength(2);
    expect(text(tree)).not.toContain('common.loadMore');
  });

  it('says nothing before there are rows', () => {
    expect(render({ hasItems: false }).toJSON()).toBeNull();
  });

  it('says nothing while the session is still resolving', () => {
    mockAuthState.isAuthResolved = false;
    expect(render({}).toJSON()).toBeNull();
    expect(mockOpenAccountDialog).not.toHaveBeenCalled();
    expect(mockSignIn).not.toHaveBeenCalled();
  });
});

describe('FeedFooter at the end of a home timeline', () => {
  const text = (tree: ReturnType<typeof render>) => JSON.stringify(tree.toJSON());

  it('says the reader is caught up', () => {
    expect(text(render({ hasMore: false, caughtUp: true }))).toContain('feed.caughtUp');
  });

  it('says nothing while there is more to load', () => {
    expect(render({ hasMore: true, caughtUp: true }).toJSON()).toBeNull();
  });

  it('says nothing unless the feed asks for it', () => {
    expect(render({ hasMore: false }).toJSON()).toBeNull();
  });
});
