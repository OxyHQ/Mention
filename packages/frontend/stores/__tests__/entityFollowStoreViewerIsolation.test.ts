const mockGetStatus = jest.fn();
const mockFollow = jest.fn();
const mockUnfollow = jest.fn();

jest.mock('@/services/entityFollowService', () => ({
  entityFollowService: {
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
    follow: (...args: unknown[]) => mockFollow(...args),
    unfollow: (...args: unknown[]) => mockUnfollow(...args),
  },
}));

jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
  logger: {
    warn: jest.fn(),
  },
}));

// Install service mocks before loading the singleton store.
// eslint-disable-next-line import/first
import { useEntityFollowStore } from '../entityFollowStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('entityFollowStore viewer isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useEntityFollowStore.getState().reset();
  });

  it('discards A status when it resolves after B owns the store', async () => {
    const pendingA = deferred<boolean>();
    const pendingB = deferred<boolean>();
    mockGetStatus
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise);

    const requestA = useEntityFollowStore
      .getState()
      .fetchStatus('list', 'shared-list');

    useEntityFollowStore.getState().reset();
    const requestB = useEntityFollowStore
      .getState()
      .fetchStatus('list', 'shared-list');

    pendingB.resolve(false);
    await requestB;
    expect(useEntityFollowStore.getState().following['list:shared-list'])
      .toBe(false);

    pendingA.resolve(true);
    await requestA;
    expect(useEntityFollowStore.getState().following['list:shared-list'])
      .toBe(false);
  });

  it('does not let an A mutation rollback overwrite B state', async () => {
    const pendingA = deferred<void>();
    mockFollow.mockReturnValueOnce(pendingA.promise);

    const requestA = useEntityFollowStore
      .getState()
      .toggleFollow('hashtag', 'shared-hashtag');

    useEntityFollowStore.getState().reset();
    useEntityFollowStore
      .getState()
      .setStatus('hashtag', 'shared-hashtag', true);

    pendingA.reject(new Error('late A failure'));
    await requestA;

    expect(
      useEntityFollowStore.getState().following[
        'hashtag:shared-hashtag'
      ],
    )
      .toBe(true);
  });
});
