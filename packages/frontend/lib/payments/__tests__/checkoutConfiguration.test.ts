import {
  configurationMatchesBinding,
  configurationMatchesReview,
  parseCheckoutConfiguration,
  readLocalCheckoutConfiguration,
} from '../checkoutConfiguration';
import type { EmbeddedCheckoutBinding } from '../embeddedCheckout';
const now = Date.now();
/** `GET /__local/checkout-test/config` as the Peable harness answers it (ADR 0014 wire). */
function fixture() {
  return {
    object: 'local_checkout_configuration',
    livemode: false,
    publishable_key: 'pk_test_fixture',
    merchant: 'merch_fixture',
    product: 'peable_local_mention_plus',
    currency: 'USD',
    prices: {
      month: { unit_amount: '599', interval: 'month' },
      year: { unit_amount: '5750', interval: 'year' },
    },
    payment_methods: ['card', 'bank', 'installments', 'faircoin'].map((type) => ({
      type,
      available: type === 'card',
      unavailable_reason: type === 'card' ? null : 'not_configured',
    })),
    expires_at: Math.floor((now + 60_000) / 1000),
  };
}
it('copies only validated public fields and never treats configuration as payment authority', () => {
  const configuration = parseCheckoutConfiguration(
    { ...fixture(), client_secret: 'not-retained' },
    now,
  );
  expect(configuration).not.toHaveProperty('client_secret');
  expect(configuration).toMatchObject({
    livemode: false,
    publishableKey: 'pk_test_fixture',
    merchant: 'merch_fixture',
    expiresAt: fixture().expires_at * 1000,
    prices: { month: { interval: 'month', amountMinorUnits: 599 } },
  });
  expect(configuration.paymentMethods[1]).toEqual({
    id: 'bank',
    available: false,
    reason: 'not_configured',
  });
  expect(
    configuration.paymentMethods.filter((method) => method.available).map((method) => method.id),
  ).toEqual(['card']);
  const review = {
    productId: 'mention',
    offerId: 'monthly',
    offerVersion: 1,
    interval: 'month' as const,
    amountMinorUnits: 599,
    currency: 'USD',
  };
  expect(configurationMatchesReview(configuration, review, now)).toBe(true);
  expect(configurationMatchesReview(configuration, review)).toBe(true);
  expect(configurationMatchesReview(configuration, { ...review, amountMinorUnits: 600 }, now)).toBe(
    false,
  );
  expect(configurationMatchesReview(configuration, review, configuration.expiresAt)).toBe(false);
  const binding = {
    livemode: false,
    initial: {
      intent: { merchant_id: 'merch_fixture' },
      action: { publishable_key: 'pk_test_fixture' },
    },
  } as unknown as EmbeddedCheckoutBinding;
  expect(configurationMatchesBinding(configuration, binding)).toBe(true);
  expect(configurationMatchesBinding({ ...configuration, merchant: 'merch_other' }, binding)).toBe(
    false,
  );
  expect(
    configurationMatchesBinding({ ...configuration, publishableKey: 'pk_test_other' }, binding),
  ).toBe(false);
});
it.each([
  { object: 'checkout_configuration' },
  { livemode: true },
  { publishable_key: 'pk_live_fixture' },
  { currency: 'EUR' },
  { expires_at: Math.floor(now / 1000) - 1 },
  { expires_at: Math.floor((now + 121_000) / 1000) },
  { expires_at: new Date(now + 60_000).toISOString() },
  { merchant: 'not-a-merchant' },
  { product: 'another_product' },
  {
    prices: {
      month: { interval: 'year', unit_amount: '599' },
      year: { interval: 'year', unit_amount: '5750' },
    },
  },
  {
    prices: {
      month: { interval: 'month', unit_amount: 599 },
      year: { interval: 'year', unit_amount: '5750' },
    },
  },
  { prices: { month: '599', year: { interval: 'year', unit_amount: '5750' } } },
  {
    prices: {
      month: { interval: 'month', unit_amount: '0' },
      year: { interval: 'year', unit_amount: '5750' },
    },
  },
  { payment_methods: [] },
  { payment_methods: Array(4).fill({ type: 'card', available: true, unavailable_reason: null }) },
  {
    payment_methods: ['card', 'bank', 'installments', 'faircoin'].map((type) => ({
      type,
      available: true,
    })),
  },
])('rejects invalid or stale configuration %j', (change) => {
  expect(() => parseCheckoutConfiguration({ ...fixture(), ...change }, now)).toThrow();
});
it('fetches public configuration only from opted-in loopback without creating an operation', async () => {
  const previous = global.fetch;
  const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => fixture() });
  global.fetch = fetcher;
  const controller = new AbortController();
  try {
    await readLocalCheckoutConfiguration('http://localhost:8110/plus', controller.signal);
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:4310/__local/checkout-test/config', {
      headers: { 'X-Peable-Local-Test': '1' },
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    await expect(
      readLocalCheckoutConfiguration('https://mention.earth/plus', controller.signal),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue({ ok: false });
    await expect(
      readLocalCheckoutConfiguration('http://localhost:8110/plus', controller.signal),
    ).rejects.toThrow();
  } finally {
    global.fetch = previous;
  }
});
