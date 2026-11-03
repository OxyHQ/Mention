import type { CheckoutSessionAction } from '@peable.to/sdk/checkout/ui';
import type { EmbeddedCheckoutBinding } from './embeddedCheckout';

/** Oxy-owned subscription session. No PaymentIntent or payer socket is synthesized for it. */
export interface SessionCheckoutBinding {
  action: CheckoutSessionAction;
  subscription: Pick<
    NonNullable<EmbeddedCheckoutBinding['subscription']>,
    'interval' | 'amountMinorUnits' | 'currency' | 'tax' | 'startsOn'
  >;
  paymentMethods: NonNullable<EmbeddedCheckoutBinding['paymentMethods']>;
}

export type SessionCheckoutPreparation =
  | SessionCheckoutBinding
  | { state: 'awaiting_fulfillment' }
  | { state: 'billing_details_required' };
