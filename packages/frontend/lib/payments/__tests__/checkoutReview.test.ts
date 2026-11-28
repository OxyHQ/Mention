import { checkoutMatchesReview, type CheckoutReview } from '../checkoutReview';
import type { EmbeddedCheckoutBinding } from '../embeddedCheckout';
const review: CheckoutReview = {
  productId: 'mention',
  offerId: 'monthly',
  offerVersion: 1,
  currency: 'USD',
  interval: 'month',
  amountMinorUnits: 599,
};
function prepared(): EmbeddedCheckoutBinding {
  return {
    apiUrl: 'https://gateway.example',
    intentId: 'pi_test',
    clientSecret: 'opaque',
    livemode: false,
    subscription: {
      id: 'sub_test',
      currency: 'USD',
      interval: 'month',
      amountMinorUnits: 599,
      observationPath: '/observe',
    },
    initial: {
      intent: { id: 'pi_test', currency: 'USD', amount: '599' } as NonNullable<
        EmbeddedCheckoutBinding['initial']
      >['intent'],
      action: {
        object: 'client_action',
        kind: 'client_secret',
        value: 'opaque',
        publishable_key: 'pk_test_fixture',
      },
    },
  };
}
it('accepts only the captured currency, cadence and exact payable amount', () => {
  expect(checkoutMatchesReview(prepared(), review)).toBe(true);
  for (const change of [
    { currency: 'EUR' },
    { interval: 'year' as const },
    { amountMinorUnits: 5750 },
  ]) {
    const value = prepared();
    if (!value.subscription) throw new Error('Missing fixture subscription');
    value.subscription = { ...value.subscription, ...change };
    expect(checkoutMatchesReview(value, review)).toBe(false);
  }
  const mismatchedIntent = prepared();
  if (!mismatchedIntent.initial) throw new Error('Missing fixture intent');
  mismatchedIntent.initial.intent.amount = '5750';
  expect(checkoutMatchesReview(mismatchedIntent, review)).toBe(false);
  expect(checkoutMatchesReview({ ...prepared(), subscription: undefined }, review)).toBe(false);
  expect(checkoutMatchesReview({ ...prepared(), initial: undefined }, review)).toBe(false);
});
