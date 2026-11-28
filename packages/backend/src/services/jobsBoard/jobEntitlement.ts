// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * The Phase D publish gate. Mention stores no payment/plan state of its own —
 * billing lives entirely in Oxy (the oxy repo, Stripe-backed), the same
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
 * `__tests__/services/jobsBoard/jobEntitlement.test.ts` for the standing proof.
 */

import type { MentionJobEntitlement } from '@mention/shared-types';

/**
 * Whether `employerOxyUserId` may publish a job right now. Never throws —
 * an entitlement check is a presentation-layer gate a route can act on, not an
 * access-control refusal; `services/jobsBoard/jobAuthority.ts` is what actually protects
 * a job's mutation.
 */
export async function checkJobEntitlement(
  employerOxyUserId: string,
): Promise<MentionJobEntitlement> {
  void employerOxyUserId;
  return { canPublish: true };
}
