import { oxyAccountIdSchema } from '@oxy.so/contracts';
import {
  matchingProductionConfiguration,
  productionPresentation,
  productionSessionBinding,
} from '../productionCheckout';
import type { EmbeddedProductCheckout, ProductCheckoutConfiguration } from '@oxy.so/contracts';
import type { CheckoutReview } from '../checkoutReview';
const subject = oxyAccountIdSchema.parse('698100000000000000000001');
const otherSubject = oxyAccountIdSchema.parse('698100000000000000000002');
const review: CheckoutReview = {
  productId: 'mention',
  offerId: 'month',
  offerVersion: 1,
  amountMinorUnits: 599,
  currency: 'USD',
  interval: 'month',
};
const configuration: Extract<ProductCheckoutConfiguration, { state: 'ready' }> = {
  state: 'ready',
  subjectAccountId: subject,
  productId: 'mention',
  merchantId: 'merch_owned',
  mode: 'live',
  environment: 'production',
  publishableKey: 'pk_live_owned',
  paymentMethods: [{ id: 'card', available: true }],
  offers: [
    {
      offerId: 'month',
      offerVersion: 1,
      amountMinorUnits: 599,
      currency: 'USD',
      interval: 'month',
    },
  ],
};
const embedded: EmbeddedProductCheckout = {
  transport: 'checkout_session',
  subjectAccountId: subject,
  productId: 'mention',
  offerId: 'month',
  offerVersion: 1,
  merchantId: 'merch_owned',
  mode: 'live',
  environment: 'production',
  sessionId: 'cs_live_owned',
  clientSecret: 'opaque-test-fixture',
  publishableKey: 'pk_live_owned',
  currency: 'USD',
  amountMinorUnits: 599,
  interval: 'month',
  tax: { subtotalMinorUnits: 557, taxMinorUnits: 42, totalMinorUnits: 599, inclusive: true },
};
it('only accepts exact account/offer production configuration and omits payer capabilities', () => {
  expect(matchingProductionConfiguration(configuration, subject, review)).toBe(true);
  expect(matchingProductionConfiguration({ state: 'unconfigured' }, subject, review)).toBe(false);
  expect(
    matchingProductionConfiguration(
      { ...configuration, subjectAccountId: otherSubject },
      subject,
      review,
    ),
  ).toBe(false);
  expect(matchingProductionConfiguration({ ...configuration, mode: 'test' }, subject, review)).toBe(
    false,
  );
  expect(
    matchingProductionConfiguration({ ...configuration, environment: 'staging' }, subject, review),
  ).toBe(false);
  expect(
    matchingProductionConfiguration(
      { ...configuration, offers: [...configuration.offers, ...configuration.offers] },
      subject,
      review,
    ),
  ).toBe(false);
  const presented = productionPresentation(configuration, review, 1000);
  expect(Date.parse(presented.expiresAt)).toBe(61000);
  expect(JSON.stringify(presented)).not.toContain('client_secret');
  expect(presented.prices.year).toBeUndefined();
});
it.each([
  { subjectAccountId: otherSubject },
  { productId: 'other' },
  { offerId: 'other' },
  { offerVersion: 2 },
  { merchantId: 'merch_other' },
  { mode: 'test' as const },
  { environment: 'staging' as const },
  { publishableKey: 'pk_live_other' },
  { amountMinorUnits: 600 },
  { interval: 'year' as const },
  { sessionId: 'cs_test_other' },
  { clientSecret: '' },
  { tax: { ...embedded.tax, subtotalMinorUnits: 599 } },
])('rejects a mismatched bound authority: %j', (change) => {
  expect(() =>
    productionSessionBinding({ ...embedded, ...change }, configuration, subject, review),
  ).toThrow();
});
it('retains the real session and quote without synthesizing a PaymentIntent or subscription id', () => {
  const result = productionSessionBinding(embedded, configuration, subject, review);
  expect(result.action.session_id).toBe(embedded.sessionId);
  expect(result.subscription.tax).toEqual(embedded.tax);
  expect(result).not.toHaveProperty('intentId');
  expect(result.subscription).not.toHaveProperty('id');
});
