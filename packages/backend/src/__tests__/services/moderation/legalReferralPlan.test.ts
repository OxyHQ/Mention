// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { describe, expect, it } from 'vitest';
import type { Decision } from '@crowdsource.you/contracts';
import { planEnforcement } from '../../../services/moderation/enforcementPlan';
import { allegationsForCategories } from '../../../services/moderation/reportTaxonomy';

/**
 * A `legal_queue` recommendation is a referral to Oxy's claim review (oxy ADR
 * 0043 D14), not a note for a human nobody has. And a reporter's "child safety"
 * is an allegation CrowdSource routes to its legal pool, never to a jury.
 */

function decision(overrides: Partial<Decision>): Decision {
  return {
    id: 'decision_1',
    revision: 1,
    outcome: 'escalated',
    findings: [],
    recommendedActions: [],
    ...overrides,
  } as Decision;
}

describe('planEnforcement and the legal queue', () => {
  it('plans a referral for legal_queue, beside whatever else was recommended', () => {
    const plan = planEnforcement(
      decision({
        recommendedActions: [
          { action: 'legal_queue' },
          { action: 'suspend_user' },
        ] as Decision['recommendedActions'],
      }),
    );
    expect(plan.map((entry) => entry.action).sort()).toEqual(['legal_referral', 'manual_review']);
    expect(plan.find((entry) => entry.action === 'legal_referral')?.recommendedAction).toBe(
      'legal_queue',
    );
  });

  it('keeps the referral when the decision also removes the post', () => {
    const plan = planEnforcement(
      decision({
        outcome: 'violation',
        recommendedActions: [
          { action: 'remove' },
          { action: 'legal_queue' },
        ] as Decision['recommendedActions'],
      }),
    );
    expect(plan.map((entry) => entry.action).sort()).toEqual(['legal_referral', 'restrict']);
  });

  it('does not refer an escalation that recommended nothing', () => {
    expect(planEnforcement(decision({})).map((entry) => entry.action)).toEqual(['manual_review']);
  });
});

describe('the child_safety report category', () => {
  it('alleges exploitation, the family CrowdSource never shows a jury', () => {
    expect(allegationsForCategories(['child_safety'])).toEqual(['child_safety.exploitation']);
  });
});
