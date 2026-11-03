import { createPeableCheckout, type PeableClientAction } from '@peable.to/sdk/checkout';

/** Payer-scoped transport binding. Environment changes credentials, never the checkout view. */
export interface EmbeddedCheckoutBinding {
  apiUrl: string;
  intentId: string;
  clientSecret: string;
  environment: 'test' | 'live';
  initial?: {
    intent: Awaited<ReturnType<ReturnType<typeof createPeableCheckout>['getPaymentIntent']>>;
    action: PeableClientAction;
  };
  paymentMethods?: readonly {
    id: 'card' | 'bank' | 'installments' | 'faircoin';
    available: boolean;
    reason?: string;
  }[];
  subscription?: {
    id: string;
    interval: 'month' | 'year';
    amountMinorUnits: number;
    currency: string;
    startsOn?: string;
    tax?: {
      subtotalMinorUnits: number;
      taxMinorUnits: number;
      totalMinorUnits: number;
      inclusive: boolean;
    };
    observationPath: string;
  };
}
export function providerActionMatchesEnvironment(
  action: { kind: string; publishableKey?: string },
  environment: EmbeddedCheckoutBinding['environment'],
): boolean {
  return (
    action.kind === 'client_secret' &&
    !!action.publishableKey?.startsWith(environment === 'test' ? 'pk_test_' : 'pk_live_')
  );
}
export function embeddedCheckoutPhase(status: string): 'entry' | 'pending' | 'success' | 'failure' {
  if (status === 'settled') return 'success';
  if (['expired', 'rejected', 'underpaid'].includes(status)) return 'failure';
  if (['created', 'requires_action', 'failed'].includes(status)) return 'entry';
  return 'pending';
}

/** Reads only payer-authorized observation; a paid first invoice alone is not subscription activation. */
export async function observeEmbeddedSubscription(
  binding: EmbeddedCheckoutBinding,
): Promise<boolean> {
  if (!binding.subscription) return true;
  const base = new URL(binding.apiUrl);
  const url = new URL(binding.subscription.observationPath, base);
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        binding.environment === 'test' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error('Subscription observation is unavailable.');
  const response = await fetch(url.toString(), {
    headers: { 'X-Peable-Client-Secret': binding.clientSecret },
    credentials: 'omit',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Subscription observation is unavailable.');
  const value: unknown = await response.json();
  return (
    !!value &&
    typeof value === 'object' &&
    'ready' in value &&
    value.ready === true &&
    'subscriptionStatus' in value &&
    value.subscriptionStatus === 'active' &&
    'invoiceStatus' in value &&
    value.invoiceStatus === 'paid' &&
    'paymentStatus' in value &&
    value.paymentStatus === 'settled'
  );
}

/** Resolve payer-owned data before presenting checkout, without a second loading surface. */
export async function prepareEmbeddedCheckout(
  binding: EmbeddedCheckoutBinding,
  signal?: AbortSignal,
): Promise<EmbeddedCheckoutBinding> {
  const client = createPeableCheckout({ gatewayUrl: binding.apiUrl });
  const [intent, action] = await Promise.all([
    client.getPaymentIntent(binding.intentId, binding.clientSecret),
    client.getClientAction(binding.intentId, binding.clientSecret),
  ]);
  if (signal?.aborted) throw new Error('Checkout preparation canceled.');
  if (
    intent.id !== binding.intentId ||
    intent.rail !== 'card' ||
    intent.currency !== 'USD' ||
    !/^\d+$/.test(intent.amount) ||
    !Number.isSafeInteger(Number(intent.amount)) ||
    Number(intent.amount) <= 0 ||
    (binding.subscription &&
      (Number(intent.amount) !== binding.subscription.amountMinorUnits ||
        intent.currency !== binding.subscription.currency)) ||
    !providerActionMatchesEnvironment(action, binding.environment)
  )
    throw new Error('Checkout is unavailable.');
  return { ...binding, initial: { intent, action } };
}
