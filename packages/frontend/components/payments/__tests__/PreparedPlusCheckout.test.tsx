import type { ComponentProps } from 'react';
import type { PeableEmbeddedCheckout } from '../PeableEmbeddedCheckout';
import TestRenderer, { act } from 'react-test-renderer';
import { PreparedPlusCheckout } from '../PreparedPlusCheckout';
import type { CheckoutReview } from '@/lib/payments/checkoutReview';
const mockCreate = jest.fn();
const mockPrepare = jest.fn();
const mockToast = jest.fn();
let mockProps: ComponentProps<typeof PeableEmbeddedCheckout>;
let mockMounts = 0;
jest.mock('../PeableEmbeddedCheckout', () => ({
  PeableEmbeddedCheckout: (props: ComponentProps<typeof PeableEmbeddedCheckout>) => {
    const React = require('react');
    React.useEffect(() => {
      mockMounts += 1;
    }, []);
    mockProps = props;
    return null;
  },
}));
jest.mock('@/lib/payments/localProviderTest', () => ({
  createLocalProviderTestBinding: (...args: unknown[]) => mockCreate(...args),
}));
jest.mock('@/lib/payments/embeddedCheckout', () => ({
  prepareEmbeddedCheckout: (...args: unknown[]) => mockPrepare(...args),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const review: CheckoutReview = {
  productId: 'mention',
  offerId: 'month',
  offerVersion: 1,
  interval: 'month',
  currency: 'USD',
  amountMinorUnits: 599,
};
const binding = {
  intentId: 'pi_fixture',
  subscription: { interval: 'month', currency: 'USD', amountMinorUnits: 599 },
  initial: { intent: { amount: '599', currency: 'USD' } },
};
function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockMounts = 0;
  mockPrepare.mockResolvedValue(binding);
});
it('shows immutable review before the response and hydrates the same sheet', async () => {
  const pending = deferred();
  mockCreate.mockReturnValue(pending.promise);
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(
      <PreparedPlusCheckout
        review={review}
        href="http://localhost:8110/plus"
        operationKey="scope-key"
        onClose={jest.fn()}
      />,
    );
  });
  expect(mockProps.review).toBe(review);
  expect(mockProps.binding).toBeUndefined();
  expect(mockMounts).toBe(1);
  await act(async () => pending.resolve(binding));
  expect(mockProps.binding).toEqual(binding);
  expect(mockMounts).toBe(1);
  act(() => tree?.unmount());
});
it('retries a failed bootstrap with the same key and never replaces reviewed terms', async () => {
  mockCreate.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(binding);
  mockPrepare.mockResolvedValueOnce({
    ...binding,
    subscription: { ...binding.subscription, amountMinorUnits: 5750 },
  });
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(
      <PreparedPlusCheckout
        review={review}
        href="http://localhost:8110/plus"
        operationKey="same-key"
        onClose={jest.fn()}
      />,
    );
  });
  expect(mockToast).toHaveBeenCalledTimes(1);
  await act(async () => mockProps.onRetry?.());
  expect(mockCreate.mock.calls.map((args) => args[0])).toEqual(['same-key', 'same-key']);
  expect(mockProps.binding).toBeUndefined();
  expect(mockToast).toHaveBeenCalledTimes(2);
  act(() => tree?.unmount());
});
it('aborts on dismissal and discards a response from the previous sheet', async () => {
  const pending = deferred();
  mockCreate.mockReturnValue(pending.promise);
  let tree: TestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    tree = TestRenderer.create(
      <PreparedPlusCheckout
        review={review}
        href="http://localhost:8110/plus"
        operationKey="old-key"
        onClose={jest.fn()}
      />,
    );
  });
  const signal = mockCreate.mock.calls[0][3] as AbortSignal;
  act(() => tree?.unmount());
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(binding));
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
});
