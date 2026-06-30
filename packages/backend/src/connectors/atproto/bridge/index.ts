/**
 * AT Protocol BE-DISCOVERED bridge (Phase C4) — public surface.
 *
 * This module is the inverse of the C2/C3 READ connector: it makes a local
 * Mention user discoverable / readable FROM the atproto (Bluesky) network. It is
 * a clean, self-contained sub-module under `connectors/atproto/bridge/` and does
 * NOT touch the read connector or the core MTN paths.
 *
 * WHAT IS BUILT (the coherent read foundation):
 *  - IDENTITY (`identityService`): resolve a local handle → the user's Oxy
 *    `did:web` + bridge PDS endpoint; serve an atproto-flavoured DID-document
 *    view and `.well-known/atproto-did` handle resolution. (The canonical
 *    `oxy.so` `did.json` augmentation is the FLAGGED oxy-api seam.)
 *  - REPO READ (`repoReadService` + `recordTranslator`): translate the user's MTN
 *    `app.mention.feed.*` records → `app.bsky.feed.post|like|repost` and serve
 *    them via `com.atproto.repo.listRecords` / `getRecord` / `describeRepo` /
 *    `com.atproto.sync.getLatestCommit`.
 *  - RELAY (`relayClient`): the `com.atproto.sync.requestCrawl` client, gated +
 *    explicit-activation-only.
 *
 * WHAT IS FLAGGED (the next sub-phase):
 *  - `com.atproto.sync.getRepo` full signed-MST CAR export + commit signing +
 *    the `com.atproto.sync.subscribeRepos` firehose. The read view returns a
 *    structured `NotImplemented` for `getRepo` rather than a fake CAR.
 *  - The oxy-api/core DID-composition change to add `#atproto_pds` + an
 *    atproto-format verification method to the canonical Oxy `did.json`.
 *  - OUTBOUND publishing into the bsky.network PDS (a credential / product
 *    decision) — see {@link AtprotoBridgeOutboundSeam}.
 */

export {
  getAtprotoIdentity,
  getAtprotoIdentityByOxyUserId,
  buildBridgeDidDocumentView,
  bridgeHandle,
  bridgePdsEndpoint,
  type BridgeAtprotoIdentity,
} from './identityService';

export {
  listRecords,
  getRecord,
  type BridgeRecord,
  type ListRecordsPage,
} from './repoReadService';

export {
  translatePostRecord,
  translateLikeRecord,
  translateRepostRecord,
  mtnUriToStrongRef,
  buildBridgeAtUri,
  type AtprotoRecordValue,
  type AtprotoPostRecordValue,
  type AtprotoSubjectRecordValue,
} from './recordTranslator';

export { requestRelayCrawl, type RelayCrawlResult } from './relayClient';

export { ATPROTO_BRIDGE_ENABLED } from './constants';

export { default as atprotoBridgeRouter, bridgeMetaRouter, wellKnownBridgeRouter } from './routes';

/**
 * Explicit Relay activation entry point. Calling this requests a Bluesky Relay
 * crawl of this bridge PDS — an EXTERNAL network activation. It is NEVER invoked
 * automatically (no scheduler, no bootstrap). An operator runs it once the bridge
 * is publicly reachable and a Relay host is configured (`ATPROTO_RELAY_HOST`).
 */
export { requestRelayCrawl as activateRelayCrawl } from './relayClient';

/**
 * OUTBOUND product-decision seam (DOCUMENTED, not implemented).
 *
 * With the BE-DISCOVERED / did:web design, Mention HOSTS the user's repo — a
 * foreign-PDS write is NOT needed for discovery. The ONLY reason to publish into
 * the *bsky.network* PDS (rather than self-hosting) is to give a Mention user a
 * native Bluesky account presence. That requires the USER's Bluesky credentials
 * (an app-password or OAuth session) and is a PRODUCT + credential decision, not
 * a protocol gap.
 *
 * Credential handling is intentionally OUT OF SCOPE here. This type documents the
 * shape such an outbound writer WOULD take so the decision + wiring point is
 * explicit; no implementation is provided.
 */
export interface AtprotoBridgeOutboundSeam {
  /**
   * Publish a local post into a foreign PDS (`com.atproto.repo.createRecord` of
   * an `app.bsky.feed.post`). Requires a user-authorized PDS session — a
   * credential/product decision, deliberately unimplemented.
   */
  publishPostToForeignPds(localPostId: string, authorOxyUserId: string): Promise<never>;
}
