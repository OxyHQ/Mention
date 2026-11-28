import type { Invoice, PaymentIntent, Subscription } from '@peable.to/sdk';
import { MembershipError } from '../errors';
import type { MembershipBillingOffer } from './catalogue';

/** The merchant the calling credential resolves to (`GET /v1/merchants/me`). */
export interface MembershipBillingMerchant {
  id: string;
  oxy_app_id: string;
  environment: string;
}

export interface MembershipInvoiceRequest {
  payerAccountId: string;
  subscriptionId: string;
  invoiceId: string;
}

/** What Peable's native engine answers for one invoice, read with Mention's own credential. */
export interface MembershipInvoiceEvidence {
  merchant: MembershipBillingMerchant;
  invoice: Invoice;
  subscription: Subscription;
  paymentIntent: PaymentIntent;
}

/**
 * Metadata Mention writes on the subscription at checkout
 * (`subscription_data.metadata`), with its own service credential. A payer
 * cannot write it, so it binds the subscription to one payer, community, tier
 * and offer version.
 */
export const MEMBERSHIP_SUBSCRIPTION_METADATA = {
  payer: 'payer_account_id',
  community: 'community_id',
  tier: 'tier_id',
  offer: 'offer_id',
  offerVersion: 'offer_version',
} as const;

/** Peable instants are integer Unix seconds (ADR 0014). */
function isUnixSeconds(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Peable amounts are base-unit integer strings (ADR 0014 D1). Signed fields must be positive here. */
const BASE_UNITS = /^(0|[1-9][0-9]*)$/;

/** An expandable reference's id, whether Peable answered the id or the object. */
function refId(value: string | { id: string } | null | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return value?.id;
}

/**
 * Bind one native invoice to one reviewed membership offer.
 *
 * Every input is an authoritative read of Peable's own objects, made by Mention's
 * workload over the gateway — never a payload a client or a webhook handed in.
 * The merchant binds application and environment; `livemode` binds the mode; the
 * subscription's metadata binds payer, community, tier and offer version; its one
 * item and the invoice's one subscription line bind the price (a Peable price never
 * changes what it charges, so the price is the product and the amount); the
 * PaymentIntent binds the money actually received and refunded.
 */
export function normalizeMembershipInvoice(
  offer: MembershipBillingOffer,
  request: MembershipInvoiceRequest,
  evidence: MembershipInvoiceEvidence,
  now = new Date(),
) {
  const { merchant, invoice, subscription, paymentIntent } = evidence;
  const meta = subscription.metadata;
  const keys = MEMBERSHIP_SUBSCRIPTION_METADATA;
  const customerId = refId(invoice.customer);
  const items = subscription.items.data;
  const lines = invoice.lines.data;
  // Exactly one line: the subscription's own. A proration, an extra item or a
  // discount line is a different sale than the reviewed offer.
  const line = lines.length === 1 && lines[0]?.type === 'subscription' ? lines[0] : undefined;
  const livemode = offer.mode === 'live';
  const exact: Array<[string | null | undefined, string]> = [
    [merchant.id, offer.merchantId],
    [merchant.oxy_app_id, offer.appId],
    [merchant.environment, offer.environment],
    [invoice.id, request.invoiceId],
    [refId(invoice.subscription), request.subscriptionId],
    [subscription.id, request.subscriptionId],
    [refId(subscription.customer), customerId ?? ''],
    [refId(paymentIntent.customer), customerId ?? ''],
    [refId(invoice.payment_intent), paymentIntent.id],
    [meta[keys.payer], request.payerAccountId],
    [meta[keys.community], offer.communityId],
    [meta[keys.tier], offer.tierId],
    [meta[keys.offer], offer.offerId],
    [meta[keys.offerVersion], String(offer.offerVersion)],
    [items[0]?.price.id, offer.providerPriceId],
    [line?.price?.id, offer.providerPriceId],
    [line?.subscription, request.subscriptionId],
    [paymentIntent.currency, invoice.currency],
    [paymentIntent.amount_received, invoice.amount_paid],
    [invoice.total, invoice.amount_paid],
  ];
  const paidAt = invoice.status_transitions.paid_at;
  const start = line?.period.start;
  const end = line?.period.end;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !customerId ||
    exact.some(([left, right]) => !left || left !== right) ||
    !Number.isSafeInteger(offer.offerVersion) ||
    offer.offerVersion < 1 ||
    [invoice.livemode, subscription.livemode, paymentIntent.livemode].some(
      (mode) => mode !== livemode,
    ) ||
    items.length !== 1 ||
    items[0]?.quantity !== 1 ||
    line?.quantity !== 1 ||
    line.proration ||
    invoice.status !== 'paid' ||
    invoice.paid_out_of_band ||
    paymentIntent.status !== 'succeeded' ||
    !BASE_UNITS.test(invoice.amount_paid) ||
    invoice.amount_paid === '0' ||
    invoice.tax === null ||
    !BASE_UNITS.test(invoice.tax) ||
    !isUnixSeconds(paidAt) ||
    !isUnixSeconds(start) ||
    !isUnixSeconds(end) ||
    end <= start ||
    paidAt > nowSeconds ||
    !BASE_UNITS.test(paymentIntent.amount_refunded)
  )
    throw new MembershipError(409, 'Invoice does not match the membership offer');
  const refunded = BigInt(paymentIntent.amount_refunded);
  const paid = BigInt(invoice.amount_paid);
  if (refunded > paid) throw new MembershipError(409, 'Invoice refund state is inconsistent');
  const state: 'paid' | 'partially_refunded' | 'fully_refunded' =
    refunded === 0n ? 'paid' : refunded === paid ? 'fully_refunded' : 'partially_refunded';
  return {
    communityId: offer.communityId,
    tierId: offer.tierId,
    payerOxyUserId: request.payerAccountId,
    invoiceId: request.invoiceId,
    subscriptionId: request.subscriptionId,
    merchantId: offer.merchantId,
    appId: offer.appId,
    mode: offer.mode,
    environment: offer.environment,
    offerId: offer.offerId,
    offerVersion: offer.offerVersion,
    providerPriceId: offer.providerPriceId,
    paymentIntentId: paymentIntent.id,
    providerCustomerId: customerId,
    periodStart: new Date(start * 1000),
    periodEnd: new Date(end * 1000),
    paidAt: new Date(paidAt * 1000),
    observedAt: new Date(nowSeconds * 1000),
    state,
  };
}
