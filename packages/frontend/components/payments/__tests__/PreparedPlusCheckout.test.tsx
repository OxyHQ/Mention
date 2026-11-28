import type { ComponentProps } from 'react';
import type { PeableSheetCheckout } from '@peable.to/sdk/checkout/ui';
import TestRenderer, { act } from 'react-test-renderer';
import { PreparedPlusCheckout } from '../PreparedPlusCheckout';
import type { CheckoutReview } from '@/lib/payments/checkoutReview';
const mockCreate = jest.fn();
const mockPrepare = jest.fn();
const mockObserve = jest.fn();
const mockToast = jest.fn();
let mockProps: ComponentProps<typeof PeableSheetCheckout> | undefined;
// The SDK's UI entry is ESM-only under Jest: the sheet is a probe, the source helper its own rule.
jest.mock('@peable.to/sdk/checkout/ui', () => ({
  PeableSheetCheckout: (props: ComponentProps<typeof PeableSheetCheckout>) => {
    mockProps = props;
    return null;
  },
  intentSource: (id: string, clientSecret: string) =>
    clientSecret.startsWith(`${id}_secret_`) ? { type: 'payment_intent', id, clientSecret } : null,
}));
jest.mock('@/lib/payments/localProviderTest', () => ({
  createLocalProviderTestBinding: (...args: unknown[]) => mockCreate(...args),
}));
jest.mock('@/lib/payments/embeddedCheckout', () => ({
  prepareEmbeddedCheckout: (...args: unknown[]) => mockPrepare(...args),
  observeEmbeddedSubscription: (...args: unknown[]) => mockObserve(...args),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
const review: CheckoutReview = {
  productId: 'mention',
  offerId: 'month',
  offerVersion: 1,
  interval: 'month',
  currency: 'USD',
  amountMinorUnits: 599,
};
const binding = {
  apiUrl: 'http://127.0.0.1:4310',
  intentId: 'pi_0123456789abcdef01234567',
  clientSecret: 'pi_0123456789abcdef01234567_secret_fixture',
  livemode: false,
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
function render(operationKey = 'scope-key', onClose = jest.fn()) {
  let tree: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    tree = TestRenderer.create(
      <PreparedPlusCheckout
        review={review}
        href="http://localhost:8110/plus"
        operationKey={operationKey}
        onClose={onClose}
      />,
    );
  });
  return () => act(() => tree?.unmount());
}
beforeEach(() => {
  jest.clearAllMocks();
  mockProps = undefined;
  mockPrepare.mockResolvedValue(binding);
  mockObserve.mockResolvedValue(false);
});

it("opens Peable's sheet only for the prepared payment, bound to the reviewed terms", async () => {
  const pending = deferred();
  mockCreate.mockReturnValue(pending.promise);
  const unmount = render();
  expect(mockProps).toBeUndefined();
  await act(async () => pending.resolve(binding));
  expect(mockProps?.source).toEqual({
    type: 'payment_intent',
    id: binding.intentId,
    clientSecret: binding.clientSecret,
  });
  expect(mockProps?.gatewayUrl).toBe(binding.apiUrl);
  expect(mockProps?.expected).toEqual({ amount: '599', currency: 'USD', livemode: false });
  expect(mockProps?.order?.recurring).toEqual({ interval: 'month' });
  expect(mockProps?.outcome).toBeNull();
  unmount();
});

it('succeeds only once the subscription itself is observed active', async () => {
  jest.useFakeTimers();
  try {
    mockCreate.mockResolvedValue(binding);
    const unmount = render();
    await act(async () => {});
    await act(async () => mockProps?.onSettled('complete'));
    await act(async () => {});
    expect(mockObserve).toHaveBeenCalledWith(binding);
    expect(mockProps?.outcome).toBeNull();
    mockObserve.mockResolvedValue(true);
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    await act(async () => {});
    expect(mockProps?.outcome).toBe('succeeded');
    unmount();
  } finally {
    jest.useRealTimers();
  }
});

it('reads an expired payment as failed without observing', async () => {
  mockCreate.mockResolvedValue(binding);
  const unmount = render();
  await act(async () => {});
  await act(async () => mockProps?.onSettled('expired'));
  expect(mockProps?.outcome).toBe('failed');
  expect(mockObserve).not.toHaveBeenCalled();
  unmount();
});

it('retries a failed bootstrap with the same key and never replaces reviewed terms', async () => {
  mockCreate.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(binding);
  mockPrepare.mockResolvedValueOnce({
    ...binding,
    subscription: { ...binding.subscription, amountMinorUnits: 5750 },
  });
  const unmount = render('same-key');
  await act(async () => {});
  expect(mockToast).toHaveBeenCalledTimes(1);
  await act(async () => mockToast.mock.calls[0][1].action.onClick());
  expect(mockCreate.mock.calls.map((args) => args[0])).toEqual(['same-key', 'same-key']);
  expect(mockProps).toBeUndefined();
  expect(mockToast).toHaveBeenCalledTimes(2);
  unmount();
});

it('aborts on dismissal and discards a response from the previous sheet', async () => {
  const pending = deferred();
  mockCreate.mockReturnValue(pending.promise);
  const unmount = render('old-key');
  const signal = mockCreate.mock.calls[0][3] as AbortSignal;
  unmount();
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(binding));
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockToast).not.toHaveBeenCalled();
});
