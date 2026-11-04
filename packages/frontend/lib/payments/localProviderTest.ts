import {
  type EmbeddedCheckoutBinding,
  embeddedCheckoutPhase,
  providerActionMatchesMode,
} from './embeddedCheckout';
import { parseBaseUnits, parsePaymentMethods } from './peableWire';
/** Explicit local payer capability; never an application/server credential. */
export type LocalProviderTestBinding = EmbeddedCheckoutBinding;
const LOCAL_API_URL = 'http://127.0.0.1:4310';
const INTENT_ID = /^pi_[A-Za-z0-9_-]+$/;
export function localProviderTestBinding(
  href: string,
  enabled: boolean,
): LocalProviderTestBinding | null {
  if (!enabled) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return null;
  const fragment = new URLSearchParams(url.hash.slice(1));
  const intentId = fragment.get('peable_test_intent');
  const clientSecret = fragment.get('peable_test_secret');
  if (!intentId || !INTENT_ID.test(intentId) || !clientSecret || clientSecret.length > 512)
    return null;
  return { apiUrl: LOCAL_API_URL, intentId, clientSecret, livemode: false };
}
export function isTestProviderAction(action: { kind: string; publishable_key?: string }): boolean {
  return providerActionMatchesMode(action, false);
}
export const localProviderPhase = embeddedCheckoutPhase;

type SubscriptionTax = NonNullable<EmbeddedCheckoutBinding['subscription']>['tax'];

/** The first invoice's breakdown (`amount_subtotal` / `amount_tax` / `amount_total`), or `undefined` when the harness has none. */
function parseTax(value: unknown, amount: number): SubscriptionTax {
  if (value === null) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Subscription quote is unavailable.');
  const subtotal = 'amount_subtotal' in value ? parseBaseUnits(value.amount_subtotal) : null;
  const tax = 'amount_tax' in value ? parseBaseUnits(value.amount_tax) : null;
  const total = 'amount_total' in value ? parseBaseUnits(value.amount_total) : null;
  if (
    subtotal === null ||
    tax === null ||
    total !== amount ||
    subtotal + tax !== total ||
    !('inclusive' in value) ||
    typeof value.inclusive !== 'boolean'
  )
    throw new Error('Subscription quote is unavailable.');
  return {
    subtotalMinorUnits: subtotal,
    taxMinorUnits: tax,
    totalMinorUnits: total,
    inclusive: value.inclusive,
  };
}

/** Local harness only: credentials remain in component memory and errors never echo response bodies. */
export async function createLocalProviderTestBinding(
  operationKey: string,
  href: string,
  enabled: boolean,
  signal?: AbortSignal,
  interval: 'month' | 'year' = 'month',
): Promise<LocalProviderTestBinding> {
  const url = new URL(href);
  if (!enabled || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '8110')
    throw new Error('Local test checkout is unavailable.');
  const response = await fetch(`${LOCAL_API_URL}/__local/checkout-test`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Peable-Local-Test': '1',
      'Idempotency-Key': operationKey,
    },
    body: JSON.stringify({ interval }),
    signal,
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Local test checkout is unavailable.');
  const data: unknown = await response.json();
  if (
    !data ||
    typeof data !== 'object' ||
    !('object' in data) ||
    data.object !== 'local_test_subscription' ||
    !('livemode' in data) ||
    data.livemode !== false ||
    !('payment_intent' in data) ||
    typeof data.payment_intent !== 'string' ||
    !INTENT_ID.test(data.payment_intent) ||
    !('client_secret' in data) ||
    typeof data.client_secret !== 'string' ||
    !data.client_secret ||
    data.client_secret.length > 512
  )
    throw new Error('Local test checkout is unavailable.');
  const amount = 'amount' in data ? parseBaseUnits(data.amount) : null;
  if (
    !('subscription' in data) ||
    typeof data.subscription !== 'string' ||
    !data.subscription ||
    data.subscription.length > 128 ||
    !('interval' in data) ||
    data.interval !== interval ||
    amount === null ||
    amount <= 0 ||
    !('currency' in data) ||
    data.currency !== 'USD'
  )
    throw new Error('Subscription checkout is unavailable.');
  return {
    apiUrl: LOCAL_API_URL,
    intentId: data.payment_intent,
    clientSecret: data.client_secret,
    livemode: false,
    paymentMethods: parsePaymentMethods('payment_methods' in data ? data.payment_methods : null),
    subscription: {
      id: data.subscription,
      interval,
      amountMinorUnits: amount,
      currency: data.currency,
      tax: parseTax('tax' in data ? data.tax : undefined, amount),
      observationPath: `/__local/checkout-test/${data.payment_intent}/subscription`,
    },
  };
}
