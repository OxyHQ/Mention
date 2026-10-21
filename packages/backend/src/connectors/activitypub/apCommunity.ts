import type { FederatedActorRecord } from '../../db/federation/actorRecord';
import { findActorsByUris } from '../../db/federation/actorRepository';
import { logger } from '../../utils/logger';
import { isAbsoluteHttpUrl } from '../shared/url';
import { actorService } from './actor.service';
import { sameOrigin } from './helpers';

/**
 * Communities: the ActivityPub `Group` actors of Lemmy, PieFed, Mbin and the
 * like (FEP-1b12). A member writes a post IN a community; the community relays
 * it to its followers (`apRelay.ts`). Mention stores the post as its writer's,
 * with the community it was written in as `posts.community_oxy_user_id`.
 */

/**
 * Whether a federated actor is a COMMUNITY.
 *
 * The ONE place this is decided. Today it is Mention's own record of the actor's
 * AS2 type; when Oxy's account graph carries a `community` kind, this becomes
 * that test and nothing else changes.
 */
export function isCommunityActor(actor: Pick<FederatedActorRecord, 'type'> | null): boolean {
  return actor?.type === 'Group';
}

const AS_PUBLIC = new Set(['https://www.w3.org/ns/activitystreams#Public', 'as:Public', 'Public']);

/** Addressees in an AP addressing field (`audience` / `to` / `cc`), bounded. */
function addressees(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((uri) => !AS_PUBLIC.has(uri) && isAbsoluteHttpUrl(uri))
    .slice(0, MAX_COMMUNITY_CANDIDATES);
}

/** A hostile object cannot make one post resolve more actors than this. */
const MAX_COMMUNITY_CANDIDATES = 10;

/**
 * The community a post object was published in, as the Oxy account id of its
 * `Group`, or null.
 *
 * WHERE THE CLAIM COMES FROM. `audience` names the community (Lemmy since 0.18,
 * PieFed, Mbin). Older Lemmy only addressed it in `to`/`cc`, beside followers
 * collections and other people, so an addressee there counts only when it is
 * ALREADY a known community here: resolving every addressee would fetch actors
 * nobody asked for. An `audience` that is not known yet is resolved, once per
 * community, through the ordinary actor fetch (domain policy included).
 *
 * WHY IT IS CHECKED. Any server can write any `audience`, and a community's
 * profile lists its posts, so an unchecked claim would let one server place
 * posts in another's community. A community is accepted only when it vouches
 * for the post: it RELAYED it to us (`relayedBy`, the verified signer of the
 * `Announce` or the owner of the outbox it was read from), or the post comes
 * from the community's own origin. A reply-ancestor or boost import of a
 * cross-instance post therefore stores no community; the relayed copy does.
 *
 * Fail-soft: the community is context on a post that is stored either way.
 */
export async function resolvePostCommunity(
  object: Record<string, unknown>,
  relayedBy?: string,
): Promise<string | null> {
  const objectId = typeof object.id === 'string' ? object.id : '';
  const vouches = (uri: string) =>
    uri === relayedBy || (objectId !== '' && sameOrigin(uri, objectId));
  const declared = addressees(object.audience).filter(vouches);
  const addressed = [...addressees(object.to), ...addressees(object.cc)].filter(vouches);
  const candidates = [...new Set([...declared, ...addressed])];
  if (candidates.length === 0) return null;

  try {
    const known = await findActorsByUris(candidates);
    const community = (actor: FederatedActorRecord | null | undefined) =>
      actor && isCommunityActor(actor) && actor.oxyUserId ? actor.oxyUserId : null;
    for (const uri of candidates) {
      const found = community(known.find((actor) => actor.uri === uri));
      if (found) return found;
    }
    for (const uri of declared) {
      if (known.some((actor) => actor.uri === uri)) continue;
      const found = community(await actorService.getOrFetchActor(uri));
      if (found) return found;
    }
  } catch (err) {
    logger.info('[Federation] could not resolve the community of a post', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}
