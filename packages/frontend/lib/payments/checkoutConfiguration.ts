import type { EmbeddedCheckoutBinding } from './embeddedCheckout';
import { type CheckoutPaymentMethod, parseBaseUnits, parsePaymentMethods } from './peableWire';
import type { CheckoutReview } from './checkoutReview';

const PRODUCT = 'peable_local_mention_plus';

/** Public collection configuration, never payer or merchant authorization. */
export interface CheckoutConfiguration {
  livemode: false;
  publishableKey: string;
  currency: 'USD';
  /** Epoch milliseconds; the configuration is stale after it. */
  expiresAt: number;
  /** The local test merchant's public `merch_…`. */
  merchant: string;
  product: typeof PRODUCT;
  prices: Record<'month' | 'year', { amountMinorUnits: number; interval: 'month' | 'year' }>;
  paymentMethods: readonly CheckoutPaymentMethod[];
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
/** `GET /__local/checkout-test/config` (`local_checkout_configuration`), Peable's ADR 0014 wire. */
export function parseCheckoutConfiguration(
  value: unknown,
  now = Date.now(),
): CheckoutConfiguration {
  const expiresAt =
    record(value) && typeof value.expires_at === 'number' && Number.isSafeInteger(value.expires_at)
      ? value.expires_at * 1000
      : Number.NaN;
  if (
    !record(value) ||
    value.object !== 'local_checkout_configuration' ||
    value.livemode !== false ||
    value.currency !== 'USD' ||
    typeof value.publishable_key !== 'string' ||
    !/^pk_test_[A-Za-z0-9]+$/.test(value.publishable_key) ||
    value.publishable_key.length > 256 ||
    !(expiresAt > now) ||
    expiresAt > now + 120_000 ||
    typeof value.merchant !== 'string' ||
    !/^merch_[A-Za-z0-9_-]+$/.test(value.merchant) ||
    value.product !== PRODUCT ||
    !record(value.prices)
  )
    throw new Error('Checkout configuration is unavailable.');
  const parsePrice = (candidate: unknown, interval: 'month' | 'year') => {
    if (!record(candidate) || candidate.interval !== interval)
      throw new Error('Checkout configuration is unavailable.');
    const amount = parseBaseUnits(candidate.unit_amount);
    if (amount === null || amount <= 0) throw new Error('Checkout configuration is unavailable.');
    return { interval, amountMinorUnits: amount };
  };
  // Copy only the reviewed public fields; unknown fields never reach UI state.
  return {
    livemode: false,
    publishableKey: value.publishable_key,
    currency: 'USD',
    expiresAt,
    merchant: value.merchant,
    product: PRODUCT,
    prices: {
      month: parsePrice(value.prices.month, 'month'),
      year: parsePrice(value.prices.year, 'year'),
    },
    paymentMethods: parsePaymentMethods(value.payment_methods),
  };
}
export function configurationMatchesReview(
  configuration: CheckoutConfiguration,
  review: CheckoutReview,
  now = Date.now(),
): boolean {
  const price = configuration.prices[review.interval];
  return (
    configuration.expiresAt > now &&
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
    configuration.livemode === binding.livemode &&
    configuration.merchant === binding.initial?.intent.merchant_id &&
    configuration.publishableKey === binding.initial?.action.publishable_key
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
