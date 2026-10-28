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
    [paid.invoiceId, request.invoiceId],
    [source.invoiceId, request.invoiceId],
    [paid.providerSubscriptionId, request.subscriptionId],
    [source.subscriptionId, request.subscriptionId],
    [context.providerSubscriptionId, request.subscriptionId],
    [paid.storeId, request.payerAccountId],
    [context.payerAccountId, request.payerAccountId],
    // Membership access belongs to its payer. Gift/delegated billing requires a new contract.
    [context.beneficiaryAccountId, request.payerAccountId],
    [paid.paymentIntentId, source.paymentIntentId],
    [paid.providerCustomerId, source.customerId],
    [paid.providerPriceId, offer.providerPriceId],
    [source.priceId, offer.providerPriceId],
    [paid.planId, offer.planId],
    [source.planId, offer.planId],
    [source.merchantId, offer.merchantId],
    [source.appId, offer.appId],
    [source.mode, offer.mode],
    [context.mode, offer.mode],
    [source.environment, offer.environment],
    [context.environment, offer.environment],
    [context.offerId, offer.offerId],
    [paid.currency, invoice.currency],
    [paid.periodStart, context.periodStart],
    [paid.periodEnd, context.periodEnd],
    [paid.amountPaid, String(invoice.grossMinorUnits)],
    [paid.netAmount, String(invoice.netMinorUnits)],
    [paid.taxAmount, String(invoice.taxMinorUnits)],
  ];
  const dates = [paid.periodStart, paid.periodEnd, paid.paidAt, paid.observedAt].map(Date.parse);
  const [start, end, paidAt, observedAt] = dates;
  if (
    exact.some(([left, right]) => !left || left !== right) ||
    context.offerVersion !== offer.offerVersion ||
    !Number.isSafeInteger(offer.offerVersion) ||
    offer.offerVersion < 1 ||
    paid.livemode !== (offer.mode === 'live') ||
    !Number.isSafeInteger(invoice.grossMinorUnits) ||
    invoice.grossMinorUnits <= 0 ||
    !Number.isSafeInteger(invoice.netMinorUnits) ||
    invoice.netMinorUnits < 0 ||
    !Number.isSafeInteger(invoice.taxMinorUnits) ||
    invoice.taxMinorUnits < 0 ||
    invoice.netMinorUnits + invoice.taxMinorUnits !== invoice.grossMinorUnits ||
    dates.some((date) => !Number.isFinite(date)) ||
    start === undefined ||
    end === undefined ||
    paidAt === undefined ||
    observedAt === undefined ||
    end <= start ||
    paidAt > now.getTime() ||
    observedAt > now.getTime() ||
    observedAt < paidAt ||
    !['paid', 'partially_refunded', 'fully_refunded'].includes(paid.state) ||
    !/^(0|[1-9][0-9]*)$/.test(paid.amountRefunded)
  )
    throw new MembershipError(409, 'Invoice does not match the membership offer');
  const refunded = BigInt(paid.amountRefunded);
  const gross = BigInt(invoice.grossMinorUnits);
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
    paymentIntentId: paid.paymentIntentId,
    providerCustomerId: paid.providerCustomerId,
    periodStart: new Date(start),
    periodEnd: new Date(end),
    paidAt: new Date(paidAt),
    observedAt: new Date(observedAt),
    state: paid.state,
  };
}
