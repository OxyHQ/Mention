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
type Evidence = Parameters<typeof normalizeMembershipInvoice>[2];
function fixture() {
  const offer: MembershipBillingOffer = {
    communityId: randomUUID(),
    tierId: randomUUID(),
    offerId: 'synthetic-offer',
    offerVersion: 1,
    merchantId: 'merch_synthetic',
    appId: 'mention-test',
    mode: 'test',
    environment: 'development',
    providerPriceId: 'price_synthetic',
  };
  const request = {
    payerAccountId: 'membership-billing-test-payer',
    subscriptionId: 'sub_synthetic',
    invoiceId: `in_${randomUUID()}`,
  };
  const price = { id: offer.providerPriceId, object: 'price' };
  const evidence = {
    merchant: { id: offer.merchantId, oxy_app_id: offer.appId, environment: offer.environment },
    invoice: {
      id: request.invoiceId,
      object: 'invoice',
      livemode: false,
      customer: 'cus_synthetic',
      subscription: request.subscriptionId,
      status: 'paid',
      currency: 'EUR',
      lines: {
        object: 'list',
        has_more: false,
        url: '/v1/invoices/lines',
        data: [
          {
            id: 'il_synthetic',
            object: 'line_item',
            livemode: false,
            type: 'subscription',
            amount: '100',
            period: { start, end },
            price,
            quantity: 1,
            proration: false,
            subscription: request.subscriptionId,
          },
        ],
      },
      tax: '20',
      total: '100',
      amount_paid: '100',
      paid_out_of_band: false,
      payment_intent: 'pi_synthetic',
      status_transitions: {
        finalized_at: start,
        paid_at: start,
        voided_at: null,
        marked_uncollectible_at: null,
      },
    },
    subscription: {
      id: request.subscriptionId,
      object: 'subscription',
      livemode: false,
      customer: 'cus_synthetic',
      items: {
        object: 'list',
        has_more: false,
        url: '/v1/subscription_items',
        data: [{ id: 'si_synthetic', price, quantity: 1 }],
      },
      metadata: {
        payer_account_id: request.payerAccountId,
        community_id: offer.communityId,
        tier_id: offer.tierId,
        offer_id: offer.offerId,
        offer_version: '1',
      },
    },
    paymentIntent: {
      id: 'pi_synthetic',
      object: 'payment_intent',
      livemode: false,
      customer: 'cus_synthetic',
      status: 'succeeded',
      currency: 'EUR',
      amount_received: '100',
      amount_refunded: '0',
    },
  } as unknown as Evidence;
  return { offer, request, evidence };
}
/** A deep copy with one change applied, for the refusal tables. */
function altered(evidence: Evidence, change: (copy: Evidence) => void): Evidence {
  const copy = structuredClone(evidence);
  change(copy);
  return copy;
}
const communities: string[] = [];
beforeAll(connectPostgres);
afterAll(async () => {
  for (const id of communities)
    await getDb().delete(membershipCommunities).where(eq(membershipCommunities.id, id));
  await closePostgres();
});

describe('membership invoice normalization (native Peable objects)', () => {
  it('normalizes an invoice bound to the reviewed offer, payer and tier', () => {
    const f = fixture();
    expect(normalizeMembershipInvoice(f.offer, f.request, f.evidence, now)).toMatchObject({
      payerOxyUserId: f.request.payerAccountId,
      providerCustomerId: 'cus_synthetic',
      paymentIntentId: 'pi_synthetic',
      periodStart: new Date(start * 1000),
      periodEnd: new Date(end * 1000),
      state: 'paid',
      tierId: f.offer.tierId,
    });
  });
  it('rejects every scope, binding and amount that differs', () => {
    const f = fixture();
    const changes: Array<(e: Evidence) => void> = [
      (e) => Object.assign(e.merchant, { id: 'merch_other' }),
      (e) => Object.assign(e.merchant, { oxy_app_id: 'other' }),
      (e) => Object.assign(e.merchant, { environment: 'production' }),
      (e) => Object.assign(e.invoice, { id: 'in_other' }),
      (e) => Object.assign(e.invoice, { subscription: 'sub_other' }),
      (e) => Object.assign(e.invoice, { livemode: true }),
      (e) => Object.assign(e.subscription, { customer: 'cus_other' }),
      (e) => Object.assign(e.paymentIntent, { customer: 'cus_other' }),
      (e) => Object.assign(e.invoice, { payment_intent: 'pi_other' }),
      (e) => Object.assign(e.subscription.metadata, { payer_account_id: 'other' }),
      (e) => Object.assign(e.subscription.metadata, { community_id: 'other' }),
      (e) => Object.assign(e.subscription.metadata, { tier_id: 'other' }),
      (e) => Object.assign(e.subscription.metadata, { offer_id: 'other' }),
      (e) => Object.assign(e.subscription.metadata, { offer_version: '2' }),
      (e) => {
        e.subscription.metadata = {};
      },
      (e) => Object.assign(e.subscription.items.data[0]?.price ?? {}, { id: 'price_other' }),
      (e) => Object.assign(e.subscription.items.data[0] ?? {}, { quantity: 2 }),
      (e) => Object.assign(e.invoice.lines.data[0] ?? {}, { proration: true }),
      (e) => Object.assign(e.invoice.lines.data[0] ?? {}, { period: { start: end, end: start } }),
      (e) => e.invoice.lines.data.push(structuredClone(e.invoice.lines.data[0] as never)),
      (e) => Object.assign(e.invoice, { status: 'open' }),
      (e) => Object.assign(e.invoice, { paid_out_of_band: true }),
      (e) => Object.assign(e.invoice, { amount_paid: '99' }),
      (e) => Object.assign(e.invoice, { tax: null }),
      (e) => Object.assign(e.paymentIntent, { status: 'processing' }),
      (e) => Object.assign(e.paymentIntent, { amount_received: '99' }),
      (e) => Object.assign(e.paymentIntent, { currency: 'USD' }),
    ];
    for (const change of changes)
      expect(() =>
        normalizeMembershipInvoice(f.offer, f.request, altered(f.evidence, change), now),
      ).toThrow('does not match');
  });
  it('derives refund state from the PaymentIntent and refuses future or non-second instants', () => {
    const f = fixture();
    const refunded = (amount: string) =>
      altered(f.evidence, (e) => Object.assign(e.paymentIntent, { amount_refunded: amount }));
    expect(normalizeMembershipInvoice(f.offer, f.request, refunded('10'), now).state).toBe(
      'partially_refunded',
    );
    expect(normalizeMembershipInvoice(f.offer, f.request, refunded('100'), now).state).toBe(
      'fully_refunded',
    );
    expect(() => normalizeMembershipInvoice(f.offer, f.request, refunded('101'), now)).toThrow(
      'refund',
    );
    // Instants are integer Unix seconds; milliseconds, fractions or the future are not.
    for (const paid_at of [start * 1000, start + 0.5, end])
      expect(() =>
        normalizeMembershipInvoice(
          f.offer,
          f.request,
          altered(f.evidence, (e) => Object.assign(e.invoice.status_transitions, { paid_at })),
          now,
        ),
      ).toThrow('does not match');
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
    const receipt = normalizeMembershipInvoice(f.offer, f.request, f.evidence, now);
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
