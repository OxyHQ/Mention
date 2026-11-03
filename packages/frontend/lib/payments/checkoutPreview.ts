import { MENTION_PLUS_UI_PREVIEW } from '@/config';
/** Explicit development opt-in is compiled out in production; a loopback host is also mandatory. */
export function isLocalCheckoutPreview(): boolean {
  return (
    MENTION_PLUS_UI_PREVIEW &&
    typeof window !== 'undefined' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(window.location?.hostname ?? '')
  );
}

export type CheckoutScenario = 'subscription' | 'physical' | 'trial';
export type PreviewOutcome = 'success' | 'failure' | 'loading';
/** Host capability only; no biometric implementation is implied. */
export interface CheckoutAuthorization {
  authorize?: () => Promise<'authorized' | 'cancelled'>;
}

export type CheckoutCustomerMode = 'automatic' | 'guest' | 'account-preview';
/** Contact hints are not identity proofs and never authorize historical purchase claims. */
export interface CheckoutPreviewCustomer {
  kind: 'guest' | 'account';
  email?: string;
  displayName?: string;
  avatar?: string | null;
  simulated?: boolean;
}
