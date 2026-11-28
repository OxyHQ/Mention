// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { vi } from 'vitest';
import type {
  ContentAccessInput,
  ContentAccessBatchInput,
  NotificationAccessBatchInput,
  ProfileAccessBatchInput,
  PublicationPoliciesInput,
  SafetyDecision,
} from '@oxy.so/contracts';

/** Explicit adult authority fixture. Security suites supply their own live decision scenarios. */
export function adultSafetyFixture() {
  const publication = {
    publicationAllowed: true,
    requiredAudience: null,
    collaborationAllowed: true,
    federationAllowed: true,
    policyVersion: '2',
  } as const;
  const decision = (input: ContentAccessInput): SafetyDecision => ({
    allowed: input.applicationAudienceAllowed !== false,
    reason: input.applicationAudienceAllowed === false ? 'private' : 'allowed',
    policyVersion: '2',
  });
  return {
    profileAccess: vi.fn(async () => ({
      allowed: true,
      reason: 'public' as const,
      policyVersion: '2' as const,
    })),
    profileAccessBatch: vi.fn(async (input: ProfileAccessBatchInput) => ({
      items: input.subjectAccountIds.map((subjectAccountId) => ({
        subjectAccountId,
        decision: { allowed: true, reason: 'public', policyVersion: '2' } as SafetyDecision,
      })),
    })),
    notificationAccessBatch: vi.fn(async (input: NotificationAccessBatchInput) => ({
      items: input.items.map((item) => ({
        resourceId: item.resourceId,
        decision: { allowed: true, reason: 'allowed', policyVersion: '2' } as SafetyDecision,
      })),
    })),
    publicationPolicy: vi.fn(async () => publication),
    publicationPolicies: vi.fn(async (input: PublicationPoliciesInput) => ({
      items: input.authorAccountIds.map((authorAccountId) => ({
        authorAccountId,
        policy: publication,
      })),
    })),
    contentAccess: vi.fn(async (input: ContentAccessInput) => decision(input)),
    contentAccessBatch: vi.fn(async (input: ContentAccessBatchInput) => ({
      items: input.items.map((item) => ({ resourceId: item.resourceId, decision: decision(item) })),
    })),
  };
}
