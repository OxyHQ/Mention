// Readiness and wire parsing only; the payer transport is never constructed here.
jest.mock('@peable.to/sdk/checkout', () => ({
  createPeableCheckout: () => {
    throw new Error('Unexpected payer transport in policy test');
  },
}));

import {
  type EmbeddedCheckoutBinding,
  observeEmbeddedSubscription,
  providerActionMatchesMode,
} from '../embeddedCheckout';
import { parseBaseUnits } from '../peableWire';

const binding: EmbeddedCheckoutBinding = {
  apiUrl: 'http://127.0.0.1:4310',
  intentId: 'pi_test',
  clientSecret: 'payer-capability',
  livemode: false,
  subscription: {
    id: 'sub_fixture',
    interval: 'month',
    amountMinorUnits: 599,
    currency: 'USD',
    observationPath: '/__local/checkout-test/pi_test/subscription',
  },
};
/** `GET /__local/checkout-test/:payment_intent/subscription` once the first invoice is paid. */
const ready = {
  object: 'local_test_subscription',
  livemode: false,
  payment_intent: 'pi_test',
  subscription: 'sub_fixture',
  ready: true,
  subscription_status: 'active',
  invoice_status: 'paid',
  payment_status: 'succeeded',
};

async function observe(value: unknown, target = binding) {
  const previous = global.fetch;
  const fetcher = jest.fn().mockResolvedValue({ ok: true, json: async () => value });
  global.fetch = fetcher;
  try {
    return { ready: await observeEmbeddedSubscription(target), fetcher };
  } finally {
    global.fetch = previous;
  }
}

it('reads readiness with the payer capability in a header, never the URL', async () => {
  const { ready: observed, fetcher } = await observe(ready);
  expect(observed).toBe(true);
  expect(fetcher).toHaveBeenCalledWith(
    'http://127.0.0.1:4310/__local/checkout-test/pi_test/subscription',
    {
      headers: { 'X-Peable-Client-Secret': 'payer-capability' },
      credentials: 'omit',
      cache: 'no-store',
    },
  );
});
it.each([
  { ready: false },
  { subscription_status: 'incomplete' },
  { invoice_status: 'open' },
  { payment_status: 'processing' },
  { payment_intent: 'pi_other' },
  { subscription: 'sub_other' },
  { livemode: true },
])('is not ready on %j', async (change) => {
  expect((await observe({ ...ready, ...change })).ready).toBe(false);
});
it('never reads a live binding over plain http', async () => {
  await expect(observeEmbeddedSubscription({ ...binding, livemode: true })).rejects.toThrow();
});
it('takes only canonical, safe base-unit strings', () => {
  expect(parseBaseUnits('599')).toBe(599);
  expect(parseBaseUnits('0')).toBe(0);
  expect(parseBaseUnits(599)).toBeNull();
  expect(parseBaseUnits('0599')).toBeNull();
  expect(parseBaseUnits('-1')).toBeNull();
  expect(parseBaseUnits('9007199254740993')).toBeNull();
});
it('binds a provider key to the mode', () => {
  expect(
    providerActionMatchesMode({ kind: 'client_secret', publishable_key: 'pk_live_x' }, true),
  ).toBe(true);
  expect(
    providerActionMatchesMode({ kind: 'client_secret', publishable_key: 'pk_test_x' }, true),
  ).toBe(false);
});
