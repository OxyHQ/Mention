/** Merchant-neutral checkout view model. Amounts are quoted minor units, never client prices. */
export type CheckoutStep =
  | 'review'
  | 'contact'
  | 'shipping'
  | 'delivery'
  | 'payment'
  | 'card'
  | 'processing'
  | 'success'
  | 'failure';
export type CheckoutScenario = 'subscription' | 'physical' | 'trial';
export type PreviewOutcome = 'success' | 'failure' | 'loading';
export interface CheckoutItem {
  id: string;
  name: string;
  detail: string;
  quantity: number;
  amountMinorUnits: number;
  image?: number | { uri: string };
}
export interface CheckoutRequest {
  merchant: string;
  currency: string;
  dueTodayMinorUnits: number;
  items: CheckoutItem[];
  requiresShipping: boolean;
  paymentMethods: readonly ('card' | 'faircoin')[];
  recurring?: {
    amountMinorUnits: number;
    interval: 'month' | 'year';
    startsOn?: string;
    renewalTerms?: string;
    cancellationTerms?: string;
  };
}
/** Card metadata only. Provider fields/tokenization must own PAN, expiry and security codes. */
export interface CheckoutCard {
  id: string;
  brand: 'Visa' | 'Mastercard';
  last4: string;
  saveForLater: boolean;
}
export interface CheckoutDraft {
  email: string;
  shipping: { name: string; address: string; city: string; postalCode: string; country: string };
  delivery: 'standard' | 'express' | null;
  card: CheckoutCard | null;
}
export const emptyCheckoutDraft = (): CheckoutDraft => ({
  email: '',
  shipping: { name: '', address: '', city: '', postalCode: '', country: '' },
  delivery: null,
  card: null,
});
export function nextCheckoutStep(request: CheckoutRequest, draft: CheckoutDraft): CheckoutStep {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) return 'contact';
  if (request.requiresShipping && Object.values(draft.shipping).some((value) => !value.trim()))
    return 'shipping';
  if (request.requiresShipping && !draft.delivery) return 'delivery';
  if (!draft.card || !request.paymentMethods.includes('card')) return 'payment';
  return 'review';
}
export function checkoutSections(
  request: CheckoutRequest,
): Array<'contact' | 'shipping' | 'delivery' | 'payment'> {
  return request.requiresShipping
    ? ['contact', 'shipping', 'delivery', 'payment']
    : ['contact', 'payment'];
}
/** Optional future device authorization, supplied by the host. No biometric implementation is implied. */
export interface CheckoutAuthorization {
  authorize?: () => Promise<'authorized' | 'cancelled'>;
}
