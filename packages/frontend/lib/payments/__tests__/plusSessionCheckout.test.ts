// The SDK's browser entry is ESM-only under Jest; these are its own definitions
// (`sessionIdFromClientSecret`, `payDeepLinkFor`), never a second policy.
jest.mock('@peable.to/sdk/checkout', () => ({
  sessionIdFromClientSecret: (secret: string) =>
    /^(cs_[0-9a-f]{24,})_secret_[0-9a-f]{16,}$/.exec(secret)?.[1] ?? null,
  payDeepLinkFor: (intent: {
    id: string;
    client_secret: string;
    amount: string;
    faircoin: { address: string; network: string };
  }) =>
    `peable://pay?intent=${intent.id}&secret=${intent.client_secret}&address=${intent.faircoin.address}&amount=${intent.amount}&network=${intent.faircoin.network}`,
}));

import {
  faircoinAvailability,
  faircoinInFlight,
  faircoinPayment,
  faircoinRefusalReason,
  faircoinTransferState,
  faircoinUnavailableKey,
  formatFairAmount,
  hostedSessionCapability,
  sessionMatchesOffer,
  type PlusCheckoutSession,
  type PlusSessionIntent,
} from '../plusSessionCheckout';

const SESSION = 'cs_0123456789abcdef01234567';
const SECRET = `${SESSION}_secret_0123456789abcdef`;
const HOSTED = `https://checkout.peable.to/c/${SESSION}#cs=${SECRET}`;

function session(overrides: Partial<PlusCheckoutSession> = {}): PlusCheckoutSession {
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
  } as PlusCheckoutSession;
}

function faircoinIntent(overrides: Partial<PlusSessionIntent> = {}): PlusSessionIntent {
  return {
    id: 'pi_fair',
    rail: 'faircoin',
    status: 'requires_action',
    amount: '12345678900',
    currency: 'FAIR',
    client_secret: 'pi_fair_secret_x',
    cancellation_reason: null,
    next_action: {
      type: 'faircoin_payment',
      faircoin_payment: {
        address: 'fAddress',
        network: 'mainnet',
        amount: '12345678900',
        currency: 'FAIR',
        uri: 'faircoin:fAddress?amount=123.456789',
      },
    },
    faircoin: {
      network: 'mainnet',
      address: 'fAddress',
      txid: null,
      confirmations: 0,
      required_confirmations: 6,
      quote: {
        currency: 'USD',
        amount: '599',
        rate: '0.04852',
        quoted_at: 1_000,
        expires_at: 1_600,
      },
    },
    ...overrides,
  } as PlusSessionIntent;
}

describe('hostedSessionCapability', () => {
  it("reads the payer's capability from Peable's hosted URL fragment", () => {
    expect(hostedSessionCapability(HOSTED)).toEqual({ sessionId: SESSION, clientSecret: SECRET });
  });
  it.each([
    ['another origin', `https://checkout.example.test/c/${SESSION}#cs=${SECRET}`],
    ['plain http', `http://checkout.peable.to/c/${SESSION}#cs=${SECRET}`],
    [
      'a secret of another session',
      `https://checkout.peable.to/c/cs_ffffffffffffffffffffffff#cs=${SECRET}`,
    ],
    ['no fragment', `https://checkout.peable.to/c/${SESSION}`],
    ['a query string', `https://checkout.peable.to/c/${SESSION}?cs=${SECRET}`],
    ['a portal page', `https://checkout.peable.to/portal/${SESSION}#cs=${SECRET}`],
    ['not a URL', 'checkout'],
  ])('stays hosted for %s', (_name, url) => {
    expect(hostedSessionCapability(url)).toBeNull();
  });
});

it('accepts only the reviewed subscription total and currency', () => {
  const capability = { sessionId: SESSION, clientSecret: SECRET };
  const price = { amountMinorUnits: 599, currency: 'USD' };
  expect(sessionMatchesOffer(session(), capability, price)).toBe(true);
  expect(sessionMatchesOffer(session({ amount_total: '600' }), capability, price)).toBe(false);
  expect(sessionMatchesOffer(session({ currency: 'EUR' }), capability, price)).toBe(false);
  expect(
    sessionMatchesOffer(
      session({ mode: 'payment' } as Partial<PlusCheckoutSession>),
      capability,
      price,
    ),
  ).toBe(false);
  expect(sessionMatchesOffer(session(), { ...capability, sessionId: 'cs_other' }, price)).toBe(
    false,
  );
});

describe('FairCoin availability', () => {
  it('is available when the gateway says so', () => {
    expect(faircoinAvailability(session())).toEqual({ available: true, reason: null });
  });
  it("keeps the gateway's reason when it cannot be paid", () => {
    expect(
      faircoinAvailability(
        session({ faircoin: { available: false, unavailable_reason: 'faircoin_wallet_missing' } }),
      ),
    ).toEqual({ available: false, reason: 'faircoin_wallet_missing' });
  });
  it('is never hidden: an order without it is shown unavailable for now', () => {
    expect(
      faircoinAvailability(session({ payment_method_types: ['card'], faircoin: null })),
    ).toEqual({
      available: false,
      reason: 'temporarily_unavailable',
    });
  });
  it.each([
    ['faircoin_wallet_missing', 'walletMissing'],
    ['faircoin_network_closed', 'networkClosed'],
    ['price_unavailable', 'priceUnavailable'],
    ['temporarily_unavailable', 'temporarilyUnavailable'],
    ['something_new', 'temporarilyUnavailable'],
    [null, 'temporarilyUnavailable'],
  ])('words %s', (reason, key) => {
    expect(faircoinUnavailableKey(reason)).toBe(`plus.checkout.faircoin.unavailable.${key}`);
  });
  it('maps the confirm refusals to the same reasons', () => {
    expect(faircoinRefusalReason({ code: 'faircoin_wallet_missing' })).toBe(
      'faircoin_wallet_missing',
    );
    expect(faircoinRefusalReason({ code: 'faircoin_network_closed' })).toBe(
      'faircoin_network_closed',
    );
    expect(faircoinRefusalReason({ code: 'faircoin_price_unavailable' })).toBe('price_unavailable');
    expect(faircoinRefusalReason({ code: 'payment_method_locked' })).toBeNull();
    expect(faircoinRefusalReason(new Error('offline'))).toBeNull();
  });
});

describe('the FairCoin payment', () => {
  it("is the session's chain intent, with Peable's wallet request and its quote", () => {
    const payment = faircoinPayment(faircoinIntent());
    expect(payment?.amount).toBe('12345678900');
    expect(payment?.deepLink).toMatch(/^peable:\/\/pay\?intent=pi_fair&/);
    expect(payment?.quote?.expires_at).toBe(1_600);
  });
  it('is no FairCoin payment on the card rail', () => {
    expect(faircoinPayment(faircoinIntent({ rail: 'card', faircoin: null }))).toBeNull();
    expect(faircoinPayment(null)).toBeNull();
  });
  it.each([
    [{}, 1_000, 'awaiting'],
    [{}, 1_600, 'expired'],
    [{ status: 'processing' }, 2_000, 'detected'],
    [
      {
        status: 'processing',
        faircoin: { ...faircoinIntent().faircoin, confirmations: 2 },
      },
      2_000,
      'processing',
    ],
    [{ status: 'succeeded' }, 2_000, 'succeeded'],
    [{ status: 'canceled', cancellation_reason: 'abandoned' }, 1_000, 'expired'],
    [{ status: 'canceled', cancellation_reason: 'underpaid' }, 1_000, 'failure'],
  ] as const)('reads %o at %d as %s', (overrides, now, state) => {
    expect(
      faircoinTransferState(faircoinIntent(overrides as Partial<PlusSessionIntent>), now),
    ).toBe(state);
  });
  it('cannot be replaced once money is moving', () => {
    expect(faircoinInFlight(faircoinIntent())).toBe(false);
    expect(faircoinInFlight(faircoinIntent({ status: 'processing' }))).toBe(true);
  });
});

it.each([
  ['0', '0 FAIR'],
  ['1', '0.00000001 FAIR'],
  ['150000000', '1.5 FAIR'],
  ['12345678900', '123.456789 FAIR'],
  ['123456780000000', '1,234,567.8 FAIR'],
])('formats %s base units as %s', (units, label) => {
  expect(formatFairAmount(units)).toBe(label);
});
