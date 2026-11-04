// These tests exercise page/binding policy, not the SDK transport. Fail on any
// unexpected transport construction rather than loading its browser-only ESM.
jest.mock('@peable.to/sdk/checkout', () => ({
  createPeableCheckout: () => {
    throw new Error('Unexpected payer transport in policy test');
  },
}));

import {
  createLocalProviderTestBinding,
  isTestProviderAction,
  localProviderPhase,
  localProviderTestBinding,
} from '../localProviderTest';
const link =
  'http://localhost:8110/plus#peable_test_intent=pi_test&peable_test_secret=opaque-test-capability';
it('requires an explicit local preview and payer capability', () => {
  expect(localProviderTestBinding(link, true)).toEqual({
    livemode: false,
    apiUrl: 'http://127.0.0.1:4310',
    intentId: 'pi_test',
    clientSecret: 'opaque-test-capability',
  });
  expect(localProviderTestBinding(link, false)).toBeNull();
  expect(
    localProviderTestBinding(link.replace('localhost:8110', 'mention.oxy.so'), true),
  ).toBeNull();
  expect(localProviderTestBinding('http://localhost:8110/plus', true)).toBeNull();
});
it('refuses live provider actions in local test mode', () => {
  expect(isTestProviderAction({ kind: 'client_secret', publishable_key: 'pk_test_example' })).toBe(
    true,
  );
  expect(isTestProviderAction({ kind: 'client_secret', publishable_key: 'pk_live_example' })).toBe(
    false,
  );
  expect(isTestProviderAction({ kind: 'redirect', publishable_key: 'pk_test_example' })).toBe(
    false,
  );
});
it('only announces success from a succeeded intent and permits declined retries', () => {
  expect(localProviderPhase('processing')).toBe('pending');
  expect(localProviderPhase('requires_capture')).toBe('pending');
  expect(localProviderPhase('requires_payment_method')).toBe('entry');
  expect(localProviderPhase('succeeded')).toBe('success');
  expect(localProviderPhase('canceled')).toBe('failure');
  expect(localProviderPhase('requires_action')).toBe('entry');
});

/** `POST /__local/checkout-test` as the Peable harness answers it: the snapshot plus the payer capability. */
function subscription(change: Record<string, unknown> = {}) {
  return {
    object: 'local_test_subscription',
    livemode: false,
    payment_intent: 'pi_test',
    subscription: 'sub_fixture',
    interval: 'month',
    amount: '599',
    currency: 'USD',
    subscription_status: 'incomplete',
    invoice_status: 'open',
    payment_status: 'requires_payment_method',
    ready: false,
    tax: { amount_subtotal: '557', amount_tax: '42', amount_total: '599', inclusive: true },
    payment_methods: ['card', 'bank', 'installments', 'faircoin'].map((type) => ({
      type,
      available: type === 'card',
      unavailable_reason: type === 'card' ? null : 'subscription_method_not_configured',
    })),
    current_period_start: null,
    current_period_end: null,
    client_secret: 'payer-capability',
    ...change,
  };
}
it('creates only a loopback test attempt and keeps the payer capability out of URLs', async () => {
  const previous = global.fetch;
  const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => subscription() });
  global.fetch = fetcher;
  try {
    await expect(
      createLocalProviderTestBinding('mention_same_operation', 'https://mention.oxy.so/plus', true),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    const result = await createLocalProviderTestBinding(
      'mention_same_operation',
      'http://localhost:8110/plus',
      true,
    );
    expect(result).toEqual({
      apiUrl: 'http://127.0.0.1:4310',
      intentId: 'pi_test',
      clientSecret: 'payer-capability',
      livemode: false,
      paymentMethods: [
        { id: 'card', available: true },
        { id: 'bank', available: false, reason: 'subscription_method_not_configured' },
        { id: 'installments', available: false, reason: 'subscription_method_not_configured' },
        { id: 'faircoin', available: false, reason: 'subscription_method_not_configured' },
      ],
      subscription: {
        id: 'sub_fixture',
        interval: 'month',
        amountMinorUnits: 599,
        currency: 'USD',
        tax: { subtotalMinorUnits: 557, taxMinorUnits: 42, totalMinorUnits: 599, inclusive: true },
        observationPath: '/__local/checkout-test/pi_test/subscription',
      },
    });
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:4310/__local/checkout-test',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ interval: 'month' }),
        headers: expect.objectContaining({
          'Idempotency-Key': 'mention_same_operation',
          'X-Peable-Local-Test': '1',
        }),
      }),
    );
    fetcher.mockResolvedValue({ ok: true, json: async () => subscription({ tax: null }) });
    await expect(
      createLocalProviderTestBinding('mention_same_operation', 'http://localhost:8110/plus', true),
    ).resolves.toMatchObject({ subscription: { tax: undefined } });
    fetcher.mockResolvedValue({ ok: false });
    await expect(
      createLocalProviderTestBinding('mention_same_operation', 'http://localhost:8110/plus', true),
    ).rejects.toThrow('unavailable');
  } finally {
    global.fetch = previous;
  }
});
it.each([
  { object: 'subscription' },
  { livemode: true },
  { payment_intent: 'not-an-intent' },
  { client_secret: '' },
  { interval: 'year' },
  { amount: 599 },
  { amount: '0' },
  { currency: 'EUR' },
  { tax: { amount_subtotal: '500', amount_tax: '42', amount_total: '599', inclusive: true } },
  { tax: undefined },
  { payment_methods: [] },
])('refuses a harness answer that is not the subscription it asked for %j', async (change) => {
  const previous = global.fetch;
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => subscription(change),
  });
  try {
    await expect(
      createLocalProviderTestBinding('mention_same_operation', 'http://localhost:8110/plus', true),
    ).rejects.toThrow('unavailable');
  } finally {
    global.fetch = previous;
  }
});
