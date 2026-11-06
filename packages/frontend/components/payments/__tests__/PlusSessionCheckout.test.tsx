import TestRenderer, { act } from 'react-test-renderer';
import type { PeableCheckoutSheetProps } from '@peable.to/sdk/checkout/ui';
import { PlusSessionCheckout } from '../PlusSessionCheckout';

let mockSheet: PeableCheckoutSheetProps;
const mockRead = jest.fn();
const mockConfirm = jest.fn();
jest.mock('@peable.to/sdk/checkout', () => ({
  createPeableCheckout: () => ({
    getCheckoutSession: mockRead,
    confirmCheckoutSession: mockConfirm,
  }),
  sessionIdFromClientSecret: (secret: string) =>
    /^(cs_[0-9a-f]{24,})_secret_[0-9a-f]{16,}$/.exec(secret)?.[1] ?? null,
  payDeepLinkFor: (intent: { id: string; client_secret: string }) =>
    `peable://pay?intent=${intent.id}&secret=${intent.client_secret}`,
}));
jest.mock('@peable.to/sdk/checkout/ui', () => ({
  PeableCheckoutSheet: (props: PeableCheckoutSheetProps) => {
    mockSheet = props;
    return (
      <>
        {props.step === 'card' ? props.cardEntry : null}
        {props.step === 'method' && !props.methodDetails ? props.methodContent : null}
      </>
    );
  },
}));
jest.mock('@oxy.so/bloom/button', () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress(): void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    i18n: { language: 'en' },
  }),
}));

const SESSION = 'cs_0123456789abcdef01234567';
const capability = { sessionId: SESSION, clientSecret: `${SESSION}_secret_0123456789abcdef` };
const hostedUrl = `https://checkout.peable.to/c/${SESSION}#cs=${capability.clientSecret}`;
const offer = {
  offerId: 'mention_plus_monthly',
  offerVersion: 1,
  productId: 'mention',
  displayName: 'Mention Plus',
  price: { currency: 'USD', amountMinorUnits: 599, interval: 'month' },
} as unknown as import('@/lib/payments/plusCheckout').PlusOffer;
const faircoinIntent = {
  id: 'pi_fair',
  rail: 'faircoin',
  status: 'requires_action',
  amount: '12345678900',
  currency: 'FAIR',
  client_secret: 'pi_fair_secret',
  cancellation_reason: null,
  next_action: {
    type: 'faircoin_payment',
    faircoin_payment: { address: 'fAddr', network: 'mainnet', amount: '12345678900', uri: 'x' },
  },
  faircoin: {
    network: 'mainnet',
    address: 'fAddr',
    txid: null,
    confirmations: 0,
    required_confirmations: 6,
    quote: {
      currency: 'USD',
      amount: '599',
      rate: '0.04852',
      quoted_at: Math.floor(Date.now() / 1000),
      expires_at: Math.floor(Date.now() / 1000) + 600,
    },
  },
};
function session(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION,
    mode: 'subscription',
    status: 'open',
    currency: 'USD',
    amount_total: '599',
    payment_method_types: ['card', 'faircoin'],
    faircoin: { available: true, unavailable_reason: null },
    payment_intent: null,
    ...overrides,
  };
}

const onSettled = jest.fn();
const onUnavailable = jest.fn();
const onClose = jest.fn();
const openHosted = jest.fn(async (_url: string, before?: () => Promise<boolean>) => {
  await before?.();
});
let renderer: TestRenderer.ReactTestRenderer;
async function mount() {
  await act(async () => {
    renderer = TestRenderer.create(
      <PlusSessionCheckout
        capability={capability}
        hostedUrl={hostedUrl}
        offer={offer}
        openHosted={openHosted}
        onSettled={onSettled}
        onUnavailable={onUnavailable}
        onClose={onClose}
      />,
    );
  });
}
function text() {
  return JSON.stringify(renderer.toJSON());
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockRead.mockResolvedValue(session());
});
afterEach(() => {
  act(() => renderer?.unmount());
  jest.useRealTimers();
});

it('always lists FairCoin; unavailable, it is disabled with the reason and never confirmed', async () => {
  mockRead.mockResolvedValue(
    session({ faircoin: { available: false, unavailable_reason: 'faircoin_wallet_missing' } }),
  );
  await mount();
  expect(mockSheet.request.paymentMethods).toEqual(['card']);
  expect(mockSheet.paymentMethods).toEqual([
    expect.objectContaining({
      id: 'faircoin',
      label: 'FairCoin',
      disabled: true,
      detail: 'plus.checkout.faircoin.unavailable.walletMissing',
    }),
  ]);
  await act(async () => mockSheet.onMethod?.('faircoin'));
  expect(mockConfirm).not.toHaveBeenCalled();
  expect(mockSheet.request.dueTodayMinorUnits).toBe(599);
  expect(mockSheet.request.currency).toBe('USD');
});

it('confirms FairCoin by the payer’s choice and shows the quoted Peable request', async () => {
  mockConfirm.mockResolvedValue(session({ payment_intent: faircoinIntent }));
  await mount();
  expect(mockSheet.request.paymentMethods).toEqual(['card', 'faircoin']);
  await act(async () => mockSheet.onMethod?.('faircoin'));
  expect(mockConfirm).toHaveBeenCalledWith(SESSION, capability.clientSecret, {
    payment_method_type: 'faircoin',
  });
  expect(mockSheet.step).toBe('method');
  const details = mockSheet.methodDetails;
  if (details?.kind !== 'faircoin') throw new Error('no FairCoin presentation');
  expect(details.amountLabel).toBe('123.456789 FAIR');
  expect(details.quoteDescription).toContain('plus.checkout.faircoin.quote');
  expect(details.quoteDescription).toContain('0.04852');
  expect(details.quoteDescription).toContain('plus.checkout.faircoin.holdsUntil');
  expect(details.external?.payload).toBe('peable://pay?intent=pi_fair&secret=pi_fair_secret');
});

it('shows a confirm refusal in words on the FairCoin step', async () => {
  mockConfirm.mockRejectedValue(
    Object.assign(new Error('no wallet'), { code: 'faircoin_wallet_missing' }),
  );
  await mount();
  await act(async () => mockSheet.onMethod?.('faircoin'));
  expect(text()).toContain('plus.checkout.faircoin.unavailable.walletMissing');
  expect(mockSheet.methodDetails).toBeUndefined();
});

it('switches an unpaid FairCoin payment back to the card before opening the hosted page', async () => {
  mockConfirm
    .mockResolvedValueOnce(session({ payment_intent: faircoinIntent }))
    .mockResolvedValueOnce(
      session({ payment_intent: { ...faircoinIntent, rail: 'card', faircoin: null } }),
    );
  await mount();
  await act(async () => mockSheet.onMethod?.('faircoin'));
  await act(async () => mockSheet.onBack());
  expect(mockSheet.step).toBe('payment');
  await act(async () => mockSheet.onStep('card'));
  const pay = renderer.root
    .findAllByType('button')
    .find((node) => String(node.props.children).includes('plus.checkout.card.open'));
  await act(async () => pay?.props.onClick());
  expect(openHosted).toHaveBeenCalledWith(hostedUrl, expect.any(Function));
  expect(mockConfirm).toHaveBeenLastCalledWith(SESSION, capability.clientSecret, {
    payment_method_type: 'card',
  });
});

it('opens the hosted card page directly when nothing was confirmed', async () => {
  await mount();
  await act(async () => mockSheet.onStep('card'));
  const pay = renderer.root
    .findAllByType('button')
    .find((node) => String(node.props.children).includes('plus.checkout.card.open'));
  await act(async () => pay?.props.onClick());
  expect(openHosted).toHaveBeenCalledWith(hostedUrl, undefined);
  expect(mockConfirm).not.toHaveBeenCalled();
});

it('refuses the card while a FairCoin payment is already confirming', async () => {
  mockRead.mockResolvedValue(
    session({ payment_intent: { ...faircoinIntent, status: 'processing' } }),
  );
  await mount();
  await act(async () => mockSheet.onStep('card'));
  const pay = renderer.root
    .findAllByType('button')
    .find((node) => String(node.props.children).includes('plus.checkout.card.open'));
  await act(async () => pay?.props.onClick());
  expect(openHosted).not.toHaveBeenCalled();
  expect(text()).toContain('plus.checkout.faircoin.confirming');
});

it('treats a lapsed quote as expired and asks for a fresh confirm', async () => {
  mockConfirm.mockResolvedValue(session({ payment_intent: faircoinIntent }));
  await mount();
  await act(async () => mockSheet.onMethod?.('faircoin'));
  // The sweeper cancelled the quoted payment; the session forgot it and stays open.
  mockRead.mockResolvedValue(session());
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  const details = mockSheet.methodDetails;
  if (details?.kind !== 'faircoin') throw new Error('no FairCoin presentation');
  expect(details.external?.state).toBe('expired');
  expect(details.external?.payload).toBe('');
  expect(details.quoteDescription).toBe('plus.checkout.faircoin.expired');
  mockConfirm.mockClear();
  await act(async () => mockSheet.onMethod?.('faircoin'));
  expect(mockConfirm).toHaveBeenCalledTimes(1);
  expect(onSettled).not.toHaveBeenCalled();
});

it('settles only when the gateway says the session is complete, once', async () => {
  await mount();
  expect(onSettled).not.toHaveBeenCalled();
  mockRead.mockResolvedValue(session({ status: 'complete', payment_intent: faircoinIntent }));
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(onSettled).toHaveBeenCalledTimes(1);
});

it('falls back to the hosted page when the session cannot be read or is another order', async () => {
  mockRead.mockRejectedValueOnce(new Error('CORS'));
  await mount();
  expect(onUnavailable).toHaveBeenCalledTimes(1);
  act(() => renderer.unmount());
  onUnavailable.mockClear();
  mockRead.mockResolvedValue(session({ amount_total: '600' }));
  await mount();
  expect(onUnavailable).toHaveBeenCalled();
});
