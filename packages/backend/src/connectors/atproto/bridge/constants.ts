/**
 * AT Protocol BE-DISCOVERED bridge constants (Phase C4).
 *
 * The C2/C3 read connector lets Mention READ Bluesky. This bridge is the inverse
 * edge: it makes a LOCAL Mention user discoverable / readable FROM the atproto
 * network, hosting the user's MTN content in `app.bsky.*` shape so a Bluesky
 * AppView (or any atproto tool) can fetch it.
 *
 * Be-discovered is feasible WITHOUT a new keypair scheme: Oxy identities are
 * `did:web` and atproto natively accepts `did:web`. A Mention user's canonical
 * DID is the Oxy DID (`did:web:oxy.so:u:<oxyUserId>`, served by oxy-api). The
 * bridge advertises an `#atproto_pds` service endpoint pointing at THIS backend
 * and serves the read XRPC surface (`com.atproto.repo.*` / `com.atproto.sync.*`)
 * off the existing MTN signed-record chain.
 *
 * Two independent gates keep the surface dark by default and orthogonal to the
 * READ connector:
 *  - {@link ATPROTO_BRIDGE_ENABLED} gates the be-discovered read endpoints.
 *  - The read connector's `ATPROTO_ENABLED` is NOT required for the bridge — the
 *    read and be-discovered directions are independent products.
 *  - Relay registration (`com.atproto.sync.requestCrawl`) is gated SEPARATELY by
 *    {@link ATPROTO_RELAY_HOST} being set AND called from the explicit activation
 *    entry point — it is NEVER auto-invoked (an external network activation).
 */

/**
 * Master gate for the BE-DISCOVERED bridge (the read XRPC surface that exposes a
 * local user's MTN content to atproto). OFF by default — only when
 * `ATPROTO_BRIDGE_ENABLED === 'true'` are the bridge routes live. Independent of
 * the read connector's `ATPROTO_ENABLED`.
 */
export const ATPROTO_BRIDGE_ENABLED = process.env.ATPROTO_BRIDGE_ENABLED === 'true';

/**
 * The public domain the bridge mints its handle and PDS service URLs under — the
 * Mention federation domain (`mention.earth`). The PDS service endpoint and the
 * `.well-known/atproto-did` host are both built from this, so a foreign AppView
 * resolves a Mention user's handle back to the bridge.
 */
export const BRIDGE_DOMAIN = process.env.FEDERATION_DOMAIN || 'mention.earth';

/**
 * The `at://` collection NSIDs the bridge exposes. The MTN feed collections map
 * 1:1 to their `app.bsky.feed.*` equivalents; tombstone + bookmark have NO
 * served atproto analogue (a tombstone is a deletion applied during translation,
 * a bookmark is private), so they are NOT exposed via `listRecords`.
 */
export const BSKY_POST_COLLECTION = 'app.bsky.feed.post';
export const BSKY_LIKE_COLLECTION = 'app.bsky.feed.like';
export const BSKY_REPOST_COLLECTION = 'app.bsky.feed.repost';

/** Every `app.bsky.*` collection the bridge serves via `listRecords`. */
export const BRIDGE_BSKY_COLLECTIONS = [
  BSKY_POST_COLLECTION,
  BSKY_LIKE_COLLECTION,
  BSKY_REPOST_COLLECTION,
] as const;

export type BridgeBskyCollection = (typeof BRIDGE_BSKY_COLLECTIONS)[number];

/**
 * The Relay host to register a crawl with (`com.atproto.sync.requestCrawl`).
 * UNSET by default — Relay registration is an EXTERNAL activation (a real
 * network call to a real Relay) and stays inert until an operator sets this AND
 * calls the explicit activation entry point. The canonical Bluesky Relay is
 * `bsky.network`.
 */
export const ATPROTO_RELAY_HOST = process.env.ATPROTO_RELAY_HOST?.trim() || undefined;

/** Max records returned by a single `listRecords` page (atproto convention). */
export const LIST_RECORDS_MAX_LIMIT = 100;
/** Default `listRecords` page size when the caller omits `limit`. */
export const LIST_RECORDS_DEFAULT_LIMIT = 50;
