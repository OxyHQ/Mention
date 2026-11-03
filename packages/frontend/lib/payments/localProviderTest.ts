import {
  type EmbeddedCheckoutBinding,
  embeddedCheckoutPhase,
  providerActionMatchesEnvironment,
} from './embeddedCheckout';
/** Explicit local payer capability; never an application/server credential. */
export type LocalProviderTestBinding = EmbeddedCheckoutBinding;
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
  if (
    !intentId ||
    !/^pi_[A-Za-z0-9_-]+$/.test(intentId) ||
    !clientSecret ||
    clientSecret.length > 512
  )
    return null;
  return { apiUrl: 'http://127.0.0.1:4310', intentId, clientSecret, environment: 'test' };
}
export function isTestProviderAction(action: { kind: string; publishable_key?: string }): boolean {
  return providerActionMatchesEnvironment(action, 'test');
}
export const localProviderPhase = embeddedCheckoutPhase;

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
  const response = await fetch('http://127.0.0.1:4310/__local/checkout-test', {
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
    !('intentId' in data) ||
    !('clientSecret' in data) ||
    typeof data.intentId !== 'string' ||
    !/^pi_[A-Za-z0-9_-]+$/.test(data.intentId) ||
    typeof data.clientSecret !== 'string' ||
    !data.clientSecret ||
    data.clientSecret.length > 512
  )
    throw new Error('Local test checkout is unavailable.');
  if (
    !('kind' in data) ||
    data.kind !== 'subscription' ||
    !('subscriptionId' in data) ||
    typeof data.subscriptionId !== 'string' ||
    !data.subscriptionId ||
    data.subscriptionId.length > 128 ||
    !('interval' in data) ||
    data.interval !== interval ||
    !('amountMinorUnits' in data) ||
    typeof data.amountMinorUnits !== 'number' ||
    !Number.isSafeInteger(data.amountMinorUnits) ||
    data.amountMinorUnits <= 0 ||
    !('currency' in data) ||
    data.currency !== 'USD'
  )
    throw new Error('Subscription checkout is unavailable.');
  let tax: NonNullable<EmbeddedCheckoutBinding['subscription']>['tax'];
  if ('tax' in data && data.tax && typeof data.tax === 'object') {
    const quote = data.tax;
    if (
      'subtotalMinorUnits' in quote &&
      typeof quote.subtotalMinorUnits === 'number' &&
      Number.isSafeInteger(quote.subtotalMinorUnits) &&
      quote.subtotalMinorUnits >= 0 &&
      'taxMinorUnits' in quote &&
      typeof quote.taxMinorUnits === 'number' &&
      Number.isSafeInteger(quote.taxMinorUnits) &&
      quote.taxMinorUnits >= 0 &&
      'totalMinorUnits' in quote &&
      quote.totalMinorUnits === data.amountMinorUnits &&
      quote.subtotalMinorUnits + quote.taxMinorUnits === quote.totalMinorUnits &&
      'inclusive' in quote &&
      typeof quote.inclusive === 'boolean'
    )
      tax = {
        subtotalMinorUnits: quote.subtotalMinorUnits,
        taxMinorUnits: quote.taxMinorUnits,
        totalMinorUnits: quote.totalMinorUnits,
        inclusive: quote.inclusive,
      };
    else throw new Error('Subscription quote is unavailable.');
  }
  let paymentMethods: EmbeddedCheckoutBinding['paymentMethods'];
  if ('paymentMethods' in data) {
    if (!Array.isArray(data.paymentMethods))
      throw new Error('Payment availability is unavailable.');
    paymentMethods = data.paymentMethods.map((entry: unknown) => {
      if (
        !entry ||
        typeof entry !== 'object' ||
        !('id' in entry) ||
        !['card', 'bank', 'installments', 'faircoin'].includes(String(entry.id)) ||
        !('available' in entry) ||
        typeof entry.available !== 'boolean' ||
        ('reason' in entry && typeof entry.reason !== 'string')
      )
        throw new Error('Payment availability is unavailable.');
      return {
        id: entry.id as 'card' | 'bank' | 'installments' | 'faircoin',
        available: entry.available,
        reason: 'reason' in entry ? String(entry.reason) : undefined,
      };
    });
  }
  return {
    apiUrl: 'http://127.0.0.1:4310',
    intentId: data.intentId,
    clientSecret: data.clientSecret,
    environment: 'test',
    paymentMethods,
    subscription: {
      id: data.subscriptionId,
      interval,
      amountMinorUnits: data.amountMinorUnits,
      currency: data.currency,
      tax,
      observationPath: `/__local/checkout-test/${data.intentId}/subscription`,
    },
  };
}
