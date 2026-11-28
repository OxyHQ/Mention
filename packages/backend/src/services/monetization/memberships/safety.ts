// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { SafetyRequester } from '@oxy.so/contracts';
import { decideContentAccess } from '../../moderation/contentAccessBatcher';
import { erasedAccountIds } from '../../accounts/accountErasure/erasedAccounts';
import { MembershipError } from './errors';

/** Explicit resource visibility/entitlement supplies the app grant, never a profile follow. */
export async function membershipSafetyDecisions(
  resources: readonly { id: string; authorOxyUserId: string; audience?: 'public' | 'private' }[],
  requester: SafetyRequester,
) {
  const decisions = await decideContentAccess(
    resources.map((resource) => ({
      resourceId: `mention:membership:${resource.id}`,
      authorAccountId: resource.authorOxyUserId,
      classification: 'unrated' as const,
      audience: resource.audience ?? 'private',
      applicationAudienceAllowed: true,
      applicationResourceGrant: true,
    })),
    requester,
  );
  const authors = [...new Set(resources.map((resource) => resource.authorOxyUserId))];
  const erased = await erasedAccountIds(authors);
  return new Set(
    resources
      .filter(
        (resource) =>
          !erased.has(resource.authorOxyUserId) &&
          decisions.get(`mention:membership:${resource.id}`)?.allowed === true,
      )
      .map((resource) => resource.id),
  );
}
export async function requireMembershipSafety(
  authorOxyUserId: string,
  resourceId: string,
  requester: SafetyRequester,
  audience: 'public' | 'private' = 'private',
): Promise<void> {
  try {
    if (
      !(
        await membershipSafetyDecisions([{ id: resourceId, authorOxyUserId, audience }], requester)
      ).has(resourceId)
    )
      throw new MembershipError(404, 'Resource unavailable');
  } catch (error) {
    if (error instanceof MembershipError) throw error;
    throw new MembershipError(503, 'Account safety permissions are temporarily unavailable');
  }
}
