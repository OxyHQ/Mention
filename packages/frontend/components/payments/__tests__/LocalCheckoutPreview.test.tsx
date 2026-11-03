import TestRenderer, { act } from 'react-test-renderer';
import { LocalCheckoutPreview } from '../LocalCheckoutPreview';
import type { PeableCheckoutSheetProps } from '@peable.to/sdk/checkout/ui';
let mockContent: PeableCheckoutSheetProps;
const mockClose = jest.fn();
jest.mock('@oxy.so/stickers/react', () => ({ useSticker: jest.fn() }));
jest.mock('@/components/common/EmptyStateSticker', () => ({ EmptyStateSticker: () => null }));
jest.mock('../LocalCheckoutCardEntry', () => ({ LocalCheckoutCardEntry: () => null }));
jest.mock('@peable.to/sdk/checkout/ui', () => ({
  PeableCheckoutSheet: (props: PeableCheckoutSheetProps) => {
    mockContent = props;
    return null;
  },
}));
jest.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: (props: {
    children: React.ReactNode;
    header?: { largeTitle: boolean; showClose: boolean; onBack?: () => void };
    footer?: React.ReactNode;
  }) => {
    return <>{props.children}</>;
  },
}));
jest.mock('@/hooks/usePlusOffer', () => ({
  usePlusOffer: () => ({
    offer: { displayName: 'Mention Plus', price: { currency: 'USD', amountMinorUnits: 599 } },
  }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.useFakeTimers();
  mockClose.mockClear();
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});
function mount(
  scenario: 'subscription' | 'physical' | 'trial' = 'subscription',
  authorize?: () => Promise<'authorized' | 'cancelled'>,
  outcome: 'success' | 'failure' | 'loading' = 'success',
) {
  act(() => {
    renderer = TestRenderer.create(
      <LocalCheckoutPreview
        cadence="month"
        scenario={scenario}
        outcome={outcome}
        onClose={mockClose}
        authorize={authorize}
      />,
    );
  });
}
it('separates a zero-due trial preview from its future recurring payment without inventing a Mention trial', () => {
  mount('trial');
  expect(mockContent.request.dueTodayMinorUnits).toBe(0);
  expect(mockContent.request.recurring).toMatchObject({ amountMinorUnits: 599, interval: 'month' });
  expect(mockContent.request.recurring?.startsOn).toBeTruthy();
  expect(mockContent.request.merchant).not.toBe('Mention');
  expect(mockContent.request.requiresShipping).toBe(false);
});
it('keeps subscription and physical requirements separate', () => {
  mount();
  expect(mockContent.request.requiresShipping).toBe(false);
  expect(mockContent.request.dueTodayMinorUnits).toBe(599);
  act(() =>
    renderer.update(
      <LocalCheckoutPreview
        cadence="month"
        scenario="physical"
        outcome="success"
        onClose={mockClose}
      />,
    ),
  );
  expect(mockContent.request.requiresShipping).toBe(true);
  expect(mockContent.request.recurring).toBeUndefined();
});
it('keeps only opted-in masked card metadata for this mounted session and preserves draft on Back', () => {
  mount();
  const card = { id: 'demo', brand: 'Visa' as const, last4: '4242', saveForLater: true };
  act(() => mockContent.onCard(card));
  expect(mockContent.savedCards).toEqual([card]);
  expect(Object.keys(mockContent.savedCards[0]).sort()).toEqual([
    'brand',
    'id',
    'last4',
    'saveForLater',
  ]);
  act(() => mockContent.onStep('contact'));
  act(() => mockContent.onDraft({ ...mockContent.draft, email: 'edited@example.test' }));
  act(() => mockContent.onBack());
  expect(mockContent.step).toBe('review');
  expect(mockContent.draft.email).toBe('edited@example.test');
  act(() => renderer.unmount());
  mount();
  expect(mockContent.savedCards).toEqual([]);
  expect(mockContent.draft.card).toBeNull();
});
it('simulates completion only after required details and honors optional authorization cancellation', async () => {
  const authorize = jest.fn().mockResolvedValue('cancelled');
  mount('subscription', authorize);
  await act(async () => mockContent.onAuthorize());
  expect(authorize).not.toHaveBeenCalled();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  expect(authorize).toHaveBeenCalledTimes(1);
  expect(mockContent.step).toBe('review');
  authorize.mockResolvedValue('authorized');
  await act(async () => {
    mockContent.onAuthorize();
    mockContent.onAuthorize();
  });
  expect(authorize).toHaveBeenCalledTimes(2);
  expect(mockContent.step).toBe('processing');
  expect(mockContent.resultIllustration).toBeUndefined();
  act(() => jest.advanceTimersByTime(1000));
  expect(mockContent.step).toBe('success');
  expect(mockContent.resultIllustration).toMatchObject({ props: { name: 'checkoutSuccess' } });
});
it('does not update after a pending authorization resolves following dismissal', async () => {
  let finish: ((value: 'authorized') => void) | undefined;
  mount(
    'subscription',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  act(() => mockContent.onAuthorize());
  act(() => renderer.unmount());
  const schedule = jest.spyOn(global, 'setTimeout');
  await act(async () => finish?.('authorized'));
  expect(schedule.mock.calls.some(([, delay]) => delay === 1000)).toBe(false);
  schedule.mockRestore();
  expect(mockContent.step).toBe('processing');
});

it('restores the logo then closes once after accessible success, cancelling on dismissal', async () => {
  mount();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => jest.advanceTimersByTime(1000));
  expect(mockContent.step).toBe('success');
  act(() => jest.advanceTimersByTime(1499));
  expect(mockClose).not.toHaveBeenCalled();
  act(() => jest.advanceTimersByTime(1));
  expect(mockContent.brandState).toBe('idle');
  act(() => mockContent.onClose());
  act(() => jest.advanceTimersByTime(300));
  expect(mockClose).toHaveBeenCalledTimes(1);
});

it('closes automatically only after the complete success presentation', async () => {
  mount();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => jest.advanceTimersByTime(1000));
  act(() => jest.advanceTimersByTime(1800));
  expect(mockClose).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(10000));
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('keeps failures open for retry and cancels completion when navigating away', async () => {
  mount('subscription', undefined, 'failure');
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => jest.advanceTimersByTime(1000));
  expect(mockContent.step).toBe('failure');
  expect(mockContent.resultIllustration).toMatchObject({ props: { name: 'checkoutFailure' } });
  act(() => jest.advanceTimersByTime(10000));
  expect(mockClose).not.toHaveBeenCalled();
  act(() => renderer.unmount());
  mount();
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  await act(async () => mockContent.onAuthorize());
  act(() => jest.advanceTimersByTime(1000));
  act(() => mockContent.onStep('review'));
  act(() => jest.advanceTimersByTime(1800));
  expect(mockClose).not.toHaveBeenCalled();
});
it('ignores an authorization result after close even if the host has not unmounted yet', async () => {
  let finish: ((value: 'authorized') => void) | undefined;
  mount(
    'subscription',
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  act(() => mockContent.onCard({ id: 'test', brand: 'Visa', last4: '4242', saveForLater: false }));
  act(() => mockContent.onAuthorize());
  act(() => mockContent.onClose());
  await act(async () => finish?.('authorized'));
  act(() => jest.advanceTimersByTime(10000));
  expect(mockContent.step).toBe('processing');
  expect(mockClose).toHaveBeenCalledTimes(1);
});
