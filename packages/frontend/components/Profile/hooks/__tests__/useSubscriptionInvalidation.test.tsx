import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useSubscription } from '../useSubscription';

/**
 * The profile bell and the activity-subscriptions screen read the SAME server
 * state through two different surfaces, so the only way they can disagree is a
 * missed (or mis-keyed) invalidation. This pins both: every toggle direction
 * invalidates, and it invalidates the EXACT key the screen subscribes to —
 * `viewerQueryKeys.subscriptions(viewerId)`, keyed on the VIEWER, never the
 * profile being subscribed to.
 */

const mockGetStatus = jest.fn();
const mockSubscribe = jest.fn();
const mockUnsubscribe = jest.fn();
const mockInvalidateQueries = jest.fn();

jest.mock('@/services/subscriptionService', () => ({
  subscriptionService: {
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
    subscribe: (...args: unknown[]) => mockSubscribe(...args),
    unsubscribe: (...args: unknown[]) => mockUnsubscribe(...args),
  },
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => mockInvalidateQueries(...args),
  }),
}));

jest.mock('@oxyhq/bloom/toast', () => ({ toast: jest.fn() }));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const VIEWER_ID = 'viewer-1';
const PROFILE_ID = 'author-9';

type SubscriptionResult = ReturnType<typeof useSubscription>;
let latestResult: SubscriptionResult | null = null;

function Probe() {
  latestResult = useSubscription(PROFILE_ID, VIEWER_ID, false);
  return null;
}

async function renderProbe() {
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  await act(async () => {
    renderer = TestRenderer.create(<Probe />);
  });
  return renderer as unknown as TestRenderer.ReactTestRenderer;
}

describe('useSubscription — activity-subscription list invalidation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    latestResult = null;
    mockGetStatus.mockReset().mockResolvedValue({ subscribed: false });
    mockSubscribe.mockReset().mockResolvedValue({ subscribed: true });
    mockUnsubscribe.mockReset().mockResolvedValue({ subscribed: false });
    mockInvalidateQueries.mockReset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('invalidates the viewer subscription list when subscribing', async () => {
    const renderer = await renderProbe();

    await act(async () => {
      await latestResult?.toggle();
    });

    expect(mockSubscribe).toHaveBeenCalledWith(PROFILE_ID);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: viewerQueryKeys.subscriptions(VIEWER_ID),
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('invalidates the viewer subscription list when unsubscribing', async () => {
    mockGetStatus.mockResolvedValue({ subscribed: true });
    const renderer = await renderProbe();

    await act(async () => {
      await latestResult?.toggle();
    });

    expect(mockUnsubscribe).toHaveBeenCalledWith(PROFILE_ID);
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: viewerQueryKeys.subscriptions(VIEWER_ID),
    });

    await act(async () => {
      renderer.unmount();
    });
  });

  it('keys the invalidation on the viewer, not on the profile being subscribed to', async () => {
    const renderer = await renderProbe();

    await act(async () => {
      await latestResult?.toggle();
    });

    const keys = mockInvalidateQueries.mock.calls.map(([arg]) => JSON.stringify(arg));
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toContain(VIEWER_ID);
      expect(key).not.toContain(PROFILE_ID);
    }

    await act(async () => {
      renderer.unmount();
    });
  });
});
