import {
  configurationMatchesBinding,
  configurationMatchesReview,
  parseCheckoutConfiguration,
  readLocalCheckoutConfiguration,
} from '../checkoutConfiguration';
import type { EmbeddedCheckoutBinding } from '../embeddedCheckout';
const now = Date.now();
function fixture() {
  return {
    environment: 'test',
    publishableKey: 'pk_test_fixture',
    currency: 'USD',
    expiresAt: new Date(now + 60_000).toISOString(),
    scope: { merchantId: 'merch_fixture', productId: 'peable_local_mention_plus' },
    prices: {
      month: { interval: 'month', amountMinorUnits: 599 },
      year: { interval: 'year', amountMinorUnits: 5750 },
    },
    paymentMethods: ['card', 'bank', 'installments', 'faircoin'].map((id) => ({
      id,
      available: id === 'card',
      reason: id === 'card' ? undefined : 'not_configured',
    })),
  };
}
it('copies only validated public fields and never treats configuration as payment authority', () => {
  const configuration = parseCheckoutConfiguration(
    { ...fixture(), clientSecret: 'not-retained' },
    now,
  );
  expect(configuration).not.toHaveProperty('clientSecret');
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
  expect(configurationMatchesReview(configuration, { ...review, amountMinorUnits: 600 }, now)).toBe(
    false,
  );
  expect(configurationMatchesReview(configuration, review, now + 60_001)).toBe(false);
  const binding = {
    environment: 'test',
    initial: {
      intent: { merchantId: 'merch_fixture' },
      action: { publishableKey: 'pk_test_fixture' },
    },
  } as EmbeddedCheckoutBinding;
  expect(configurationMatchesBinding(configuration, binding)).toBe(true);
  expect(
    configurationMatchesBinding(
      { ...configuration, scope: { ...configuration.scope, merchantId: 'merch_other' } },
      binding,
    ),
  ).toBe(false);
  expect(
    configurationMatchesBinding({ ...configuration, publishableKey: 'pk_test_other' }, binding),
  ).toBe(false);
});
it.each([
  { environment: 'live' },
  { publishableKey: 'pk_live_fixture' },
  { currency: 'EUR' },
  { expiresAt: new Date(now - 1).toISOString() },
  { expiresAt: new Date(now + 120_001).toISOString() },
  { scope: { merchantId: 'not-a-merchant', productId: 'peable_local_mention_plus' } },
  {
    prices: {
      month: { interval: 'year', amountMinorUnits: 599 },
      year: { interval: 'year', amountMinorUnits: 5750 },
    },
  },
  { paymentMethods: [] },
  { paymentMethods: Array(4).fill({ id: 'card', available: true }) },
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
