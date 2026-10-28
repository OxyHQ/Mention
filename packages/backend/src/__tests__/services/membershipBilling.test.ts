import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { connectPostgres, closePostgres, getDb } from '../../db/postgres';
import {
  membershipCommunities,
  membershipTiers,
  communityMemberships,
} from '../../db/schema/memberships';
import { membershipBillingReceipts } from '../../db/schema/membershipBilling';
import { normalizeMembershipInvoice } from '../../services/memberships/billing/normalize';
import {
  persistMembershipInvoice,
  reconcileMembershipInvoice,
} from '../../services/memberships/billing/receipts';
import type { MembershipBillingOffer } from '../../services/memberships/billing/catalogue';

const host = vi.hoisted(() => vi.fn());
vi.mock('../../utils/oxyHelpers', () => ({ getServiceOxyClient: host }));
const now = new Date('2026-10-28T00:00:00Z');
const start = '2026-10-01T00:00:00Z';
const end = '2026-11-01T00:00:00Z';
function fixture() {
  const offer: MembershipBillingOffer = {
    communityId: randomUUID(),
    tierId: randomUUID(),
    offerId: 'synthetic-offer',
    offerVersion: 1,
    merchantId: 'synthetic-merchant',
    appId: 'mention-test',
    mode: 'test',
    environment: 'development',
    providerPriceId: 'synthetic-price',
    planId: 'synthetic-plan',
  };
  const request = {
    payerAccountId: 'membership-billing-test-payer',
    subscriptionId: 'synthetic-subscription',
    invoiceId: randomUUID(),
  };
  const paid: Parameters<typeof normalizeMembershipInvoice>[2] = {
    invoiceId: request.invoiceId,
    lineId: 'line',
    paymentIntentId: 'payment',
    providerSubscriptionId: request.subscriptionId,
    providerCustomerId: 'customer',
    providerPriceId: offer.providerPriceId,
    storeId: request.payerAccountId,
    planId: offer.planId,
    livemode: false,
    currency: 'EUR',
    amountPaid: '100',
    netAmount: '80',
    taxAmount: '20',
    periodStart: start,
    periodEnd: end,
    paidAt: start,
    observedAt: now.toISOString(),
    chargeId: 'charge',
    amountRefunded: '0',
    state: 'paid',
  };
  const authority: Parameters<typeof normalizeMembershipInvoice>[3] = {
    schemaVersion: 1,
    source: {
      invoiceId: request.invoiceId,
      paymentIntentId: paid.paymentIntentId,
      customerId: paid.providerCustomerId,
      subscriptionId: request.subscriptionId,
      priceId: offer.providerPriceId,
      planId: offer.planId,
      merchantId: offer.merchantId,
      appId: offer.appId,
      mode: offer.mode,
      environment: offer.environment,
    },
    invoice: {
      platform: 'peable',
      currency: 'EUR',
      grossMinorUnits: 100,
      netMinorUnits: 80,
      taxMinorUnits: 20,
      merchantFeeMinorUnits: 0,
      taxTreatment: 'inclusive',
      sellerId: 'seller',
      invoiceIssuerId: 'issuer',
      taxQuoteId: 'taxquote',
      customerLocationEvidenceId: 'location',
      taxRateEvidenceId: 'rate',
      context: {
        payerAccountId: request.payerAccountId,
        beneficiaryAccountId: request.payerAccountId,
        providerSubscriptionId: request.subscriptionId,
        offerId: offer.offerId,
        offerVersion: offer.offerVersion,
        periodStart: start,
        periodEnd: end,
        mode: offer.mode,
        environment: offer.environment,
      },
      issuedAt: start,
      expiresAt: end,
    },
    method: 'card',
    signature: {
      algorithm: 'Ed25519',
      keyId: 'synthetic',
      value: 'not-a-signature-fixture-normalization-only',
    },
  };
  return { offer, request, paid, authority };
}
const communities: string[] = [];
beforeAll(connectPostgres);
afterAll(async () => {
  for (const id of communities)
    await getDb().delete(membershipCommunities).where(eq(membershipCommunities.id, id));
  await closePostgres();
});

describe('membership invoice normalization (after SDK signature verification)', () => {
  it('normalizes only exact signed scope and fiscal evidence', () => {
    const f = fixture();
    expect(normalizeMembershipInvoice(f.offer, f.request, f.paid, f.authority, now)).toMatchObject({
      payerOxyUserId: f.request.payerAccountId,
      state: 'paid',
      tierId: f.offer.tierId,
    });
    for (const key of [
      'merchantId',
      'appId',
      'mode',
      'environment',
      'priceId',
      'planId',
      'customerId',
      'paymentIntentId',
      'subscriptionId',
      'invoiceId',
    ] as const) {
      const altered = structuredClone(f.authority);
      Object.assign(altered.source, { [key]: 'wrong' });
      expect(() => normalizeMembershipInvoice(f.offer, f.request, f.paid, altered, now)).toThrow(
        'does not match',
      );
    }
  });
  it('rejects wrong payer, beneficiary, offer, version, period and amount', () => {
    const f = fixture();
    for (const change of [
      { payerAccountId: 'other' },
      { beneficiaryAccountId: 'other' },
      { offerId: 'other' },
      { offerVersion: 2 },
      { periodEnd: start },
    ]) {
      const altered = structuredClone(f.authority);
      Object.assign(altered.invoice.context, change);
      expect(() => normalizeMembershipInvoice(f.offer, f.request, f.paid, altered, now)).toThrow();
    }
    expect(() =>
      normalizeMembershipInvoice(
        f.offer,
        f.request,
        { ...f.paid, amountPaid: '99' },
        f.authority,
        now,
      ),
    ).toThrow();
  });
  it('rejects inconsistent refunds and future observations', () => {
    const f = fixture();
    expect(() =>
      normalizeMembershipInvoice(
        f.offer,
        f.request,
        { ...f.paid, state: 'fully_refunded' },
        f.authority,
        now,
      ),
    ).toThrow('refund');
    expect(() =>
      normalizeMembershipInvoice(
        f.offer,
        f.request,
        { ...f.paid, observedAt: end },
        f.authority,
        now,
      ),
    ).toThrow();
    expect(
      normalizeMembershipInvoice(
        f.offer,
        f.request,
        { ...f.paid, state: 'partially_refunded', amountRefunded: '10' },
        f.authority,
        now,
      ).state,
    ).toBe('partially_refunded');
  });
  it('refuses unconfigured runtime before provider requests or receipt writes', async () => {
    await expect(
      reconcileMembershipInvoice(
        'unknown',
        'unknown',
        { accountId: 'payer', requester: { kind: 'session', token: 'session' } },
        { user: { id: 'payer' }, accessToken: 'session' },
        { subscriptionId: 'sub', invoiceId: 'invoice' },
      ),
    ).rejects.toThrow('not configured');
    expect(host).not.toHaveBeenCalled();
  });
  it('persists concurrently once, prevents rebinding/refund rewind, and never grants access', async () => {
    const f = fixture();
    communities.push(f.offer.communityId);
    await getDb()
      .insert(membershipCommunities)
      .values({
        id: f.offer.communityId,
        ownerOxyUserId: 'membership-billing-owner',
        slug: `billing-${f.offer.communityId}`,
        name: 'Test',
        description: '',
      });
    await getDb().insert(membershipTiers).values({
      id: f.offer.tierId,
      communityId: f.offer.communityId,
      name: 'Draft',
      description: '',
      kind: 'paid',
      status: 'draft',
    });
    const receipt = normalizeMembershipInvoice(f.offer, f.request, f.paid, f.authority, now);
    const inserted = await Promise.all([
      persistMembershipInvoice(receipt),
      persistMembershipInvoice(receipt),
    ]);
    expect(inserted[0]?.id).toBe(inserted[1]?.id);
    await expect(persistMembershipInvoice({ ...receipt, payerOxyUserId: 'other' })).rejects.toThrow(
      'cannot be rebound',
    );
    await persistMembershipInvoice({ ...receipt, state: 'fully_refunded' });
    expect((await persistMembershipInvoice(receipt)).state).toBe('fully_refunded');
    expect(
      await getDb()
        .select()
        .from(communityMemberships)
        .where(eq(communityMemberships.communityId, f.offer.communityId)),
    ).toEqual([]);
    await getDb()
      .delete(membershipCommunities)
      .where(eq(membershipCommunities.id, f.offer.communityId));
    expect(
      await getDb()
        .select()
        .from(membershipBillingReceipts)
        .where(eq(membershipBillingReceipts.communityId, f.offer.communityId)),
    ).toEqual([]);
  });
});
