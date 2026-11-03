import { useEffect as mockUseEffect } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PeableCheckoutSheetProps,
  PeableProviderFieldsProps,
} from '@peable.to/sdk/checkout/ui';
import { PeableEmbeddedCheckout } from '../PeableEmbeddedCheckout';
let mockSheet: PeableCheckoutSheetProps;
let mockUpdate: (value: typeof intent) => void;
const mockUnsubscribe = jest.fn();
const mockConfirm = jest.fn();
const mockPrepare = jest.fn();
const mockDispose = jest.fn();
const mockObserve = jest.fn();
jest.mock('@/lib/payments/embeddedCheckout', () => ({
  ...jest.requireActual('@/lib/payments/embeddedCheckout'),
  observeEmbeddedSubscription: (...args: unknown[]) => mockObserve(...args),
}));
const mockPlay = jest.fn();
const mockClose = jest.fn();
const intent = {
  id: 'pi_localtest',
  rail: 'card',
  currency: 'USD',
  amount: '599',
  status: 'created',
};
const mockRead = jest.fn();
const mockAction = jest.fn();
jest.mock('@peable.to/sdk/checkout', () => ({
  createPeableCheckout: () => ({
    getPaymentIntent: mockRead,
    getClientAction: mockAction,
    subscribe: jest.fn(async (_id: string, _secret: string, update: typeof mockUpdate) => {
      mockUpdate = update;
      return { unsubscribe: mockUnsubscribe };
    }),
  }),
}));
jest.mock('@peable.to/sdk/checkout/ui', () => ({
  PeableCheckoutSheet: (props: PeableCheckoutSheetProps) => {
    mockSheet = props;
    return <>{props.step === 'card' ? props.cardEntry : null}</>;
  },
  PeableProviderFields: (props: PeableProviderFieldsProps) => {
    mockUseEffect(() => {
      props.onReady(mockPrepare);
      return () => props.onReady(null);
    }, []);
    return null;
  },
}));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: React.ReactNode;
    onPress(): void;
    disabled: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));
jest.mock('@oxy.so/bloom/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mockTranslate, i18n: { language: 'en' } }),
}));
const mockTranslate = (key: string) => key;
jest.mock('@/hooks/useCheckoutFeedback', () => ({
  useCheckoutFeedback: () => ({ play: mockPlay, stop: jest.fn() }),
}));
const binding = {
  environment: 'test' as const,
  apiUrl: 'http://127.0.0.1:4310',
  intentId: 'pi_localtest',
  clientSecret: 'opaque-payer-capability',
};
let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => {
  jest.useFakeTimers();
  mockConfirm.mockReset();
  mockDispose.mockClear();
  mockObserve.mockReset().mockResolvedValue(true);
  mockPrepare.mockReset().mockResolvedValue({
    prepared: true,
    authorization: {
      card: { brand: 'visa', last4: '4242' },
      confirm: mockConfirm,
      dispose: mockDispose,
    },
  });
  mockPlay.mockClear();
  mockClose.mockClear();
  mockUnsubscribe.mockClear();
  mockRead.mockReset().mockResolvedValue(intent);
  mockAction.mockResolvedValue({
    kind: 'client_secret',
    publishableKey: 'pk_test_fixture',
    value: 'provider-confirmation-capability',
  });
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});
async function mount(
  customBinding: import('@/lib/payments/embeddedCheckout').EmbeddedCheckoutBinding = binding,
) {
  await act(async () => {
    renderer = TestRenderer.create(
      <PeableEmbeddedCheckout binding={customBinding} onClose={mockClose} />,
    );
  });
}
async function prepare() {
  act(() => mockSheet.onStep('card'));
  const button = renderer.root.findAllByType('button').find((entry) => !entry.props.disabled);
  if (!button) throw new Error('Expected complete card Continue action');
  await act(async () => {
    button.props.onClick();
  });
}
it('Continue prepares without charging, then explicit Pay runs once and waits for gateway settlement', async () => {
  let resolve: ((value: { accepted: true }) => void) | undefined;
  mockConfirm.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  await prepare();
  expect(mockPrepare).toHaveBeenCalledTimes(1);
  expect(mockConfirm).not.toHaveBeenCalled();
  expect(mockSheet.step).toBe('confirmation');
  expect(mockSheet.draft.card?.last4).toBe('4242');
  expect(renderer.root.findAllByType('button')).toHaveLength(0);
  act(() => {
    mockSheet.onAuthorize();
    mockSheet.onAuthorize();
  });
  expect(mockSheet.step).toBe('confirmation');
  expect(mockSheet.interactionBlocked).toBe(true);
  expect(mockConfirm).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve?.({ accepted: true });
  });
  expect(mockSheet.step).toBe('processing');
  expect(mockPlay).not.toHaveBeenCalled();
  act(() => mockUpdate({ ...intent, status: 'settled' }));
  expect(mockSheet.step).toBe('success');
  act(() => mockUpdate({ ...intent, status: 'settled' }));
  expect(mockPlay).toHaveBeenCalledTimes(1);
  act(() => jest.advanceTimersByTime(1500));
  expect(mockSheet.brandState).toBe('idle');
  act(() => jest.advanceTimersByTime(300));
  expect(mockClose).toHaveBeenCalledTimes(1);
});
it('refuses a provider key from the wrong environment', async () => {
  mockAction.mockResolvedValue({
    kind: 'client_secret',
    publishableKey: 'pk_live_forbidden',
    value: 'unused',
  });
  await mount();
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockConfirm).not.toHaveBeenCalled();
});
it('failed authorization stays recoverable and Back invalidates the prepared card', async () => {
  mockConfirm.mockResolvedValue({ accepted: false, error: 'Declined' });
  await mount();
  await prepare();
  await act(async () => {
    mockSheet.onAuthorize();
  });
  expect(mockSheet.step).toBe('confirmation');
  expect(mockSheet.interactionBlocked).toBe(false);
  act(() => mockSheet.onBack());
  expect(mockDispose).toHaveBeenCalled();
  expect(mockSheet.step).toBe('card');
  expect(mockSheet.draft.card).toBeNull();
  expect(mockPlay).not.toHaveBeenCalled();
});
it('pending authentication cannot close or regress a final observed settlement', async () => {
  let finish: ((value: { accepted: false; error: string }) => void) | undefined;
  mockConfirm.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await mount();
  await prepare();
  act(() => mockSheet.onAuthorize());
  act(() => {
    mockUpdate({ ...intent, status: 'confirming' });
    mockSheet.onClose();
  });
  expect(mockSheet.step).toBe('confirmation');
  expect(mockClose).not.toHaveBeenCalled();
  act(() => mockUpdate({ ...intent, status: 'settled' }));
  await act(async () => {
    finish?.({ accepted: false, error: 'Late client error' });
  });
  expect(mockSheet.step).toBe('success');
  expect(mockSheet.notice).toBeUndefined();
  act(() => mockUpdate({ ...intent, status: 'created' }));
  expect(mockSheet.step).toBe('success');
});
it('unexpected preparation rejection unlocks the form without charging', async () => {
  mockPrepare.mockRejectedValue(new Error('Offline'));
  await mount();
  await prepare();
  expect(mockSheet.step).toBe('card');
  expect(mockSheet.interactionBlocked).toBe(false);
  expect(mockConfirm).not.toHaveBeenCalled();
});
it('subscription success requires paid invoice and active subscription, not only settled payment', async () => {
  mockObserve.mockResolvedValue(false);
  await mount({
    ...binding,
    subscription: {
      id: 'sub_fixture',
      interval: 'month',
      amountMinorUnits: 599,
      currency: 'USD',
      observationPath: '/observation',
    },
  });
  expect(mockSheet.request.recurring?.interval).toBe('month');
  expect(mockSheet.request.tax).toBeUndefined();
  act(() => mockUpdate({ ...intent, status: 'settled' }));
  expect(mockSheet.step).toBe('processing');
  expect(mockPlay).not.toHaveBeenCalled();
  mockRead.mockResolvedValue({ ...intent, status: 'settled' });
  mockObserve.mockResolvedValue(true);
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(mockSheet.step).toBe('success');
});
it('serializes slow subscription polling', async () => {
  let release: ((ready: boolean) => void) | undefined;
  mockObserve.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await mount({
    ...binding,
    subscription: {
      id: 'sub_fixture',
      interval: 'year',
      amountMinorUnits: 599,
      currency: 'USD',
      observationPath: '/observation',
    },
  });
  await act(async () => {
    jest.advanceTimersByTime(12000);
  });
  expect(mockObserve).toHaveBeenCalledTimes(1);
  expect(mockRead).toHaveBeenCalledTimes(1);
  await act(async () => {
    release?.(false);
  });
});

it('shows unavailable Peable rails without authorizing them or fabricating wallet data', async () => {
  await mount({
    ...binding,
    paymentMethods: [
      { id: 'card', available: true },
      { id: 'bank', available: false, reason: 'subscription_method_not_configured' },
      { id: 'installments', available: false, reason: 'installment_offer_not_configured' },
      { id: 'faircoin', available: false, reason: 'merchant_receive_key_missing' },
    ],
  });
  expect(mockSheet.request.paymentMethods).toEqual(['card']);
  expect(mockSheet.paymentMethods?.map((method) => method.id)).toEqual([
    'bank',
    'installments',
    'faircoin',
  ]);
  expect(mockSheet.paymentMethods?.every((method) => method.disabled)).toBe(true);
  expect(mockSheet.paymentMethods?.find((method) => method.id === 'faircoin')?.detail).toContain(
    'faircoinUnavailable',
  );
  expect(mockSheet.onMethod).toBeUndefined();
});

it('prepares verified payer data before presentation and renders review immediately', async () => {
  const { prepareEmbeddedCheckout } = jest.requireActual('@/lib/payments/embeddedCheckout');
  const prepared = await prepareEmbeddedCheckout(binding);
  expect(prepared.initial.intent.id).toBe(binding.intentId);
  mockRead.mockImplementation(() => new Promise(() => {}));
  await mount(prepared);
  expect(mockSheet.step).toBe('review');
  expect(mockSheet.request.dueTodayMinorUnits).toBe(599);
});

it('rejects aborted or mismatched preparation without opening checkout', async () => {
  const { prepareEmbeddedCheckout } = jest.requireActual('@/lib/payments/embeddedCheckout');
  const controller = new AbortController();
  controller.abort();
  await expect(prepareEmbeddedCheckout(binding, controller.signal)).rejects.toThrow();
  mockRead.mockResolvedValue({ ...intent, id: 'pi_other' });
  await expect(prepareEmbeddedCheckout(binding)).rejects.toThrow();
  expect(mockPrepare).not.toHaveBeenCalled();
  expect(mockConfirm).not.toHaveBeenCalled();
});
