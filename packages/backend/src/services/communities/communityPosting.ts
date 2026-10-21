import { eq } from 'drizzle-orm';
import { COMMUNITY_POST_TITLE_MAX_LENGTH, PostVisibility } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { isBannedFromCommunity } from '../../db/communities/communityBanRepository';
import { resolveCommunities } from '../publishAsAccount';

/**
 * Which community a post written HERE is written in — the one rule for a native
 * post, decided before anything is written, and refused rather than dropped (an
 * author told nothing would believe they had posted in the community).
 *
 * A community is open: anybody its moderators have not banned may post in it,
 * as themselves — one hosted here (Mention enforces its bans) or a remote one
 * (Lemmy, PieFed, Mbin: the post is delivered to it, and its own server decides). A post written in one stays its author's — it carries the
 * community in `posts.community_oxy_user_id`, the column the federated ingest
 * already fills for Lemmy, PieFed and Mbin posts, so the community's page, the
 * Following feed of its members and the card's "in" row need nothing new.
 *
 * A REPLY is written in its thread's community: it inherits its parent's, so a
 * whole conversation reaches the community's followers like Lemmy's comments
 * do (relayed here, or delivered to the remote community). It never names one
 * itself.
 */

/** A refusal carrying the status the HTTP layer answers with. */
export class CommunityPostError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'CommunityPostError';
    this.status = status;
  }
}

/**
 * The community a post (a reply's parent) was written in — hosted here or
 * remote. The column only ever holds a community (the kind decides it when the
 * post is written), so it is read as stored.
 */
export async function communityOfPost(postId: string): Promise<string | null> {
  const [row] = await getDb()
    .select({ communityOxyUserId: posts.communityOxyUserId })
    .from(posts)
    .where(eq(posts.id, postId))
    .limit(1);
  return row?.communityOxyUserId ?? null;
}

/** A community post's title: one trimmed plain-text line, or a refusal. */
export function normalizeCommunityPostTitle(title: unknown): string | undefined {
  if (title === undefined || title === null) return undefined;
  if (typeof title !== 'string') throw new CommunityPostError(400, 'A title must be text');
  const line = title.replace(/\s+/g, ' ').trim();
  if (!line) return undefined;
  if (line.length > COMMUNITY_POST_TITLE_MAX_LENGTH) {
    throw new CommunityPostError(
      400,
      `A title is at most ${COMMUNITY_POST_TITLE_MAX_LENGTH} characters`,
    );
  }
  return line;
}

/**
 * The community a NATIVE post is written in, or null — or a refusal.
 *
 *  - **400** — a community named on a reply (it takes its thread's), a boost, a
 *    post published as another account (a community post is a person's), a post
 *    that is not public, or an account that is not a community hosted here; a
 *    title on a post written in no community, or on a reply.
 *  - **403** — the author is banned from the community.
 */
export async function resolveNativePostCommunity(params: {
  requestedCommunityOxyUserId: string | null | undefined;
  authorId: string | null;
  publishedAsAccount: boolean;
  parentPostId: string | null | undefined;
  boostOf: string | null | undefined;
  visibility: PostVisibility;
  hasTitle: boolean;
}): Promise<string | null> {
  const requested = params.requestedCommunityOxyUserId?.trim() || null;

  let communityId: string | null;
  if (params.parentPostId) {
    communityId = await communityOfPost(params.parentPostId);
    if (requested && requested !== communityId) {
      throw new CommunityPostError(400, "A reply is written in its thread's community");
    }
    if (params.hasTitle) throw new CommunityPostError(400, 'A reply carries no title');
  } else if (requested) {
    if (params.boostOf) throw new CommunityPostError(400, 'A boost is not written in a community');
    if (params.publishedAsAccount) {
      throw new CommunityPostError(400, 'A community post is written as yourself');
    }
    if (params.visibility !== PostVisibility.PUBLIC) {
      throw new CommunityPostError(400, 'A community post is public');
    }
    if (!(await resolveCommunities([requested])).has(requested)) {
      throw new CommunityPostError(400, 'That account is not a community');
    }
    communityId = requested;
  } else {
    if (params.hasTitle) throw new CommunityPostError(400, 'A title is for a community post');
    return null;
  }

  if (
    communityId &&
    params.authorId &&
    (await isBannedFromCommunity(communityId, params.authorId))
  ) {
    throw new CommunityPostError(403, 'You are banned from this community');
  }
  return communityId;
}
