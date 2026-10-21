import type { FederatedActorRecord } from '../../db/federation/actorRecord';

/**
 * Whether a federated actor is a COMMUNITY — the ActivityPub `Group` of a Lemmy,
 * PieFed or Mbin community (FEP-1b12).
 *
 * The ONE place this is decided: the ingest (`connectors/activitypub/apCommunity.ts`)
 * and the viewer's follow graph (`services/viewerFollowGraph.ts`) both ask here.
 * Today it is Mention's own record of the actor's AS2 type; when Oxy's account
 * graph carries a `community` kind, this becomes that test and nothing else
 * changes.
 */
export function isCommunityActor(actor: Pick<FederatedActorRecord, 'type'> | null): boolean {
  return actor?.type === 'Group';
}
