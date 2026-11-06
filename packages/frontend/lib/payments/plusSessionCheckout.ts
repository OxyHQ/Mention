import {
  type createPeableCheckout,
  payDeepLinkFor,
  sessionIdFromClientSecret,
} from '@peable.to/sdk/checkout';
import { parseBaseUnits } from './peableWire';

type PeableCheckoutClient = ReturnType<typeof createPeableCheckout>;
export type PlusCheckoutSession = Awaited<ReturnType<PeableCheckoutClient['getCheckoutSession']>>;
export type PlusSessionIntent = NonNullable<PlusCheckoutSession['payment_intent']>;
export type FaircoinUnavailableReason = NonNullable<
  NonNullable<PlusCheckoutSession['faircoin']>['unavailable_reason']
>;

/** The payer's capability for one Peable Checkout Session, read from its hosted URL. */
export interface PlusSessionCapability {
  sessionId: string;
  clientSecret: string;
}

const HOSTED_CHECKOUT_ORIGIN = 'https://checkout.peable.to';

/**
 * Oxy's `startProductPlanCheckout` answers Peable's hosted URL,
 * `https://checkout.peable.to/c/<cs_…>#cs=<client secret>`. The fragment is the
 * payer's capability for that session, so Mention can drive the same order in
 * its own sheet. Anything else is not a Peable session and stays hosted.
 */
export function hostedSessionCapability(url: string): PlusSessionCapability | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (
    parsed.origin !== HOSTED_CHECKOUT_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.search
  )
    return null;
  const path = /^\/c\/(cs_[A-Za-z0-9]+)$/.exec(parsed.pathname);
  const clientSecret = new URLSearchParams(parsed.hash.replace(/^#/, '')).get('cs');
  if (!path || !clientSecret || sessionIdFromClientSecret(clientSecret) !== path[1]) return null;
  return { sessionId: path[1], clientSecret };
}

/** The session is the Plus order Mention reviewed: same subscription total and currency. */
export function sessionMatchesOffer(
  session: PlusCheckoutSession,
  capability: PlusSessionCapability,
  price: { amountMinorUnits: number; currency: string },
): boolean {
  return (
    session.id === capability.sessionId &&
    session.mode === 'subscription' &&
    session.currency.toUpperCase() === price.currency.toUpperCase() &&
    parseBaseUnits(session.amount_total) === price.amountMinorUnits
  );
}

/** FairCoin is always listed (Peable ADR 0021); this says whether it can be chosen now, and why not. */
export function faircoinAvailability(session: PlusCheckoutSession): {
  available: boolean;
  reason: FaircoinUnavailableReason | null;
} {
  const faircoin = session.faircoin;
  if (!session.payment_method_types.includes('faircoin') || !faircoin)
    return { available: false, reason: 'temporarily_unavailable' };
  return faircoin.available
    ? { available: true, reason: null }
    : { available: false, reason: faircoin.unavailable_reason ?? 'temporarily_unavailable' };
}

const UNAVAILABLE_KEYS: Record<FaircoinUnavailableReason, string> = {
  faircoin_wallet_missing: 'walletMissing',
  faircoin_network_closed: 'networkClosed',
  price_unavailable: 'priceUnavailable',
  temporarily_unavailable: 'temporarilyUnavailable',
};

/** The i18n key for why FairCoin cannot be paid, in the payer's words. */
export function faircoinUnavailableKey(reason: FaircoinUnavailableReason | string | null): string {
  const key =
    reason && reason in UNAVAILABLE_KEYS
      ? UNAVAILABLE_KEYS[reason as FaircoinUnavailableReason]
      : 'temporarilyUnavailable';
  return `plus.checkout.faircoin.unavailable.${key}`;
}

/** A confirm refusal that names FairCoin's availability, mapped to the same reasons. */
export function faircoinRefusalReason(error: unknown): FaircoinUnavailableReason | null {
  const code =
    error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  if (code === 'faircoin_wallet_missing') return 'faircoin_wallet_missing';
  if (code === 'faircoin_network_closed') return 'faircoin_network_closed';
  if (code === 'faircoin_price_unavailable') return 'price_unavailable';
  return null;
}

/** A FairCoin payment the payer can still pay: the session's, on the chain rail, with its request. */
export interface FaircoinPayment {
  intent: PlusSessionIntent;
  /** FAIR base units (10⁻⁸ FAIR). */
  amount: string;
  /** The Peable wallet's `peable://pay?…` request; the wallet reports the transaction to the payment. */
  deepLink: string;
  quote: NonNullable<NonNullable<PlusSessionIntent['faircoin']>['quote']> | null;
}

export function faircoinPayment(
  intent: PlusSessionIntent | null | undefined,
): FaircoinPayment | null {
  if (intent?.rail !== 'faircoin' || !intent.faircoin) return null;
  const action = intent.next_action;
  const amount =
    action?.type === 'faircoin_payment' ? action.faircoin_payment.amount : intent.amount;
  if (parseBaseUnits(amount) === null) return null;
  return { intent, amount, deepLink: payDeepLinkFor(intent), quote: intent.faircoin.quote };
}

export type FaircoinTransferState =
  | 'awaiting'
  | 'detected'
  | 'processing'
  | 'succeeded'
  | 'failure'
  | 'expired';

/** Where the payer's FairCoin payment is, from the gateway's own intent; never from a client action. */
export function faircoinTransferState(
  intent: PlusSessionIntent,
  nowSeconds: number,
): FaircoinTransferState {
  if (intent.status === 'succeeded') return 'succeeded';
  if (intent.status === 'processing')
    return (intent.faircoin?.confirmations ?? 0) > 0 ? 'processing' : 'detected';
  if (intent.status === 'canceled')
    return intent.cancellation_reason === 'abandoned' ? 'expired' : 'failure';
  const expiresAt = intent.faircoin?.quote?.expires_at;
  return expiresAt !== undefined && expiresAt <= nowSeconds ? 'expired' : 'awaiting';
}

/** A FairCoin payment that has started moving money cannot be replaced by a card. */
export function faircoinInFlight(intent: PlusSessionIntent | null | undefined): boolean {
  return (
    !!intent &&
    intent.rail === 'faircoin' &&
    (intent.status === 'processing' || intent.status === 'succeeded')
  );
}

const FAIR_DECIMALS = 8;

/** FAIR base units as a trimmed decimal with thousands separators; bigint-free for Hermes. */
export function formatFairAmount(baseUnits: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(baseUnits)) return baseUnits;
  const padded = baseUnits.padStart(FAIR_DECIMALS + 1, '0');
  const whole = padded.slice(0, -FAIR_DECIMALS).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = padded.slice(-FAIR_DECIMALS).replace(/0+$/, '');
  return `${fraction ? `${whole}.${fraction}` : whole} FAIR`;
}
