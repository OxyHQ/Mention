import { ANY_DID_RE } from '../atproto/constants';

/**
 * Bridgy Fed's Bluesky→fediverse identity: a Bluesky account appears on the
 * fediverse at the DETERMINISTIC actor URI `https://bsky.brid.gy/ap/<did>`, so
 * the two spellings of one person convert both ways with no network round trip.
 *
 * Shared (not under `activitypub/`) because both protocols' code and the
 * follow-graph mirror's queries need it: the mirror stores one node per person
 * (the DID) and matches either spelling of a known account.
 */

/** Bridgy Fed's Bluesky↔fediverse bridge host (where the `/ap/<did>` scheme lives). */
export const BRIDGY_FED_BSKY_HOST = 'bsky.brid.gy';

/** Every bridged Bluesky actor URI is this prefix followed by the DID. */
export const BRIDGY_BSKY_ACTOR_PREFIX = `https://${BRIDGY_FED_BSKY_HOST}/ap/`;

/** The Bridgy Fed actor URI of a Bluesky DID. */
export function bridgyActorUriForDid(did: string): string {
  return `${BRIDGY_BSKY_ACTOR_PREFIX}${did}`;
}

/**
 * The atproto DID of a Bridgy Fed actor URI (`https://bsky.brid.gy/ap/<did>`) —
 * the inverse of {@link bridgyActorUriForDid}. Undefined for any other URL or a
 * path that is not exactly `/ap/<did>`.
 */
export function didFromBridgyActorUri(actorUri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(actorUri);
  } catch {
    return undefined;
  }
  if (url.host.toLowerCase() !== BRIDGY_FED_BSKY_HOST) return undefined;
  const did = url.pathname.match(/^\/ap\/(did:(?:plc|web):[^/]+)$/i)?.[1];
  return did && ANY_DID_RE.test(did) ? did : undefined;
}
