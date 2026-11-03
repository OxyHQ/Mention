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
    environment: 'test',
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
it('only announces success from settled gateway status and permits declined retries', () => {
  expect(localProviderPhase('confirming')).toBe('pending');
  expect(localProviderPhase('failed')).toBe('entry');
  expect(localProviderPhase('settled')).toBe('success');
  expect(localProviderPhase('expired')).toBe('failure');
  expect(localProviderPhase('requires_action')).toBe('entry');
});

it('creates only a loopback test attempt and keeps the payer capability out of URLs', async () => {
  const previous = global.fetch;
  const fetcher = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      kind: 'subscription',
      subscriptionId: 'sub_fixture',
      interval: 'month',
      amountMinorUnits: 599,
      currency: 'USD',
      intentId: 'pi_test',
      clientSecret: 'payer-capability',
    }),
  });
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
    expect(result.intentId).toBe('pi_test');
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
    fetcher.mockResolvedValue({ ok: false });
    await expect(
      createLocalProviderTestBinding('mention_same_operation', 'http://localhost:8110/plus', true),
    ).rejects.toThrow('unavailable');
  } finally {
    global.fetch = previous;
  }
});
