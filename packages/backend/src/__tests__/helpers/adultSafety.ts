import { vi } from 'vitest';
import type {
  ContentAccessInput,
  ContentAccessBatchInput,
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
