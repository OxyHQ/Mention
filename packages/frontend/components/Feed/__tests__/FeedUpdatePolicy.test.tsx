import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { FeedUpdatePolicyProvider, useFeedLiveUpdates } from '../FeedUpdatePolicy';

const mockOwner = { addEventListener: jest.fn(), removeEventListener: jest.fn() };
const mockViewport = {
  kind: 'element',
  scrollRef: { current: mockOwner },
  metrics: { scrollY: { value: 0 } },
};
const mockSubscribe = jest.fn();
jest.mock('@oxy.so/bloom/screen', () => ({
  ...jest.requireActual('@oxy.so/bloom/screen'),
  useScreenViewport: () => mockViewport,
}));
jest.mock('@/services/socketService', () => ({
  socketService: { subscribeToFeedUpdates: (...args: unknown[]) => mockSubscribe(...args) },
}));
function Feed({ refresh }: { refresh: () => Promise<void> }) {
  useFeedLiveUpdates('explore', refresh, true);
  return null;
}
describe('panel live feed policy', () => {
  let tree: ReactTestRenderer;
  let notify: () => void;
  let unsubscribe: jest.Mock;
  const previousDocument = globalThis.document;
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockViewport.metrics.scrollY.value = 0;
    unsubscribe = jest.fn();
    mockSubscribe.mockImplementation((_type, callback) => {
      notify = callback;
      return unsubscribe;
    });
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { hidden: false, addEventListener: jest.fn(), removeEventListener: jest.fn() },
    });
  });
  afterEach(() => {
    act(() => tree?.unmount());
    jest.useRealTimers();
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
  });
  it('coalesces events and holds pending refresh until the reader returns to the top', async () => {
    const refresh = jest.fn(async () => {});
    act(() => {
      tree = create(
        <FeedUpdatePolicyProvider enabled pauseWhileReading>
          <Feed refresh={refresh} />
        </FeedUpdatePolicyProvider>,
      );
    });
    expect(mockSubscribe).toHaveBeenCalledWith('for_you', expect.any(Function));
    mockViewport.metrics.scrollY.value = 400;
    notify();
    notify();
    notify();
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(refresh).not.toHaveBeenCalled();
    mockViewport.metrics.scrollY.value = 0;
    const onScroll = mockOwner.addEventListener.mock.calls.find(
      ([event]) => event === 'scroll',
    )![1];
    onScroll();
    await act(async () => {
      jest.advanceTimersByTime(200);
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('does not subscribe when automatic refresh is off', () => {
    act(() => {
      tree = create(
        <FeedUpdatePolicyProvider enabled={false} pauseWhileReading>
          <Feed refresh={async () => {}} />
        </FeedUpdatePolicyProvider>,
      );
    });
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});
