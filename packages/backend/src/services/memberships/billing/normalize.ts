import type { Peable } from '@peable.to/sdk';
import { MembershipError } from '../errors';
import type { MembershipBillingOffer } from './catalogue';

type InvoiceState = Awaited<ReturnType<Peable['billing']['retrieveInvoiceState']>>;
type InvoiceAuthority = Awaited<ReturnType<Peable['billing']['retrieveFinalInvoiceAuthority']>>;

export interface MembershipInvoiceRequest {
  payerAccountId: string;
  subscriptionId: string;
  invoiceId: string;
}

/** Peable instants are integer Unix seconds (ADR 0014). */
function isUnixSeconds(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/** Called only after the official SDK verifies the final authority signature. */
export function normalizeMembershipInvoice(
  offer: MembershipBillingOffer,
  request: MembershipInvoiceRequest,
  paid: InvoiceState,
  authority: InvoiceAuthority,
  now = new Date(),
) {
  const source = authority.source;
  const invoice = authority.invoice;
  const context = invoice.context;
  const exact = [
    [paid.invoice_id, request.invoiceId],
    [source.invoice_id, request.invoiceId],
    [paid.provider_subscription_id, request.subscriptionId],
    [source.subscription_id, request.subscriptionId],
    [context.provider_subscription_id, request.subscriptionId],
    [paid.store_id, request.payerAccountId],
    [context.payer_account_id, request.payerAccountId],
    // Membership access belongs to its payer. Gift/delegated billing requires a new contract.
    [context.beneficiary_account_id, request.payerAccountId],
    [paid.payment_intent_id, source.payment_intent_id],
    [paid.provider_customer_id, source.customer_id],
    [paid.provider_price_id, offer.providerPriceId],
    [source.price_id, offer.providerPriceId],
    [paid.plan_id, offer.planId],
    [source.plan_id, offer.planId],
    [source.merchant_id, offer.merchantId],
    [source.app_id, offer.appId],
    [source.mode, offer.mode],
    [context.mode, offer.mode],
    [source.environment, offer.environment],
    [context.environment, offer.environment],
    [context.offer_id, offer.offerId],
    [paid.currency, invoice.currency],
    [paid.amount_paid, String(invoice.gross_minor_units)],
    [paid.net_amount, String(invoice.net_minor_units)],
    [paid.tax_amount, String(invoice.tax_minor_units)],
  ];
  const instants = [paid.period_start, paid.period_end, paid.paid_at, paid.observed_at];
  const [start, end, paidAt, observedAt] = instants;
  const nowSeconds = now.getTime() / 1000;
  if (
    exact.some(([left, right]) => !left || left !== right) ||
    context.offer_version !== offer.offerVersion ||
    !Number.isSafeInteger(offer.offerVersion) ||
    offer.offerVersion < 1 ||
    paid.livemode !== (offer.mode === 'live') ||
    !Number.isSafeInteger(invoice.gross_minor_units) ||
    invoice.gross_minor_units <= 0 ||
    !Number.isSafeInteger(invoice.net_minor_units) ||
    invoice.net_minor_units < 0 ||
    !Number.isSafeInteger(invoice.tax_minor_units) ||
    invoice.tax_minor_units < 0 ||
    invoice.net_minor_units + invoice.tax_minor_units !== invoice.gross_minor_units ||
    !instants.every(isUnixSeconds) ||
    start === undefined ||
    end === undefined ||
    paidAt === undefined ||
    observedAt === undefined ||
    start !== context.period_start ||
    end !== context.period_end ||
    end <= start ||
    paidAt > nowSeconds ||
    observedAt > nowSeconds ||
    observedAt < paidAt ||
    !['paid', 'partially_refunded', 'fully_refunded'].includes(paid.state) ||
    !/^(0|[1-9][0-9]*)$/.test(paid.amount_refunded)
  )
    throw new MembershipError(409, 'Invoice does not match the membership offer');
  const refunded = BigInt(paid.amount_refunded);
  const gross = BigInt(invoice.gross_minor_units);
  if (
    refunded > gross ||
    (paid.state === 'paid' && refunded !== 0n) ||
    (paid.state === 'fully_refunded' && refunded !== gross) ||
    (paid.state === 'partially_refunded' && (refunded === 0n || refunded === gross))
  )
    throw new MembershipError(409, 'Invoice refund state is inconsistent');
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
    planId: offer.planId,
    paymentIntentId: paid.payment_intent_id,
    providerCustomerId: paid.provider_customer_id,
    periodStart: new Date(start * 1000),
    periodEnd: new Date(end * 1000),
    paidAt: new Date(paidAt * 1000),
    observedAt: new Date(observedAt * 1000),
    state: paid.state,
  };
}
