import { and, eq } from 'drizzle-orm';
import { Peable, PEABLE_BILLING_AUTHORITY_KEYS } from '@peable.to/sdk';
import { getDb } from '../../../db/postgres';
import { membershipBillingReceipts } from '../../../db/schema/membershipBilling';
import { membershipTiers } from '../../../db/schema/memberships';
import { getServiceOxyClient } from '../../../utils/oxyHelpers';
import type { RequestSafetyContext } from '../../../utils/safetyRequester';
import { requireMembershipSafety } from '../safety';
import { communityById, MembershipError, type MembershipActor } from '../access';
import { MEMBERSHIP_BILLING_CATALOGUE } from './catalogue';
import { normalizeMembershipInvoice, type MembershipInvoiceRequest } from './normalize';

type NormalizedReceipt = ReturnType<typeof normalizeMembershipInvoice>;

/** Storage is separate from grants: no receipt can activate a paid tier or membership. */
export async function persistMembershipInvoice(receipt: NormalizedReceipt) {
  return getDb().transaction(async (tx) => {
    const [inserted] = await tx
      .insert(membershipBillingReceipts)
      .values(receipt)
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    const [existing] = await tx
      .select()
      .from(membershipBillingReceipts)
      .where(
        and(
          eq(membershipBillingReceipts.merchantId, receipt.merchantId),
          eq(membershipBillingReceipts.appId, receipt.appId),
          eq(membershipBillingReceipts.mode, receipt.mode),
          eq(membershipBillingReceipts.environment, receipt.environment),
          eq(membershipBillingReceipts.invoiceId, receipt.invoiceId),
        ),
      )
      .for('update');
    if (!existing) throw new MembershipError(409, 'Invoice receipt conflict');
    const immutable = [
      'communityId',
      'tierId',
      'payerOxyUserId',
      'subscriptionId',
      'offerId',
      'offerVersion',
      'providerPriceId',
      'planId',
      'paymentIntentId',
      'providerCustomerId',
    ] as const;
    if (
      immutable.some((key) => existing[key] !== receipt[key]) ||
      (['periodStart', 'periodEnd', 'paidAt'] as const).some(
        (key) => existing[key].getTime() !== receipt[key].getTime(),
      )
    )
      throw new MembershipError(409, 'Invoice receipt cannot be rebound');
    // Late observations cannot rewind a refund. Partial refunds never restore rights.
    const severity = { paid: 0, partially_refunded: 1, fully_refunded: 2 };
    if (
      receipt.observedAt < existing.observedAt ||
      severity[receipt.state] < severity[existing.state]
    )
      return existing;
    const [updated] = await tx
      .update(membershipBillingReceipts)
      .set({
        state: receipt.state,
        observedAt: receipt.observedAt,
      })
      .where(eq(membershipBillingReceipts.id, existing.id))
      .returning();
    if (!updated) throw new MembershipError(409, 'Invoice receipt disappeared');
    return updated;
  });
}

/** Internal foreground recovery boundary, deliberately not a generic webhook. */
export async function reconcileMembershipInvoice(
  communityId: string,
  tierId: string,
  actor: MembershipActor,
  request: RequestSafetyContext,
  invoice: Omit<MembershipInvoiceRequest, 'payerAccountId'>,
) {
  if (
    !request.user ||
    request.user.id !== actor.accountId ||
    !request.accessToken ||
    request.mcp ||
    request.capability ||
    request.serviceApp
  )
    throw new MembershipError(403, 'A foreground account session is required');
  const offers = MEMBERSHIP_BILLING_CATALOGUE.filter(
    (entry) => entry.communityId === communityId && entry.tierId === tierId,
  );
  const offer = offers.length === 1 ? offers[0] : undefined;
  if (!offer) throw new MembershipError(409, 'Membership billing is not configured');
  const community = await communityById(communityId);
  await requireMembershipSafety(community.ownerOxyUserId, community.id, actor.requester);
  const [tier] = await getDb()
    .select()
    .from(membershipTiers)
    .where(and(eq(membershipTiers.id, tierId), eq(membershipTiers.communityId, communityId)));
  if (tier?.kind !== 'paid') throw new MembershipError(409, 'Paid tier required');
  const client = new Peable({
    invoiceAuthorityKeys: PEABLE_BILLING_AUTHORITY_KEYS,
    oxy: getServiceOxyClient(),
    requester: { accountId: actor.accountId, token: request.accessToken },
  });
  try {
    const [paid, authority] = await Promise.all([
      client.billing.retrieveInvoiceState(invoice.subscriptionId, invoice.invoiceId),
      client.billing.retrieveFinalInvoiceAuthority(invoice.subscriptionId, invoice.invoiceId),
    ]);
    return await persistMembershipInvoice(
      normalizeMembershipInvoice(
        offer,
        { ...invoice, payerAccountId: actor.accountId },
        paid,
        authority,
      ),
    );
  } finally {
    client.dispose();
  }
}
