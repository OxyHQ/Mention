/**
 * The Phase D publish gate. Mention stores no payment/plan state of its own —
 * billing lives entirely in Oxy (`~/Oxy/OxyHQServices`, Stripe-backed), the same
 * `/billing/accounts/:id/entitlements` boundary Alia reads its own plan
 * entitlements through. This module is the seam a real paid tier plugs into.
 *
 * Defaults to `canPublish: true` for every eligible employer: issue #952 lists
 * "per-listing price vs. organization subscription vs. both" as an explicit
 * OPEN DECISION, so hard-coding a paid gate here would invent a pricing model
 * nobody has chosen. What Phase D actually guarantees is the INVARIANT this
 * module's shape enforces structurally: `MentionJobEntitlement` carries only a
 * boolean and a reason, so there is no commercial field (plan tier, amount
 * paid, revenue) for a ranking or feed code path to accidentally read — see
 * `__tests__/services/jobEntitlement.test.ts` for the standing proof.
 */

import type { MentionJobEntitlement } from '@mention/shared-types';

/**
 * Whether `employerOxyUserId` may publish a job right now. Never throws —
 * an entitlement check is a presentation-layer gate a route can act on, not an
 * access-control refusal; `services/jobAuthority.ts` is what actually protects
 * a job's mutation.
 */
export async function checkJobEntitlement(
  employerOxyUserId: string,
): Promise<MentionJobEntitlement> {
  void employerOxyUserId;
  return { canPublish: true };
}
