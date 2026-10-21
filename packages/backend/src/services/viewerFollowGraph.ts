/**
 * The viewer's outbound follow graph, as Mention sees it: the Oxy following list
 * PLUS accepted federated (ActivityPub) follows, whose remote actors are linked to
 * Oxy users.
 *
 * Mention's notion of "someone I follow" is the union of both, so any surface that
 * branches on it — feed candidate sourcing, and the `exclude-following` scope on a
 * muted word — must read the same union or it will disagree with the feed about who
 * the viewer follows. This module owns that union so the two cannot diverge.
 */

import { findActorsByUris } from '../db/federation/actorRepository';
import { distinctRemoteActorUris } from '../db/federation/followRepository';
import { getFollowingIds, type OxyClient } from '../utils/privacyHelpers';
import { logger } from '../utils/logger';
import { sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { posts } from '../db/schema/posts';

/**
 * Which of these accounts posts have been WRITTEN IN — the communities among
 * them, local or remote alike, as the feed needs them.
 *
 * A community is followed like any account, but what it publishes is written by
 * its members, so the Following feed reaches its posts by
 * `posts.community_oxy_user_id` instead of by author. Asking the column itself
 * is exact by construction — only a community is ever stored there (Oxy's kind
 * decides it at write time, `apCommunity.ts` and `communityPosting.ts`), and a
 * community nothing was written in has nothing to add — and it costs one probe
 * of the partial `post_community_chrono_v1` per followed account, with no
 * identity read.
 */
export async function communitiesAmong(accountIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (ids.length === 0) return [];
  const rows = await getDb().execute<{ id: string }>(
    sql`select candidate.id from unnest(${sql.param(ids)}::text[]) as candidate(id)
        where exists (select 1 from ${posts} where ${posts.communityOxyUserId} = candidate.id)`,
  );
  return [...rows].map((row) => row.id);
}

/**
 * Merge oxyUserIds from accepted federated (ActivityPub) outbound follows into
 * `followingIds`, deduplicating in-place, and return the COMMUNITIES the viewer
 * follows ({@link communitiesAmong}) — hosted here or on Lemmy, PieFed, Mbin.
 *
 * `acceptedOutboundUris` lets a caller that ALREADY has the viewer's accepted
 * outbound follow uris in flight hand that same pending read in rather than
 * paying for a byte-identical second one. The feed controller does: it needs the
 * set for the Mutuals/social-proof intersection as well, and the two reads were
 * measured as an exact duplicate on every authenticated For You request. A
 * PROMISE rather than a resolved array on purpose — awaiting it before the call
 * would serialise a hop that runs in parallel today. Omitted by every other
 * caller, which reads it here.
 */
export async function mergeFederatedFollowIds(
  localUserId: string,
  followingIds: string[],
  acceptedOutboundUris?: Promise<string[]>,
): Promise<string[]> {
  const fedFollowUris = await (acceptedOutboundUris ??
    distinctRemoteActorUris({
      localUserId,
      direction: 'outbound',
      statuses: ['accepted'],
    }));

  if (fedFollowUris.length > 0) {
    // No `oxyUserId <> null` filter: the loop below already skips an actor with
    // no `oxyUserId`, and `<> null` in SQL is NULL — not true — so it would match
    // nothing and quietly empty the follow graph.
    const fedActors = await findActorsByUris(fedFollowUris);

    const existing = new Set(followingIds);
    for (const actor of fedActors) {
      const id = actor.oxyUserId;
      if (!id) continue;
      if (!existing.has(id)) {
        followingIds.push(id);
        existing.add(id);
      }
    }
  }
  return communitiesAmong(followingIds);
}

/**
 * The viewer's followed-author ids as a lookup set — Oxy follows ∪ accepted
 * federated follows, exactly the union the feed context assembles.
 *
 * For surfaces that do NOT already carry the viewer's graph (search,
 * notifications) and need it only to evaluate an `exclude-following` muted word.
 * Call it ONLY when such a rule exists: it costs one Oxy round trip plus two
 * indexed reads, which the overwhelming majority of requests should not pay.
 *
 * Fail-soft per branch, like the feed context: a failed Oxy lookup or federated
 * merge degrades to the ids it did resolve rather than rejecting.
 */
export async function loadFollowedAuthorIds(
  userId: string | undefined,
  oxyClient: OxyClient | undefined,
): Promise<ReadonlySet<string>> {
  if (!userId) return new Set<string>();

  const ids: string[] = [];
  if (oxyClient) {
    try {
      ids.push(...(await getFollowingIds(userId, oxyClient)));
    } catch (error) {
      logger.warn('[viewerFollowGraph] Failed to load following list', error);
    }
  }
  try {
    await mergeFederatedFollowIds(userId, ids);
  } catch (error) {
    logger.warn('[viewerFollowGraph] Failed to load federated following', error);
  }

  return new Set(ids);
}
