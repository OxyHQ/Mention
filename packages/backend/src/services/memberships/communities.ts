import type { SafetyRequester } from '@oxy.so/contracts';
import { requireMembershipSafety, membershipSafetyDecisions } from './safety';
import { and, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { MEMBERSHIP_BENEFITS } from '@mention/shared-types';
import type {
  CreateMembershipCommunityRequest,
  CreateMembershipTierRequest,
  MembershipCommunity,
  MembershipLandingResponse,
  MembershipTier,
  CommunityMembership,
} from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import {
  communityMemberships,
  membershipCommunities,
  membershipTierBenefits,
  membershipTiers,
} from '../../db/schema/memberships';
import {
  membershipAuthorizesActingFor,
  type OperatedAccountReader,
  assertCanPublishAsAccount,
} from '../publishAsAccount';
import {
  communityById,
  managesCommunity,
  membershipFor,
  membershipGrantsAccess,
  MembershipError,
  requireManager,
  type CommunityRow,
  type MembershipActor,
  type MembershipRow,
} from './access';

export const communityDto = (row: CommunityRow): MembershipCommunity => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
export const membershipDto = (row: MembershipRow): CommunityMembership => ({
  id: row.id,
  communityId: row.communityId,
  tierId: row.tierId,
  state: row.state,
  publicBadge: row.publicBadge,
  startedAt: row.startedAt.toISOString(),
  accessEndsAt: row.accessEndsAt?.toISOString() ?? null,
  cancelledAt: row.cancelledAt?.toISOString() ?? null,
});
async function tiersFor(
  communityId: string,
  manager: boolean,
  db: DatabaseOrTransaction = getDb(),
): Promise<MembershipTier[]> {
  const rows = await db
    .select()
    .from(membershipTiers)
    .where(
      and(
        eq(membershipTiers.communityId, communityId),
        ...(manager ? [] : [eq(membershipTiers.status, 'active')]),
      ),
    );
  const benefits = await db
    .select({ tierId: membershipTierBenefits.tierId, benefit: membershipTierBenefits.benefit })
    .from(membershipTierBenefits)
    .innerJoin(membershipTiers, eq(membershipTiers.id, membershipTierBenefits.tierId))
    .where(eq(membershipTiers.communityId, communityId));
  return rows.map((row) => ({
    id: row.id,
    communityId: row.communityId,
    name: row.name,
    description: row.description,
    kind: row.kind,
    status: row.status,
    benefits: benefits.filter((b) => b.tierId === row.id).map((b) => b.benefit),
  }));
}
export async function createMembershipCommunity(
  actor: MembershipActor,
  input: CreateMembershipCommunityRequest,
): Promise<MembershipCommunity> {
  await assertCanPublishAsAccount({
    publishAsOxyUserId: input.ownerOxyUserId,
    callerId: actor.accountId,
    memberReader: actor.memberReader,
  });
  await requireMembershipSafety(input.ownerOxyUserId, 'new-community', actor.requester);
  return getDb().transaction(async (tx) => {
    const [community] = await tx
      .insert(membershipCommunities)
      .values({
        ...input,
        description: input.description ?? '',
        visibility: input.visibility ?? 'public',
      })
      .returning();
    const [tier] = await tx
      .insert(membershipTiers)
      .values({
        communityId: community.id,
        name: 'Member',
        description: '',
        kind: 'free',
        status: 'active',
      })
      .returning();
    await tx.insert(membershipTierBenefits).values(
      MEMBERSHIP_BENEFITS.map((benefit) => ({
        tierId: tier.id,
        benefit,
      })),
    );
    return communityDto(community);
  });
}
export async function membershipLanding(
  communityId: string,
  actor?: MembershipActor,
  requester: SafetyRequester = { accessToken: null },
): Promise<MembershipLandingResponse> {
  const community = await communityById(communityId);
  const canManage = await managesCommunity(community, actor);
  if (community.status === 'suspended' || (community.status === 'draft' && !canManage))
    throw new MembershipError(404, 'Community not found');
  await requireMembershipSafety(
    community.ownerOxyUserId,
    community.id,
    actor?.requester ?? requester,
    community.status === 'draft' ? 'private' : 'public',
  );
  const membership = actor ? await membershipFor(communityId, actor.accountId) : undefined;
  const viewerBenefits = canManage
    ? [...MEMBERSHIP_BENEFITS]
    : membership && membershipGrantsAccess(membership)
      ? (
          await getDb()
            .select({ benefit: membershipTierBenefits.benefit })
            .from(membershipTierBenefits)
            .where(eq(membershipTierBenefits.tierId, membership.tierId))
        ).map((row) => row.benefit)
      : [];
  return {
    community: communityDto(community),
    tiers: await tiersFor(communityId, canManage),
    membership: membership ? membershipDto(membership) : null,
    canManage,
    viewerBenefits,
    paidSubscriptionsAvailable: false,
  };
}
export async function updateMembershipCommunity(
  communityId: string,
  actor: MembershipActor,
  patch: Partial<Pick<MembershipCommunity, 'name' | 'description' | 'visibility'>> & {
    status?: 'draft' | 'active' | 'paused' | 'closed';
  },
): Promise<MembershipCommunity> {
  const community = await communityById(communityId);
  await requireManager(community, actor);
  if (community.status === 'suspended') throw new MembershipError(403, 'Community is suspended');
  const [updated] = await getDb()
    .update(membershipCommunities)
    .set({ ...patch, updatedAt: new Date() })
    // PostgreSQL rechecks this predicate after a concurrent moderator's row
    // lock releases; an earlier permission read cannot undo a suspension.
    .where(
      and(eq(membershipCommunities.id, communityId), ne(membershipCommunities.status, 'suspended')),
    )
    .returning();
  if (!updated) throw new MembershipError(403, 'Community is suspended or unavailable');
  return communityDto(updated);
}
export async function createMembershipTier(
  communityId: string,
  actor: MembershipActor,
  input: CreateMembershipTierRequest,
): Promise<MembershipTier> {
  await requireManager(await communityById(communityId), actor);
  return getDb().transaction(async (tx) => {
    const [tier] = await tx
      .insert(membershipTiers)
      .values({
        communityId,
        name: input.name,
        description: input.description ?? '',
        kind: input.kind,
        status: 'draft',
      })
      .returning();
    if (input.benefits.length)
      await tx
        .insert(membershipTierBenefits)
        .values([...new Set(input.benefits)].map((benefit) => ({ tierId: tier.id, benefit })));
    return {
      id: tier.id,
      communityId,
      name: tier.name,
      description: tier.description,
      kind: tier.kind,
      status: tier.status,
      benefits: [...new Set(input.benefits)],
    };
  });
}
export async function updateMembershipTier(
  communityId: string,
  tierId: string,
  actor: MembershipActor,
  patch: Partial<Pick<MembershipTier, 'name' | 'description' | 'status' | 'benefits'>>,
): Promise<void> {
  await requireManager(await communityById(communityId), actor);
  const [tier] = await getDb()
    .select()
    .from(membershipTiers)
    .where(and(eq(membershipTiers.id, tierId), eq(membershipTiers.communityId, communityId)))
    .limit(1);
  if (!tier) throw new MembershipError(404, 'Tier not found');
  if (tier.kind === 'paid' && patch.status === 'active')
    throw new MembershipError(
      409,
      'Paid subscriptions require approved commercial terms and billing configuration',
    );
  await getDb().transaction(async (tx) => {
    const { benefits, ...fields } = patch;
    await tx
      .update(membershipTiers)
      .set({ ...fields, updatedAt: new Date() })
      .where(eq(membershipTiers.id, tierId));
    if (benefits) {
      await tx.delete(membershipTierBenefits).where(eq(membershipTierBenefits.tierId, tierId));
      await tx
        .insert(membershipTierBenefits)
        .values([...new Set(benefits)].map((benefit) => ({ tierId, benefit })));
    }
  });
}
export async function joinFreeMembership(
  communityId: string,
  actor: MembershipActor,
  tierId: string,
): Promise<CommunityMembership> {
  return getDb().transaction(async (tx) => {
    // Serialize joins with community lifecycle changes and member moderation.
    const [community] = await tx
      .select()
      .from(membershipCommunities)
      .where(eq(membershipCommunities.id, communityId))
      .for('update');
    if (!community) throw new MembershipError(404, 'Community not found');
    await requireMembershipSafety(community.ownerOxyUserId, community.id, actor.requester);
    if (community.status !== 'active')
      throw new MembershipError(409, 'Community is not accepting memberships');
    const [tier] = await tx
      .select()
      .from(membershipTiers)
      .where(
        and(
          eq(membershipTiers.id, tierId),
          eq(membershipTiers.communityId, communityId),
          eq(membershipTiers.kind, 'free'),
          eq(membershipTiers.status, 'active'),
        ),
      )
      .limit(1);
    if (!tier) throw new MembershipError(409, 'An active free tier is required');
    const existing = await membershipFor(communityId, actor.accountId, tx);
    if (existing?.state === 'revoked')
      throw new MembershipError(403, 'Membership has been revoked');
    const now = new Date();
    const [membership] = await tx
      .insert(communityMemberships)
      .values({ communityId, memberOxyUserId: actor.accountId, tierId, state: 'active' })
      .onConflictDoUpdate({
        target: [communityMemberships.communityId, communityMemberships.memberOxyUserId],
        set: {
          tierId,
          state: 'active',
          accessEndsAt: null,
          cancelledAt: null,
          startedAt: existing?.state === 'active' ? existing.startedAt : now,
          updatedAt: now,
        },
      })
      .returning();
    return membershipDto(membership);
  });
}
export async function leaveMembership(communityId: string, actor: MembershipActor): Promise<void> {
  await getDb()
    .update(communityMemberships)
    .set({
      state: 'cancelled',
      publicBadge: false,
      accessEndsAt: new Date(),
      cancelledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(communityMemberships.communityId, communityId),
        eq(communityMemberships.memberOxyUserId, actor.accountId),
        ne(communityMemberships.state, 'revoked'),
      ),
    );
}
export async function setMembershipBadge(
  communityId: string,
  actor: MembershipActor,
  publicBadge: boolean,
): Promise<void> {
  const membership = await membershipFor(communityId, actor.accountId);
  if (!membership) throw new MembershipError(404, 'Membership not found');
  await getDb()
    .update(communityMemberships)
    .set({ publicBadge, updatedAt: new Date() })
    .where(eq(communityMemberships.id, membership.id));
}
export async function revokeMembership(
  communityId: string,
  actor: MembershipActor,
  memberOxyUserId: string,
): Promise<void> {
  await requireManager(await communityById(communityId), actor);
  await getDb().transaction(async (tx) => {
    await tx
      .select({ id: membershipCommunities.id })
      .from(membershipCommunities)
      .where(eq(membershipCommunities.id, communityId))
      .for('update');
    await tx
      .update(communityMemberships)
      .set({
        state: 'revoked',
        publicBadge: false,
        accessEndsAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(communityMemberships.communityId, communityId),
          eq(communityMemberships.memberOxyUserId, memberOxyUserId),
        ),
      );
  });
}
export async function membershipInsights(communityId: string, actor: MembershipActor) {
  await requireManager(await communityById(communityId), actor);
  const states = await getDb()
    .select({ state: communityMemberships.state, total: count() })
    .from(communityMemberships)
    .where(eq(communityMemberships.communityId, communityId))
    .groupBy(communityMemberships.state);
  return { membershipsByState: states, paidSubscriptionsAvailable: false as const };
}
export async function membershipDirectory(
  communityId: string,
  requester: SafetyRequester = { accessToken: null },
) {
  const community = await communityById(communityId);
  if (community.status !== 'active' && community.status !== 'paused')
    throw new MembershipError(404, 'Community not found');
  await requireMembershipSafety(community.ownerOxyUserId, community.id, requester, 'public');
  const rows = await getDb()
    .select({ oxyUserId: communityMemberships.memberOxyUserId })
    .from(communityMemberships)
    .where(
      and(
        eq(communityMemberships.communityId, communityId),
        eq(communityMemberships.publicBadge, true),
        eq(communityMemberships.state, 'active'),
        sql`(${communityMemberships.accessEndsAt} is null or ${communityMemberships.accessEndsAt} > now())`,
      ),
    )
    .orderBy(communityMemberships.memberOxyUserId)
    .limit(100);
  const allowed = await membershipSafetyDecisions(
    rows.map((row) => ({ id: `member:${row.oxyUserId}`, authorOxyUserId: row.oxyUserId })),
    requester,
  );
  return rows.filter((row) => allowed.has(`member:${row.oxyUserId}`));
}

export async function listMyMembershipCommunities(
  actor: MembershipActor,
  reader?: OperatedAccountReader,
) {
  const accountId = actor.accountId;
  const accounts = reader ? await reader.accounts.list() : [];
  const ownerIds = [
    ...new Set([
      accountId,
      ...accounts
        .filter(
          (account) =>
            ['organization', 'project', 'channel'].includes(account.kind) &&
            membershipAuthorizesActingFor(account.kind, account.callerMembership),
        )
        .map((account) => account.accountId),
    ]),
  ];
  const owned = await getDb()
    .select()
    .from(membershipCommunities)
    .where(inArray(membershipCommunities.ownerOxyUserId, ownerIds))
    .orderBy(desc(membershipCommunities.createdAt))
    .limit(100);
  const joined = await getDb()
    .select({ community: membershipCommunities })
    .from(communityMemberships)
    .innerJoin(
      membershipCommunities,
      eq(membershipCommunities.id, communityMemberships.communityId),
    )
    .where(
      and(
        eq(communityMemberships.memberOxyUserId, accountId),
        eq(communityMemberships.state, 'active'),
      ),
    )
    .orderBy(desc(communityMemberships.startedAt))
    .limit(100);
  const communities = [...owned, ...joined.map((row) => row.community)];
  const safe = await membershipSafetyDecisions(
    communities.map((row) => ({ id: row.id, authorOxyUserId: row.ownerOxyUserId })),
    actor.requester,
  );
  return {
    owned: owned.filter((row) => safe.has(row.id)).map(communityDto),
    joined: joined
      .filter(
        (row) => safe.has(row.community.id) && ['active', 'paused'].includes(row.community.status),
      )
      .map((row) => communityDto(row.community)),
  };
}
