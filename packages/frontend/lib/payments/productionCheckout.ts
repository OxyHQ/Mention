import type { EmbeddedProductCheckout, ProductCheckoutConfiguration } from '@oxy.so/contracts';
import type { CheckoutConfiguration } from './checkoutConfiguration';
import type { CheckoutReview } from './checkoutReview';
import type { SessionCheckoutBinding } from './sessionCheckout';

type ReadyConfiguration = Extract<ProductCheckoutConfiguration, { state: 'ready' }>;
export function matchingProductionConfiguration(
  value: ProductCheckoutConfiguration,
  subjectAccountId: string,
  review: CheckoutReview,
): value is ReadyConfiguration {
  if (
    value.state !== 'ready' ||
    value.subjectAccountId !== subjectAccountId ||
    value.productId !== review.productId ||
    value.mode !== 'live' ||
    value.environment !== 'production' ||
    !/^pk_live_[A-Za-z0-9]+$/.test(value.publishableKey) ||
    !/^merch_[A-Za-z0-9_-]+$/.test(value.merchantId)
  )
    return false;
  const offers = value.offers.filter(
    (offer) => offer.offerId === review.offerId && offer.offerVersion === review.offerVersion,
  );
  return (
    offers.length === 1 &&
    offers[0]?.amountMinorUnits === review.amountMinorUnits &&
    offers[0]?.currency === review.currency &&
    offers[0]?.interval === review.interval
  );
}
/** Public presentation metadata only, with a bounded client freshness window. */
export function productionPresentation(
  value: ReadyConfiguration,
  review: CheckoutReview,
  fetchedAt: number,
): CheckoutConfiguration {
  return {
    environment: value.mode,
    publishableKey: value.publishableKey,
    currency: 'USD',
    expiresAt: new Date(fetchedAt + 60_000).toISOString(),
    scope: { merchantId: value.merchantId, productId: value.productId },
    prices: {
      [review.interval]: { amountMinorUnits: review.amountMinorUnits, interval: review.interval },
    },
    paymentMethods: value.paymentMethods,
  };
}
/** A server reply cannot change the identity, merchant or terms captured by Subscribe. */
export function productionSessionBinding(
  value: EmbeddedProductCheckout,
  configuration: ReadyConfiguration,
  subjectAccountId: string,
  review: CheckoutReview,
): SessionCheckoutBinding {
  if (
    !matchingProductionConfiguration(configuration, subjectAccountId, review) ||
    value.transport !== 'checkout_session' ||
    value.subjectAccountId !== subjectAccountId ||
    value.productId !== review.productId ||
    value.offerId !== review.offerId ||
    value.offerVersion !== review.offerVersion ||
    value.merchantId !== configuration.merchantId ||
    value.mode !== configuration.mode ||
    value.environment !== configuration.environment ||
    value.publishableKey !== configuration.publishableKey ||
    value.currency !== review.currency ||
    value.amountMinorUnits !== review.amountMinorUnits ||
    value.interval !== review.interval ||
    !/^cs_live_[A-Za-z0-9]+$/.test(value.sessionId) ||
    !value.clientSecret ||
    value.tax.inclusive !== true ||
    value.tax.totalMinorUnits !== review.amountMinorUnits ||
    value.tax.subtotalMinorUnits + value.tax.taxMinorUnits !== value.tax.totalMinorUnits
  )
    throw new Error('Checkout authority or terms changed');
  return {
    action: {
      kind: 'checkout_session',
      provider: 'stripe',
      session_id: value.sessionId,
      client_secret: value.clientSecret,
      publishable_key: value.publishableKey,
      amount_minor_units: value.amountMinorUnits,
      currency: value.currency,
    },
    subscription: {
      interval: value.interval,
      amountMinorUnits: value.amountMinorUnits,
      currency: value.currency,
      tax: { ...value.tax },
    },
    paymentMethods: configuration.paymentMethods,
  };
}
