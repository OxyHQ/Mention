import { and, eq } from 'drizzle-orm';
import { COMMUNITY_MODERATION_REASON_MAX_LENGTH, type CommunityBan } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { loadPostRecord } from '../../db/posts/postRepository';
import { findActorsByOxyUserIds } from '../../db/federation/actorRepository';
import {
  deleteCommunityBan,
  insertCommunityBan,
  listCommunityBans,
} from '../../db/communities/communityBanRepository';
import {
  buildCommunityBlock,
  buildCommunityRemoval,
  buildCommunityUnblock,
  relayToCommunityFollowers,
  resolveLocalCommunityActor,
  type LocalCommunityActor,
} from '../../connectors/activitypub/communityRelay';
import { actorUrl } from '../../connectors/activitypub/constants';
import { deliveryService } from '../../connectors/activitypub/delivery.service';
import { isFediverseSharingEnabled } from '../fediverseSharing';
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

/** The moderator's own actor, when they federate — the actor of a Lemmy-style removal. */
async function moderatorActorUri(moderatorOxyUserId: string): Promise<string | null> {
  if (!(await isFediverseSharingEnabled(moderatorOxyUserId))) return null;
  const username = (await resolveUserSummaries([moderatorOxyUserId]))
    .get(moderatorOxyUserId)
    ?.user.username?.trim();
  return username ? actorUrl(username) : null;
}

/**
 * The AP object id a post is known by: a local post's minted Note id, a
 * federated one's own.
 */
async function postObjectId(postId: string): Promise<string | null> {
  const post = await loadPostRecord(postId);
  if (!post) return null;
  if (post.federation) return post.federation.activityId ?? null;
  const author = post.oxyUserId
    ? (await resolveUserSummaries([post.oxyUserId])).get(post.oxyUserId)?.user.username
    : undefined;
  return author ? `${actorUrl(author)}/posts/${post.id}` : null;
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

  const objectId = await postObjectId(params.postId);
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

  const [community, moderator] = await Promise.all([
    resolveLocalCommunityActor(params.communityOxyUserId),
    moderatorActorUri(params.moderatorOxyUserId),
  ]);
  if (community && moderator && objectId) {
    await relayToCommunityFollowers(
      community,
      buildCommunityRemoval(community, moderator, objectId, params.reason),
    );
  }
}

/** The remote actor (and its inbox) behind a federated account, when it has one. */
async function remoteActorOf(
  oxyUserId: string,
): Promise<{ uri: string; inbox: string | undefined } | null> {
  const [actor] = await findActorsByOxyUserIds([oxyUserId]);
  if (!actor?.uri) return null;
  return { uri: actor.uri, inbox: actor.sharedInboxUrl || actor.inboxUrl || undefined };
}

/** Deliver a community's `Block`/`Undo(Block)` to the person it concerns, when they are remote. */
async function deliverToBannedPerson(
  community: LocalCommunityActor,
  bannedOxyUserId: string,
  build: (actorUri: string) => Record<string, unknown>,
): Promise<void> {
  try {
    const remote = await remoteActorOf(bannedOxyUserId);
    if (!remote?.inbox || !(await isFediverseSharingEnabled(community.oxyUserId))) return;
    await deliveryService.queueDelivery(build(remote.uri), remote.inbox, community.oxyUserId);
  } catch (err) {
    logger.error('[Communities] failed to federate a ban', err);
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

  const community = await resolveLocalCommunityActor(params.communityOxyUserId);
  if (community) {
    await deliverToBannedPerson(community, params.bannedOxyUserId, (actorUri) =>
      buildCommunityBlock(community, actorUri, params.reason),
    );
  }
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
  const community = await resolveLocalCommunityActor(params.communityOxyUserId);
  if (community) {
    await deliverToBannedPerson(community, params.bannedOxyUserId, (actorUri) =>
      buildCommunityUnblock(community, actorUri),
    );
  }
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
