// The local provider test's preparation: the payment and its client action are
// read with the payer capability, and refused unless they are the reviewed ones.
const mockGetPaymentIntent = jest.fn();
const mockGetClientAction = jest.fn();
jest.mock('@peable.to/sdk/checkout', () => ({
  createPeableCheckout: () => ({
    getPaymentIntent: (...args: unknown[]) => mockGetPaymentIntent(...args),
    getClientAction: (...args: unknown[]) => mockGetClientAction(...args),
  }),
}));

import {
  type EmbeddedCheckoutBinding,
  intentMatchesBinding,
  prepareEmbeddedCheckout,
} from '../embeddedCheckout';

const binding: EmbeddedCheckoutBinding = {
  apiUrl: 'http://127.0.0.1:4310',
  intentId: 'pi_fixture',
  clientSecret: 'pi_fixture_secret_x',
  livemode: false,
  subscription: {
    id: 'sub_fixture',
    interval: 'month',
    amountMinorUnits: 599,
    currency: 'USD',
    observationPath: '/__local/checkout-test/pi_fixture/subscription',
  },
};
const intent = {
  id: 'pi_fixture',
  livemode: false,
  rail: 'card',
  currency: 'USD',
  amount: '599',
};
const action = {
  object: 'client_action',
  kind: 'client_secret',
  value: 'x',
  publishable_key: 'pk_test_1',
};
type Intent = Parameters<typeof intentMatchesBinding>[0];
const asIntent = (value: object) => value as unknown as Intent;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPaymentIntent.mockResolvedValue(intent);
  mockGetClientAction.mockResolvedValue(action);
});

it('binds the payment and its client action read with the payer capability', async () => {
  await expect(prepareEmbeddedCheckout(binding)).resolves.toEqual({
    ...binding,
    initial: { intent, action },
  });
  expect(mockGetPaymentIntent).toHaveBeenCalledWith('pi_fixture', 'pi_fixture_secret_x');
  expect(mockGetClientAction).toHaveBeenCalledWith('pi_fixture', 'pi_fixture_secret_x');
});

it('stops when the sheet was closed while it was reading', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(prepareEmbeddedCheckout(binding, controller.signal)).rejects.toThrow('canceled');
});

it('refuses a client action of the other mode', async () => {
  mockGetClientAction.mockResolvedValue({ ...action, publishable_key: 'pk_live_1' });
  await expect(prepareEmbeddedCheckout(binding)).rejects.toThrow('unavailable');
  mockGetClientAction.mockResolvedValue({ ...action, kind: 'redirect' });
  await expect(prepareEmbeddedCheckout(binding)).rejects.toThrow('unavailable');
});

it.each([
  ['another payment', { id: 'pi_other' }],
  ['the other mode', { livemode: true }],
  ['a FairCoin payment', { rail: 'faircoin' }],
  ['another currency', { currency: 'EUR' }],
  ['a malformed amount', { amount: '5.99' }],
  ['a zero amount', { amount: '0' }],
  ['not the subscription price', { amount: '600' }],
])('refuses %s', async (_label, change) => {
  mockGetPaymentIntent.mockResolvedValue({ ...intent, ...change });
  await expect(prepareEmbeddedCheckout(binding)).rejects.toThrow('unavailable');
});

it('needs no subscription terms to pay a one-time payment', () => {
  const { subscription: _subscription, ...oneTime } = binding;
  expect(intentMatchesBinding(asIntent({ ...intent, amount: '1200' }), oneTime)).toBe(true);
  expect(intentMatchesBinding(asIntent(intent), binding)).toBe(true);
});
