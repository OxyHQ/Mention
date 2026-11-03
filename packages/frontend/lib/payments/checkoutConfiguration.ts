import type { EmbeddedCheckoutBinding } from './embeddedCheckout';
import type { CheckoutReview } from './checkoutReview';

/** Public collection configuration, never payer or merchant authorization. */
export interface CheckoutConfiguration {
  environment: 'test';
  publishableKey: string;
  currency: 'USD';
  expiresAt: string;
  scope: { merchantId: string; productId: 'peable_local_mention_plus' };
  prices: Record<'month' | 'year', { amountMinorUnits: number; interval: 'month' | 'year' }>;
  paymentMethods: NonNullable<EmbeddedCheckoutBinding['paymentMethods']>;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function parseCheckoutConfiguration(
  value: unknown,
  now = Date.now(),
): CheckoutConfiguration {
  if (
    !record(value) ||
    value.environment !== 'test' ||
    value.currency !== 'USD' ||
    typeof value.publishableKey !== 'string' ||
    !/^pk_test_[A-Za-z0-9]+$/.test(value.publishableKey) ||
    value.publishableKey.length > 256 ||
    typeof value.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(value.expiresAt)) ||
    Date.parse(value.expiresAt) <= now ||
    Date.parse(value.expiresAt) > now + 120_000 ||
    !record(value.scope) ||
    typeof value.scope.merchantId !== 'string' ||
    !/^merch_[A-Za-z0-9_-]+$/.test(value.scope.merchantId) ||
    value.scope.productId !== 'peable_local_mention_plus' ||
    !record(value.prices)
  )
    throw new Error('Checkout configuration is unavailable.');
  const parsePrice = (candidate: unknown, interval: 'month' | 'year') => {
    if (
      !record(candidate) ||
      candidate.interval !== interval ||
      typeof candidate.amountMinorUnits !== 'number' ||
      !Number.isSafeInteger(candidate.amountMinorUnits) ||
      candidate.amountMinorUnits <= 0
    )
      throw new Error('Checkout configuration is unavailable.');
    return { interval, amountMinorUnits: candidate.amountMinorUnits };
  };
  const prices = {
    month: parsePrice(value.prices.month, 'month'),
    year: parsePrice(value.prices.year, 'year'),
  };
  if (!Array.isArray(value.paymentMethods) || value.paymentMethods.length !== 4)
    throw new Error('Checkout methods are unavailable.');
  const ids = new Set<string>();
  const paymentMethods = value.paymentMethods.map((method: unknown) => {
    if (
      !record(method) ||
      typeof method.id !== 'string' ||
      !['card', 'bank', 'installments', 'faircoin'].includes(method.id) ||
      ids.has(method.id) ||
      typeof method.available !== 'boolean' ||
      (method.reason !== undefined &&
        (typeof method.reason !== 'string' || method.reason.length > 200))
    )
      throw new Error('Checkout methods are unavailable.');
    ids.add(method.id);
    return {
      id: method.id as CheckoutConfiguration['paymentMethods'][number]['id'],
      available: method.available,
      reason: method.reason as string | undefined,
    };
  });
  // Copy only the reviewed public fields; unknown fields never reach UI state.
  return {
    environment: 'test',
    publishableKey: value.publishableKey,
    currency: 'USD',
    expiresAt: value.expiresAt,
    scope: { merchantId: value.scope.merchantId, productId: 'peable_local_mention_plus' },
    prices,
    paymentMethods,
  };
}
export function configurationMatchesReview(
  configuration: CheckoutConfiguration,
  review: CheckoutReview,
  now = Date.now(),
): boolean {
  const price = configuration.prices[review.interval];
  return (
    Date.parse(configuration.expiresAt) > now &&
    configuration.currency === review.currency &&
    price.interval === review.interval &&
    price.amountMinorUnits === review.amountMinorUnits
  );
}
export function configurationMatchesBinding(
  configuration: CheckoutConfiguration,
  binding: EmbeddedCheckoutBinding,
): boolean {
  return (
    configuration.environment === binding.environment &&
    configuration.scope.merchantId === binding.initial?.intent.merchantId &&
    configuration.publishableKey === binding.initial?.action.publishableKey
  );
}
export async function readLocalCheckoutConfiguration(
  href: string,
  signal: AbortSignal,
): Promise<CheckoutConfiguration> {
  const url = new URL(href);
  if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '8110')
    throw new Error('Local checkout configuration is unavailable.');
  const response = await fetch('http://127.0.0.1:4310/__local/checkout-test/config', {
    headers: { 'X-Peable-Local-Test': '1' },
    signal,
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Checkout configuration is unavailable.');
  return parseCheckoutConfiguration(await response.json());
}
