import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ProfileUnavailable } from '../ProfileUnavailable';

const mockSafeBack = jest.fn();
const mockEmptyState = jest.fn();

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key }),
}));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => mockSafeBack }));
jest.mock('@/assets/illustrations/NoUpdates', () => ({ NoUpdatesIllustration: () => null }));
jest.mock('@/components/common/EmptyState', () => ({
  EmptyState: (props: unknown) => {
    mockEmptyState(props);
    return null;
  },
}));

type Shown = {
  title?: string;
  subtitle?: string;
  action?: { onPress: () => void };
  error?: { message: string; onRetry: () => Promise<void> };
};

const lastShown = (): Shown => mockEmptyState.mock.calls[mockEmptyState.mock.calls.length - 1][0] as Shown;

beforeEach(() => jest.clearAllMocks());

/**
 * A missing account and a failed lookup are different answers
 * (OxyHQ/Mention#1124): the profile page used to say "Profile not found" for a
 * dropped connection too.
 */
describe('ProfileUnavailable', () => {
  it('says "Profile not found" with a way back when the account does not exist', () => {
    act(() => {
      TestRenderer.create(<ProfileUnavailable notFound onRetry={jest.fn()} />);
    });
    const shown = lastShown();
    expect(shown.title).toBe('Profile not found');
    expect(shown.error).toBeUndefined();
    act(() => shown.action?.onPress());
    expect(mockSafeBack).toHaveBeenCalled();
  });

  it('takes the screen’s own words for what a missing account means', () => {
    act(() => {
      TestRenderer.create(<ProfileUnavailable notFound onRetry={jest.fn()} notFoundMessage="No followers to show." />);
    });
    expect(lastShown().subtitle).toBe('No followers to show.');
  });

  it('offers a retry, and never "not found", when the lookup failed', async () => {
    const onRetry = jest.fn(async () => undefined);
    act(() => {
      TestRenderer.create(<ProfileUnavailable notFound={false} onRetry={onRetry} />);
    });
    const shown = lastShown();
    expect(shown.title).toBeUndefined();
    expect(shown.error?.message).toContain("couldn't be loaded");
    await shown.error?.onRetry();
    expect(onRetry).toHaveBeenCalled();
  });
});
