import { MembershipError } from './errors';
export { MembershipError } from './errors';
import { and, eq } from 'drizzle-orm';
import type { SafetyRequester } from '@oxy.so/contracts';
import { requireMembershipSafety } from './safety';
import type { MembershipBenefit } from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import {
  communityMemberships,
  membershipCommunities,
  membershipTierBenefits,
} from '../../db/schema/memberships';
import {
  assertCanPublishAsAccount,
  PublishAsAccessError,
  type AccountMemberReader,
} from '../publishAsAccount';

export interface MembershipActor {
  accountId: string;
  requester: SafetyRequester;
  memberReader?: AccountMemberReader;
}
export type CommunityRow = typeof membershipCommunities.$inferSelect;
export type MembershipRow = typeof communityMemberships.$inferSelect;
export async function communityById(
  id: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<CommunityRow> {
  const [community] = await db
    .select()
    .from(membershipCommunities)
    .where(eq(membershipCommunities.id, id))
    .limit(1);
  if (!community) throw new MembershipError(404, 'Community not found');
  return community;
}
export async function managesCommunity(
  community: CommunityRow,
  actor?: MembershipActor,
): Promise<boolean> {
  if (!actor) return false;
  try {
    await assertCanPublishAsAccount({
      publishAsOxyUserId: community.ownerOxyUserId,
      callerId: actor.accountId,
      memberReader: actor.memberReader,
    });
    return true;
  } catch (error) {
    if (error instanceof PublishAsAccessError) return false;
    throw error;
  }
}
export async function requireManager(
  community: CommunityRow,
  actor: MembershipActor,
): Promise<void> {
  if (!(await managesCommunity(community, actor)))
    throw new MembershipError(403, 'Community management permission required');
  await requireMembershipSafety(community.ownerOxyUserId, community.id, actor.requester);
}
/** No cache: revocation/expiry is re-evaluated at every content/media request. */
export function membershipGrantsAccess(membership: MembershipRow, now = new Date()): boolean {
  if (
    membership.state === 'refunded' ||
    membership.state === 'revoked' ||
    membership.state === 'expired'
  )
    return false;
  if (membership.state === 'active')
    return membership.accessEndsAt === null || membership.accessEndsAt > now;
  return membership.accessEndsAt !== null && membership.accessEndsAt > now;
}
export async function membershipFor(
  communityId: string,
  accountId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<MembershipRow | undefined> {
  const [membership] = await db
    .select()
    .from(communityMemberships)
    .where(
      and(
        eq(communityMemberships.communityId, communityId),
        eq(communityMemberships.memberOxyUserId, accountId),
      ),
    )
    .limit(1);
  return membership;
}
export interface MembershipAccess {
  manager: boolean;
  membership?: MembershipRow;
}
export async function requireCommunityBenefit(
  community: CommunityRow,
  actor: MembershipActor,
  benefit: MembershipBenefit,
  db: DatabaseOrTransaction = getDb(),
): Promise<MembershipAccess> {
  if (community.status === 'suspended' || community.status === 'closed')
    throw new MembershipError(403, 'Community is unavailable');
  const manager = await managesCommunity(community, actor);
  if (manager) {
    await requireMembershipSafety(community.ownerOxyUserId, community.id, actor.requester);
    return { manager: true };
  }
  if (community.status === 'draft') throw new MembershipError(404, 'Community not found');
  const membership = await membershipFor(community.id, actor.accountId, db);
  if (!membership || !membershipGrantsAccess(membership))
    throw new MembershipError(403, 'Active membership required');
  const [grant] = await db
    .select({ benefit: membershipTierBenefits.benefit })
    .from(membershipTierBenefits)
    .where(
      and(
        eq(membershipTierBenefits.tierId, membership.tierId),
        eq(membershipTierBenefits.benefit, benefit),
      ),
    )
    .limit(1);
  if (!grant) throw new MembershipError(403, 'Membership does not include this benefit');
  await requireMembershipSafety(community.ownerOxyUserId, community.id, actor.requester);
  return { manager: false, membership };
}
