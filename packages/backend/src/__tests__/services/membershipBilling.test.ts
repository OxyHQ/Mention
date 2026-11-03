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
const unix = (iso: string) => Date.parse(iso) / 1000;
const start = unix('2026-10-01T00:00:00Z');
const end = unix('2026-11-01T00:00:00Z');
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
    invoice_id: request.invoiceId,
    line_id: 'line',
    payment_intent_id: 'payment',
    provider_subscription_id: request.subscriptionId,
    provider_customer_id: 'customer',
    provider_price_id: offer.providerPriceId,
    store_id: request.payerAccountId,
    plan_id: offer.planId,
    livemode: false,
    currency: 'EUR',
    amount_paid: '100',
    net_amount: '80',
    tax_amount: '20',
    period_start: start,
    period_end: end,
    paid_at: start,
    observed_at: now.getTime() / 1000,
    charge_id: 'charge',
    amount_refunded: '0',
    state: 'paid',
  };
  const authority: Parameters<typeof normalizeMembershipInvoice>[3] = {
    schema_version: 2,
    source: {
      invoice_id: request.invoiceId,
      payment_intent_id: paid.payment_intent_id,
      customer_id: paid.provider_customer_id,
      subscription_id: request.subscriptionId,
      price_id: offer.providerPriceId,
      plan_id: offer.planId,
      merchant_id: offer.merchantId,
      app_id: offer.appId,
      mode: offer.mode,
      environment: offer.environment,
    },
    invoice: {
      platform: 'peable',
      currency: 'EUR',
      gross_minor_units: 100,
      net_minor_units: 80,
      tax_minor_units: 20,
      merchant_fee_minor_units: 0,
      tax_treatment: 'inclusive',
      seller_id: 'seller',
      invoice_issuer_id: 'issuer',
      tax_quote_id: 'taxquote',
      customer_location_evidence_id: 'location',
      tax_rate_evidence_id: 'rate',
      context: {
        payer_account_id: request.payerAccountId,
        beneficiary_account_id: request.payerAccountId,
        provider_subscription_id: request.subscriptionId,
        offer_id: offer.offerId,
        offer_version: offer.offerVersion,
        period_start: start,
        period_end: end,
        mode: offer.mode,
        environment: offer.environment,
      },
      issued_at: start,
      expires_at: end,
    },
    method: 'card',
    signature: {
      algorithm: 'Ed25519',
      key_id: 'synthetic',
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
      'merchant_id',
      'app_id',
      'mode',
      'environment',
      'price_id',
      'plan_id',
      'customer_id',
      'payment_intent_id',
      'subscription_id',
      'invoice_id',
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
      { payer_account_id: 'other' },
      { beneficiary_account_id: 'other' },
      { offer_id: 'other' },
      { offer_version: 2 },
      { period_end: start },
    ]) {
      const altered = structuredClone(f.authority);
      Object.assign(altered.invoice.context, change);
      expect(() => normalizeMembershipInvoice(f.offer, f.request, f.paid, altered, now)).toThrow();
    }
    expect(() =>
      normalizeMembershipInvoice(
        f.offer,
        f.request,
        { ...f.paid, amount_paid: '99' },
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
        { ...f.paid, observed_at: end },
        f.authority,
        now,
      ),
    ).toThrow();
    // Instants are integer Unix seconds; milliseconds or fractions are not a Peable instant.
    for (const paid_at of [start * 1000, start + 0.5])
      expect(() =>
        normalizeMembershipInvoice(f.offer, f.request, { ...f.paid, paid_at }, f.authority, now),
      ).toThrow('does not match');
    expect(
      normalizeMembershipInvoice(
        f.offer,
        f.request,
        { ...f.paid, state: 'partially_refunded', amount_refunded: '10' },
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
