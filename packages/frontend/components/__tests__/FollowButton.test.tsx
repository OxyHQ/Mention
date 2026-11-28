import type { ComponentProps } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { signInAs, signOutForTests } from '@/test-support/accountScope';
import { FollowButton } from '../FollowButton';

type Props = ComponentProps<typeof FollowButton>;
let mockViewerId: string | undefined = 'viewer-a';
let mockProps: Props | undefined;
const mockNotify = jest.fn();
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: mockViewerId ? { id: mockViewerId } : undefined }),
  FollowButton: (props: Props) => {
    mockProps = props;
    return null;
  },
}));
jest.mock('@/stores/feedRankingInvalidation', () => ({
  notifyFeedRankingChanged: (...args: unknown[]) => mockNotify(...args),
}));

/** The rendered viewer (`useAuth`) and the signed-in account (the scope), moved together as on device. */
function setViewer(id: string | undefined) {
  mockViewerId = id;
  signInAs(id ?? null);
}

beforeEach(() => {
  setViewer('viewer-a');
  mockProps = undefined;
  jest.clearAllMocks();
});

afterEach(signOutForTests);

function render(props: Props) {
  act(() => {
    TestRenderer.create(<FollowButton {...props} />);
  });
  if (!mockProps) throw new Error('SDK button did not render');
  return mockProps;
}

it('invalidates only accepted follow/unfollow, preserving the federated callback', () => {
  const bridge = jest.fn();
  const props = render({ userId: 'target', onFollowChange: bridge });
  // An optimistic update or rejected SDK mutation does not invoke this callback.
  expect(mockNotify).not.toHaveBeenCalled();
  props.onFollowChange?.(true);
  props.onFollowChange?.(false);
  expect(mockNotify.mock.calls).toEqual([['viewer-a'], ['viewer-a']]);
  expect(bridge.mock.calls).toEqual([[true], [false]]);
});

it('fences a late success to the originating viewer and suppresses stale consumer writes', () => {
  const bridge = jest.fn();
  const props = render({ userId: 'target', onFollowChange: bridge });
  setViewer('viewer-b');
  props.onFollowChange?.(false);
  expect(mockNotify).toHaveBeenCalledWith('viewer-a');
  expect(mockNotify).not.toHaveBeenCalledWith('viewer-b');
  expect(bridge).not.toHaveBeenCalled();
  setViewer(undefined);
  render({ userId: 'target' }).onFollowChange?.(true);
  expect(mockNotify).toHaveBeenCalledTimes(1);
});

it('uses actual bulk outcomes, including partial success, and forwards consumer results', () => {
  const changed = jest.fn();
  const followed = jest.fn();
  const unfollowed = jest.fn();
  const props = render({
    userIds: ['target'],
    onFollowChange: changed,
    onBulkFollow: followed,
    onBulkUnfollow: unfollowed,
  });
  if (!props.userIds) throw new Error('Expected bulk button');
  const failedFollow = { followedCount: 0, results: [] };
  const failedUnfollow = { unfollowedCount: 0, results: [] };
  props.onFollowChange?.(false);
  props.onBulkFollow?.(failedFollow);
  props.onBulkUnfollow?.(failedUnfollow);
  expect(mockNotify).not.toHaveBeenCalled();
  const partialFollow = {
    followedCount: 1,
    results: [
      { userId: 'one', success: true, alreadyFollowing: false },
      { userId: 'two', success: false, alreadyFollowing: false },
    ],
  };
  props.onBulkFollow?.(partialFollow);
  props.onBulkUnfollow?.({ unfollowedCount: 1, results: [] });
  expect(mockNotify).toHaveBeenCalledTimes(2);
  expect(followed).toHaveBeenCalledWith(partialFollow);
  expect(unfollowed).toHaveBeenCalledWith(failedUnfollow);
  expect(changed).toHaveBeenCalledWith(false);
  setViewer('viewer-b');
  props.onFollowChange?.(true);
  props.onBulkFollow?.(partialFollow);
  props.onBulkUnfollow?.({ unfollowedCount: 1, results: [] });
  expect(mockNotify.mock.calls).toEqual(Array.from({ length: 4 }, () => ['viewer-a']));
  expect(changed).toHaveBeenCalledTimes(1);
  expect(followed).toHaveBeenCalledTimes(2);
  expect(unfollowed).toHaveBeenCalledTimes(2);
});
