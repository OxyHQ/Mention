import TestRenderer, { act } from 'react-test-renderer';
import type { PeableOrderDetailsSheetProps } from '@peable.to/sdk/checkout/ui';
import { LocalOrderPreview } from '../LocalOrderPreview';
let mockProps: PeableOrderDetailsSheetProps;
const mockEligible = jest.fn((..._args: unknown[]) => true);
jest.mock('@peable.to/sdk/checkout/ui', () => ({
  PeableOrderDetailsSheet: (props: PeableOrderDetailsSheetProps) => {
    mockProps = props;
    return null;
  },
  availableOrderReward: (...args: unknown[]) => mockEligible(...args),
  matchingRewardOffers: (reward: { offers: unknown[] }) => reward.offers,
}));
jest.mock('@oxy.so/bloom/shapes', () => ({ Image: () => null }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
beforeEach(() => mockEligible.mockReset().mockReturnValue(true));
it('keeps quoted paid/remaining and requires an explicit idempotent local claim', () => {
  let tree: TestRenderer.ReactTestRenderer;
  const close = jest.fn();
  act(() => {
    tree = TestRenderer.create(
      <LocalOrderPreview
        paidMinorUnits={700}
        payments={[{ id: 'one', date: '2026-11-03', amountMinorUnits: 700, status: 'paid' }]}
        onClose={close}
      />,
    );
  });
  expect(mockProps.order.paidMinorUnits).toBe(700);
  expect(mockProps.order.remainingMinorUnits).toBe(2100);
  expect(mockProps.screen).toBe('order');
  expect(mockEligible).not.toHaveBeenCalled();
  const reward = mockProps.reward;
  if (!reward) throw new Error('Expected explicitly supplied fixture reward');
  const first = reward.offers[0];
  const second = reward.offers[1];
  if (!first || !second) throw new Error('Expected fixture offers');
  const staleClaim = mockProps.onClaim;
  act(() => {
    staleClaim(first);
    staleClaim(second);
  });
  expect(mockEligible).toHaveBeenCalledTimes(1);
  expect(mockProps.selectedOfferId).toBe(first.id);
  expect(mockProps.claimedOffer?.id).toBe(first.id);
  expect(mockProps.screen).toBe('claimed');
  expect(mockProps.order.paidMinorUnits).toBe(700);
  expect(close).not.toHaveBeenCalled();
  act(() => tree.unmount());
});
it('a rejected eligibility check stays recoverable and never changes payment totals', () => {
  mockEligible.mockReturnValue(false);
  let tree: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <LocalOrderPreview paidMinorUnits={2800} payments={[]} onClose={jest.fn()} />,
    );
  });
  const offer = mockProps.reward?.offers[0];
  if (!offer) throw new Error('Expected fixture offer');
  act(() => mockProps.onClaim(offer));
  expect(mockProps.screen).toBe('order');
  expect(mockProps.claimError).toBe('This gift is no longer available.');
  expect(mockProps.claimedOffer).toBeUndefined();
  expect(mockProps.order.paidMinorUnits).toBe(2800);
  expect(mockProps.order.remainingMinorUnits).toBe(0);
  act(() => tree.unmount());
});
