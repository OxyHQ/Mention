import type { LocalPostEventPayload } from '../types';

/**
 * Typed seam for the FULL Bluesky bridge (Phase C4 — NOT implemented here).
 *
 * C2/C3 are read/discovery only: Mention reads Bluesky profiles and posts through
 * the public AppView and records follows as local subscriptions. Going the other
 * direction — publishing Mention content INTO the atproto network and being
 * discovered BY Bluesky — is the C4 bridge. This file documents that future
 * surface as throwing stubs so the wiring is explicit and the connector's
 * `deliver` can reference it without any partial implementation leaking out.
 *
 * The atproto bridge is feasible because Oxy identities are `did:web` and atproto
 * accepts `did:web`. The C4 work is:
 *
 *  1. OUTBOUND publish — turn a local post into an `app.bsky.feed.post` record and
 *     `com.atproto.repo.createRecord` it to a Personal Data Server (PDS) the user
 *     authorizes, signed by their Oxy `did:web` identity. Requires a PDS session
 *     / app-password (or a Mention-hosted repo) and the user's PDS endpoint
 *     (already surfaced by `identityResolver.resolveIdentity().pdsEndpoint`).
 *
 *  2. BE-DISCOVERED — serve `/.well-known/atproto-did` on the user's domain, list
 *     atproto verification methods in the Oxy DID document, host the repo's
 *     `com.atproto.sync.*` endpoints, and register with a Relay so AppViews index
 *     the content.
 *
 *  3. A periodic `atproto:refresh-followed` job to keep followed actors' feeds
 *     fresh (the inbound counterpart of outbound delivery).
 */

/** Marker thrown by the unimplemented C4 outbound stubs. */
export class AtprotoBridgeNotImplementedError extends Error {
  constructor(operation: string) {
    super(`atproto outbound bridge not implemented (C4): ${operation}`);
    this.name = 'AtprotoBridgeNotImplementedError';
  }
}

/**
 * C4 STUB — publish a local post to the author's PDS as an `app.bsky.feed.post`
 * record via `com.atproto.repo.createRecord`, signed by their Oxy `did:web`.
 * Not implemented in C2/C3.
 */
export function publishPostToPds(
  _post: LocalPostEventPayload,
  _authorOxyUserId: string,
): Promise<never> {
  throw new AtprotoBridgeNotImplementedError('publishPostToPds');
}

/**
 * C4 STUB — deliver a Follow into the atproto network (write an
 * `app.bsky.graph.follow` record to the follower's PDS). The C2 `deliver` records
 * a local subscription instead; this is the real outbound edge. Not implemented.
 */
export function publishFollowToPds(
  _followerOxyUserId: string,
  _targetDid: string,
): Promise<never> {
  throw new AtprotoBridgeNotImplementedError('publishFollowToPds');
}
