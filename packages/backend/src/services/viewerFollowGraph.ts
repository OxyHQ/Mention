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
import { extractFollowingIds, type OxyClient } from '../utils/privacyHelpers';
import { logger } from '../utils/logger';

/**
 * Merge oxyUserIds from accepted federated (ActivityPub) outbound follows into
 * `followingIds`, deduplicating in-place.
 */
export async function mergeFederatedFollowIds(localUserId: string, followingIds: string[]): Promise<void> {
  const fedFollowUris = await distinctRemoteActorUris({
    localUserId,
    direction: 'outbound',
    statuses: ['accepted'],
  });
  if (fedFollowUris.length === 0) return;

  // The Mongo filter also carried `{ oxyUserId: { $ne: null } }`. It is dropped
  // rather than translated: the loop below already skips an actor with no
  // `oxyUserId`, and `<> null` in SQL is NULL — not true — so the literal
  // translation would have matched nothing and quietly emptied the follow graph.
  const fedActors = await findActorsByUris(fedFollowUris);

  const existing = new Set(followingIds);
  for (const actor of fedActors) {
    const id = actor.oxyUserId;
    if (id && !existing.has(id)) {
      followingIds.push(id);
      existing.add(id);
    }
  }
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
      ids.push(...extractFollowingIds(await oxyClient.getUserFollowing(userId)));
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
