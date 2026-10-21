import { LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND } from '@oxy.so/federation';
import type { FederatedActorRecord } from '../../db/federation/actorRecord';
import { resolveAccountKinds } from '../publishAsAccount';

/**
 * Which of these federated actors are COMMUNITIES (a Lemmy, PieFed or Mbin
 * community, FEP-1b12), as their Oxy account ids.
 *
 * The ONE place this is decided, for the ingest
 * (`connectors/activitypub/apCommunity.ts`); everything downstream reads the
 * decision back from `posts.community_oxy_user_id`.
 *
 * THE ANSWER IS OXY'S ACCOUNT KIND. Oxy records every federated account with
 * the kind `@oxy.so/federation`'s actor-type table gives it (`accountKindForActor`,
 * OxyHQ/oxy#1865), and it reads a signal Mention's actor row does not keep: a
 * `Group` whose `postingRestrictedToMods` is set (a PeerTube channel, a
 * moderators-only Lemmy community) is a `channel`, not a `community`. Reading
 * the kind off the Oxy user — through the user-summary cache every author
 * hydration already fills, the same copy `PostUser.kind` ships to the client —
 * keeps the backend's decision and the profile the reader sees the same fact.
 *
 * The actor row only NARROWS the lookup. The table maps exactly one AS2 type to
 * a community (`LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND.community`, `Group`), so an
 * actor of any other type cannot be one and costs nothing, and a `Group` costs a
 * batched cache read.
 *
 * Fail-soft: an account Oxy could not be asked about resolves as no community,
 * which stores the post without one.
 */
export async function communityAccountIds(
  actors: readonly Pick<FederatedActorRecord, 'type' | 'oxyUserId'>[],
): Promise<Set<string>> {
  const candidates = actors
    .filter((actor) => actor.type === LOCAL_ACTOR_TYPE_BY_ACCOUNT_KIND.community)
    .map((actor) => actor.oxyUserId)
    .filter((id): id is string => Boolean(id));
  if (candidates.length === 0) return new Set();
  const kinds = await resolveAccountKinds(candidates);
  return new Set(candidates.filter((id) => kinds.get(id) === 'community'));
}
