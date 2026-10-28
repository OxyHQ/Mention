import type { SafetyRequester } from '@oxy.so/contracts';
import { requireMembershipSafety, membershipSafetyDecisions } from './safety';
import { and, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { qualified } from '@oxy.so/db';
import type {
  CreateMembershipContentRequest,
  MembershipContent,
  MembershipContentTeaser,
} from '@mention/shared-types';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import {
  membershipContents,
  membershipContentTiers,
  membershipMedia,
  membershipPollOptions,
  membershipPollVotes,
  membershipReports,
  membershipTiers,
} from '../../db/schema/memberships';
import {
  communityById,
  MembershipError,
  requireCommunityBenefit,
  requireManager,
  type MembershipAccess,
  type MembershipActor,
} from './access';

type ContentRow = typeof membershipContents.$inferSelect;
async function requiredTiers(
  contentId: string,
  db: DatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ tierId: membershipContentTiers.tierId })
    .from(membershipContentTiers)
    .where(eq(membershipContentTiers.contentId, contentId));
  return rows.map((row) => row.tierId);
}
function requireTier(access: MembershipAccess, tierIds: string[]): void {
  if (
    !access.manager &&
    tierIds.length &&
    (!access.membership || !tierIds.includes(access.membership.tierId))
  )
    throw new MembershipError(403, 'This content requires another membership tier');
}
export async function readableMembershipContent(
  contentId: string,
  actor: MembershipActor,
  db: DatabaseOrTransaction = getDb(),
): Promise<{ row: ContentRow; tierIds: string[]; access: MembershipAccess }> {
  // Resolve only identity/ACL metadata before asking for the protected row.
  const [identity] = await db
    .select({
      communityId: membershipContents.communityId,
      authorOxyUserId: membershipContents.authorOxyUserId,
    })
    .from(membershipContents)
    .where(and(eq(membershipContents.id, contentId), isNull(membershipContents.removedAt)))
    .limit(1);
  if (!identity) throw new MembershipError(404, 'Content not found');
  const community = await communityById(identity.communityId, db);
  const access = await requireCommunityBenefit(community, actor, 'content_read', db);
  const tierIds = await requiredTiers(contentId, db);
  requireTier(access, tierIds);
  await requireMembershipSafety(identity.authorOxyUserId, contentId, actor.requester);
  const [row] = await db
    .select()
    .from(membershipContents)
    .where(and(eq(membershipContents.id, contentId), isNull(membershipContents.removedAt)))
    .limit(1);
  if (!row) throw new MembershipError(404, 'Content not found');
  return { row, tierIds, access };
}
/** Batch hydration keeps a page independent of its row count; viewer votes stay request-local. */
async function hydrateMembershipContent(
  rows: ContentRow[],
  actor: MembershipActor,
): Promise<MembershipContent[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const pollIds = rows.filter((row) => row.kind === 'poll').map((row) => row.id);
  const [tiers, media, options, votes] = await Promise.all([
    getDb()
      .select()
      .from(membershipContentTiers)
      .where(inArray(membershipContentTiers.contentId, ids)),
    getDb()
      .select({
        id: membershipMedia.id,
        contentId: membershipMedia.contentId,
        mime: membershipMedia.mime,
        size: membershipMedia.size,
      })
      .from(membershipMedia)
      .where(inArray(membershipMedia.contentId, ids)),
    pollIds.length
      ? getDb()
          .select({
            id: membershipPollOptions.id,
            contentId: membershipPollOptions.contentId,
            text: membershipPollOptions.text,
            votes: count(membershipPollVotes.id),
          })
          .from(membershipPollOptions)
          .leftJoin(membershipPollVotes, eq(membershipPollVotes.optionId, membershipPollOptions.id))
          .where(inArray(membershipPollOptions.contentId, pollIds))
          .groupBy(membershipPollOptions.id)
          .orderBy(membershipPollOptions.position)
      : Promise.resolve([]),
    pollIds.length
      ? getDb()
          .select({
            contentId: membershipPollVotes.contentId,
            optionId: membershipPollVotes.optionId,
          })
          .from(membershipPollVotes)
          .where(
            and(
              inArray(membershipPollVotes.contentId, pollIds),
              eq(membershipPollVotes.voterOxyUserId, actor.accountId),
            ),
          )
      : Promise.resolve([]),
  ]);
  return rows.map((row) => ({
    id: row.id,
    communityId: row.communityId,
    authorOxyUserId: row.authorOxyUserId,
    kind: row.kind,
    teaser: row.teaser,
    createdAt: row.createdAt.toISOString(),
    requiredTierIds: tiers.filter((t) => t.contentId === row.id).map((t) => t.tierId),
    title: row.title,
    body: row.body,
    parentContentId: row.parentContentId,
    media: media
      .filter((m) => m.contentId === row.id)
      .map(({ id, mime, size }) => ({ id, mime, size })),
    poll:
      row.kind === 'poll' && row.pollEndsAt
        ? {
            endsAt: row.pollEndsAt.toISOString(),
            options: options
              .filter((o) => o.contentId === row.id)
              .map(({ id, text, votes }) => ({ id, text, votes })),
            selectedOptionId: votes.find((v) => v.contentId === row.id)?.optionId ?? null,
          }
        : null,
  }));
}
export async function readMembershipContent(
  contentId: string,
  actor: MembershipActor,
): Promise<MembershipContent> {
  const { row } = await readableMembershipContent(contentId, actor);
  const [content] = await hydrateMembershipContent([row], actor);
  return content;
}
export async function membershipContentTeaser(
  contentId: string,
  requester: SafetyRequester = { accessToken: null },
): Promise<MembershipContentTeaser> {
  const [row] = await getDb()
    .select({
      id: membershipContents.id,
      communityId: membershipContents.communityId,
      authorOxyUserId: membershipContents.authorOxyUserId,
      kind: membershipContents.kind,
      teaser: membershipContents.teaser,
      createdAt: membershipContents.createdAt,
    })
    .from(membershipContents)
    .where(
      and(
        eq(membershipContents.id, contentId),
        isNull(membershipContents.removedAt),
        isNull(membershipContents.parentContentId),
      ),
    )
    .limit(1);
  if (!row || row.teaser === null) throw new MembershipError(404, 'Teaser not found');
  const community = await communityById(row.communityId);
  if (community.status !== 'active' && community.status !== 'paused')
    throw new MembershipError(404, 'Teaser not found');
  await requireMembershipSafety(community.ownerOxyUserId, community.id, requester, 'public');
  await requireMembershipSafety(row.authorOxyUserId, row.id, requester, 'public');
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    requiredTierIds: await requiredTiers(contentId),
  };
}
export async function createMembershipContent(
  communityId: string,
  actor: MembershipActor,
  input: CreateMembershipContentRequest,
): Promise<MembershipContent> {
  const community = await communityById(communityId);
  const access = await requireCommunityBenefit(community, actor, 'discussion_write');
  if (!access.manager && input.kind !== 'discussion')
    throw new MembershipError(403, 'Only community operators publish posts, articles and polls');
  if (!access.manager && input.teaser)
    throw new MembershipError(403, 'Only community operators publish public teasers');
  let tierIds = [...new Set(input.requiredTierIds ?? [])];
  if (input.parentContentId) {
    const parent = await readableMembershipContent(input.parentContentId, actor);
    if (parent.row.communityId !== communityId)
      throw new MembershipError(400, 'Parent belongs to another community');
    // A reply inherits its parent's policy; it cannot downgrade a restricted thread.
    tierIds = parent.tierIds;
  }
  if (tierIds.length) {
    const tiers = await getDb()
      .select({ id: membershipTiers.id })
      .from(membershipTiers)
      .where(
        and(eq(membershipTiers.communityId, communityId), inArray(membershipTiers.id, tierIds)),
      );
    if (tiers.length !== tierIds.length)
      throw new MembershipError(400, 'Required tiers must belong to this community');
    requireTier(access, tierIds);
  }
  const contentId = await getDb().transaction(async (tx) => {
    const [content] = await tx
      .insert(membershipContents)
      .values({
        communityId,
        authorOxyUserId: actor.accountId,
        kind: input.kind,
        title: input.title ?? null,
        body: input.body,
        teaser: input.parentContentId ? null : (input.teaser ?? null),
        parentContentId: input.parentContentId ?? null,
        pollEndsAt: input.poll ? new Date(input.poll.endsAt) : null,
      })
      .returning({ id: membershipContents.id });
    if (tierIds.length)
      await tx
        .insert(membershipContentTiers)
        .values(tierIds.map((tierId) => ({ communityId, contentId: content.id, tierId })));
    const mediaIds = [...new Set(input.mediaIds ?? [])];
    if (mediaIds.length) {
      const attached = await tx
        .update(membershipMedia)
        .set({ contentId: content.id })
        .where(
          and(
            inArray(membershipMedia.id, mediaIds),
            eq(membershipMedia.ownerOxyUserId, actor.accountId),
            eq(membershipMedia.communityId, communityId),
            isNull(membershipMedia.contentId),
          ),
        )
        .returning({ id: membershipMedia.id });
      if (attached.length !== mediaIds.length)
        throw new MembershipError(
          400,
          'Media must be an unattached private upload owned by this account in this community',
        );
    }
    if (input.poll)
      await tx
        .insert(membershipPollOptions)
        .values(
          input.poll.options.map((text, position) => ({ contentId: content.id, text, position })),
        );
    return content.id;
  });
  return readMembershipContent(contentId, actor);
}
/** An opaque cursor is carried by the HTTP layer using the standard chrono codec. */
export async function listMembershipContent(
  communityId: string,
  actor: MembershipActor,
  options: { limit: number; before?: { id: string; createdAt: Date }; parentContentId?: string },
) {
  const community = await communityById(communityId);
  const access = await requireCommunityBenefit(community, actor, 'content_read');
  if (options.parentContentId) {
    const parent = await readableMembershipContent(options.parentContentId, actor);
    if (parent.row.communityId !== communityId) throw new MembershipError(404, 'Thread not found');
  }
  const tierId = access.membership?.tierId;
  const policy = access.manager
    ? undefined
    : sql`(
    not exists (select 1 from ${membershipContentTiers} where ${qualified(membershipContentTiers.contentId)} = ${qualified(membershipContents.id)})
    or exists (select 1 from ${membershipContentTiers} where ${qualified(membershipContentTiers.contentId)} = ${qualified(membershipContents.id)} and ${qualified(membershipContentTiers.tierId)} = ${tierId})
  )`;
  const before = options.before;
  const rows = await getDb()
    .select()
    .from(membershipContents)
    .where(
      and(
        eq(membershipContents.communityId, communityId),
        isNull(membershipContents.removedAt),
        options.parentContentId
          ? eq(membershipContents.parentContentId, options.parentContentId)
          : isNull(membershipContents.parentContentId),
        policy,
        before
          ? or(
              lt(membershipContents.createdAt, before.createdAt),
              and(
                eq(membershipContents.createdAt, before.createdAt),
                lt(membershipContents.id, before.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(membershipContents.createdAt), desc(membershipContents.id))
    .limit(options.limit + 1);
  const hasMore = rows.length > options.limit;
  const page = rows.slice(0, options.limit);
  const safe = await membershipSafetyDecisions(
    page.map((row) => ({ id: row.id, authorOxyUserId: row.authorOxyUserId })),
    actor.requester,
  );
  const items = await hydrateMembershipContent(
    page.filter((row) => safe.has(row.id)),
    actor,
  );
  return { items, hasMore, last: page.at(-1) };
}
export async function voteMembershipPoll(
  contentId: string,
  actor: MembershipActor,
  optionId: string,
): Promise<void> {
  const { row } = await readableMembershipContent(contentId, actor);
  await requireCommunityBenefit(await communityById(row.communityId), actor, 'polls_vote');
  await getDb().transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(membershipContents)
      .where(eq(membershipContents.id, contentId))
      .for('update');
    if (
      !current ||
      current.removedAt ||
      current.kind !== 'poll' ||
      !current.pollEndsAt ||
      current.pollEndsAt <= new Date()
    )
      throw new MembershipError(409, 'Poll is closed');
    const [option] = await tx
      .select({ id: membershipPollOptions.id })
      .from(membershipPollOptions)
      .where(
        and(eq(membershipPollOptions.id, optionId), eq(membershipPollOptions.contentId, contentId)),
      )
      .limit(1);
    if (!option) throw new MembershipError(400, 'Option belongs to another poll');
    await tx
      .insert(membershipPollVotes)
      .values({ contentId, voterOxyUserId: actor.accountId, optionId })
      .onConflictDoUpdate({
        target: [membershipPollVotes.contentId, membershipPollVotes.voterOxyUserId],
        set: { optionId },
      });
  });
}
export async function reportMembershipContent(
  contentId: string,
  actor: MembershipActor,
  reason: string,
): Promise<void> {
  await readableMembershipContent(contentId, actor);
  await getDb()
    .insert(membershipReports)
    .values({ contentId, reporterOxyUserId: actor.accountId, reason })
    .onConflictDoNothing();
}
export async function removeMembershipContent(
  contentId: string,
  actor: MembershipActor,
): Promise<void> {
  const { row } = await readableMembershipContent(contentId, actor);
  if (row.authorOxyUserId !== actor.accountId)
    await requireManager(await communityById(row.communityId), actor);
  await getDb()
    .update(membershipContents)
    .set({ removedAt: new Date(), updatedAt: new Date() })
    .where(eq(membershipContents.id, contentId));
}
export async function membershipReportQueue(communityId: string, actor: MembershipActor) {
  await requireManager(await communityById(communityId), actor);
  // Reporter identity never enters the community operator DTO.
  return getDb()
    .select({
      id: membershipReports.id,
      contentId: membershipReports.contentId,
      reason: membershipReports.reason,
      createdAt: membershipReports.createdAt,
    })
    .from(membershipReports)
    .innerJoin(membershipContents, eq(membershipContents.id, membershipReports.contentId))
    .where(
      and(eq(membershipContents.communityId, communityId), isNull(membershipReports.resolvedAt)),
    )
    .orderBy(desc(membershipReports.createdAt))
    .limit(100);
}
