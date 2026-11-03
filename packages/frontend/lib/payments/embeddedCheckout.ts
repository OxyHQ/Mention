import { createPeableCheckout, type PeableClientAction } from '@peable.to/sdk/checkout';
import { type CheckoutPaymentMethod, parseBaseUnits } from './peableWire';

type PeableIntent = Awaited<
  ReturnType<ReturnType<typeof createPeableCheckout>['getPaymentIntent']>
>;

/** Payer-scoped transport binding. The mode changes credentials, never the checkout view. */
export interface EmbeddedCheckoutBinding {
  apiUrl: string;
  intentId: string;
  clientSecret: string;
  /** Peable's mode (`livemode`): `false` binds test credentials, `true` live ones. */
  livemode: boolean;
  initial?: {
    intent: PeableIntent;
    action: PeableClientAction;
  };
  paymentMethods?: readonly CheckoutPaymentMethod[];
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

export function providerActionMatchesMode(
  action: { kind: string; publishable_key?: string },
  livemode: boolean,
): boolean {
  return (
    action.kind === 'client_secret' &&
    !!action.publishable_key?.startsWith(livemode ? 'pk_live_' : 'pk_test_')
  );
}

/** The intent is the one this binding pays: same id and mode, a positive USD card amount, the subscription's terms. */
export function intentMatchesBinding(intent: PeableIntent, binding: EmbeddedCheckoutBinding) {
  const amount = parseBaseUnits(intent.amount);
  return (
    intent.id === binding.intentId &&
    intent.livemode === binding.livemode &&
    intent.rail === 'card' &&
    intent.currency === 'USD' &&
    amount !== null &&
    amount > 0 &&
    (!binding.subscription ||
      (amount === binding.subscription.amountMinorUnits &&
        intent.currency === binding.subscription.currency))
  );
}

/**
 * Peable's PaymentIntent statuses are Stripe's seven (Peable ADR 0019): an
 * expired, rejected or underpaid intent is `canceled`; a declined card returns
 * to `requires_payment_method` with `last_payment_error` set.
 */
export function embeddedCheckoutPhase(status: string): 'entry' | 'pending' | 'success' | 'failure' {
  if (status === 'succeeded') return 'success';
  if (status === 'canceled') return 'failure';
  if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(status))
    return 'entry';
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
        !binding.livemode &&
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
    'livemode' in value &&
    value.livemode === binding.livemode &&
    'payment_intent' in value &&
    value.payment_intent === binding.intentId &&
    'subscription' in value &&
    value.subscription === binding.subscription.id &&
    'ready' in value &&
    value.ready === true &&
    'subscription_status' in value &&
    value.subscription_status === 'active' &&
    'invoice_status' in value &&
    value.invoice_status === 'paid' &&
    'payment_status' in value &&
    value.payment_status === 'succeeded'
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
    !intentMatchesBinding(intent, binding) ||
    !providerActionMatchesMode(action, binding.livemode)
  )
    throw new Error('Checkout is unavailable.');
  return { ...binding, initial: { intent, action } };
}
