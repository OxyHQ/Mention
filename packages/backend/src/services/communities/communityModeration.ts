import { and, eq } from 'drizzle-orm';
import { COMMUNITY_MODERATION_REASON_MAX_LENGTH, type CommunityBan } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import {
  deleteCommunityBan,
  insertCommunityBan,
  listCommunityBans,
} from '../../db/communities/communityBanRepository';
import { activityPubConnector } from '../../connectors/activitypub/ActivityPubConnector';
import { resolveUserSummaries } from '../PostHydrationService';
import { invalidate as invalidatePostDetail } from '../postDetailCache';
import { degradedActorSummary } from '../../utils/degradedActorSummary';
import { logger } from '../../utils/logger';
import { assertCanModerateCommunity, type AccountMemberReader } from '../publishAsAccount';
import { CommunityPostError } from './communityPosting';

/**
 * What a community's moderators may do to it, from Mention: remove a post from
 * it, and ban a person from posting in it. Every action is authorized by
 * {@link assertCanModerateCommunity} (an active member of the community, read
 * from Oxy with the moderator's own bearer) and federates the way Lemmy's do,
 * relayed by the community (FEP-1b12).
 *
 * Reports on a community's posts need nothing here: they are ordinary posts, so
 * a report is the existing `POST /reports` and its CrowdSource pipeline.
 */

/** The most bans one page of the moderators' list returns. */
const MAX_BANS_LISTED = 200;

/** A moderator's reason: trimmed, bounded, or absent. */
export function normalizeModerationReason(reason: unknown): string | null {
  if (reason === undefined || reason === null) return null;
  if (typeof reason !== 'string') throw new CommunityPostError(400, 'A reason must be text');
  const text = reason.trim();
  if (text.length > COMMUNITY_MODERATION_REASON_MAX_LENGTH) {
    throw new CommunityPostError(
      400,
      `A reason is at most ${COMMUNITY_MODERATION_REASON_MAX_LENGTH} characters`,
    );
  }
  return text || null;
}

interface ModeratorContext {
  communityOxyUserId: string;
  moderatorOxyUserId: string;
  memberReader: AccountMemberReader | undefined;
}

/**
 * Remove a post from the community. The post is not deleted — it stays its
 * author's — it stops being written IN the community: its
 * `community_oxy_user_id` is cleared, so it leaves the community's page and its
 * members' feeds by the same partial index that put it there. The community
 * relays a moderator's `Delete` so Lemmy, PieFed and Mbin remove it there too.
 *
 * 404 when the post is not in this community (any more).
 */
export async function removePostFromCommunity(
  params: ModeratorContext & { postId: string; reason: string | null },
): Promise<void> {
  await assertCanModerateCommunity({
    communityOxyUserId: params.communityOxyUserId,
    callerId: params.moderatorOxyUserId,
    memberReader: params.memberReader,
  });

  // The AP id is read BEFORE the community is cleared: what the fediverse knows
  // the post by does not depend on it, but reading it after a concurrent
  // delete would find nothing to federate.
  const objectId = await activityPubConnector.communityPostObjectId(params.postId);
  const [removed] = await getDb()
    .update(posts)
    .set({ communityOxyUserId: null })
    .where(
      and(eq(posts.id, params.postId), eq(posts.communityOxyUserId, params.communityOxyUserId)),
    )
    .returning({ id: posts.id });
  if (!removed) throw new CommunityPostError(404, 'That post is not in this community');
  await invalidatePostDetail(params.postId);

  logger.info('[Communities] a moderator removed a post', {
    communityOxyUserId: params.communityOxyUserId,
    postId: params.postId,
    moderatorOxyUserId: params.moderatorOxyUserId,
  });

  if (objectId) {
    await activityPubConnector.federateCommunityRemoval({
      communityOxyUserId: params.communityOxyUserId,
      moderatorOxyUserId: params.moderatorOxyUserId,
      objectId,
      reason: params.reason,
    });
  }
}

/**
 * Ban a person from posting in the community: their posts and replies are
 * refused from Mention (403) and dropped from the fediverse, and the community
 * sends them a `Block` (Mastodon then unfollows it for them). What they already
 * posted stays until a moderator removes it.
 *
 * A moderator cannot be banned — they would still be one — and neither can the
 * caller themselves (400).
 */
export async function banFromCommunity(
  params: ModeratorContext & { bannedOxyUserId: string; reason: string | null },
): Promise<void> {
  await assertCanModerateCommunity({
    communityOxyUserId: params.communityOxyUserId,
    callerId: params.moderatorOxyUserId,
    memberReader: params.memberReader,
  });
  if (params.bannedOxyUserId === params.moderatorOxyUserId) {
    throw new CommunityPostError(400, 'You cannot ban yourself');
  }
  // The moderator's own client: the same `members:read` read the gate made.
  const members = await params.memberReader?.accounts.members.list(params.communityOxyUserId);
  if (
    members?.some(
      (member) => member.memberUserId === params.bannedOxyUserId && member.status === 'active',
    )
  ) {
    throw new CommunityPostError(400, 'A moderator cannot be banned');
  }

  const created = await insertCommunityBan({
    communityOxyUserId: params.communityOxyUserId,
    bannedOxyUserId: params.bannedOxyUserId,
    bannedByOxyUserId: params.moderatorOxyUserId,
    reason: params.reason,
  });
  if (!created) return;

  await activityPubConnector.federateCommunityBan(
    params.communityOxyUserId,
    params.bannedOxyUserId,
    params.reason,
  );
}

/** Lift a ban; the community sends the `Undo(Block)`. 404 when there was none. */
export async function unbanFromCommunity(
  params: ModeratorContext & { bannedOxyUserId: string },
): Promise<void> {
  await assertCanModerateCommunity({
    communityOxyUserId: params.communityOxyUserId,
    callerId: params.moderatorOxyUserId,
    memberReader: params.memberReader,
  });
  if (!(await deleteCommunityBan(params.communityOxyUserId, params.bannedOxyUserId))) {
    throw new CommunityPostError(404, 'That person is not banned');
  }
  await activityPubConnector.federateCommunityUnban(
    params.communityOxyUserId,
    params.bannedOxyUserId,
  );
}

/** The community's bans, for its moderators, newest first. */
export async function listBansForModerators(params: ModeratorContext): Promise<CommunityBan[]> {
  await assertCanModerateCommunity({
    communityOxyUserId: params.communityOxyUserId,
    callerId: params.moderatorOxyUserId,
    memberReader: params.memberReader,
  });
  const rows = await listCommunityBans(params.communityOxyUserId, MAX_BANS_LISTED);
  const summaries = await resolveUserSummaries(rows.map((row) => row.bannedOxyUserId));
  return rows.map((row) => ({
    user: summaries.get(row.bannedOxyUserId)?.user ?? degradedActorSummary(row.bannedOxyUserId),
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  }));
}
