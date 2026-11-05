import { config } from '../../config';

/**
 * AT Protocol (Bluesky) connector constants.
 *
 * The connector reads: it talks to the public Bluesky AppView for profiles,
 * author feeds (posts, pins and reposts) and feed generators, and resolves
 * identities through PLC / did:web / handle resolution. All host/identity strings
 * and the classification regexes a caller needs to recognise atproto subjects
 * live here.
 */

/**
 * Master gate for the atproto connector: the connector is only instantiated and
 * registered when this is true, mirroring the `FEDERATION_ENABLED` gate for
 * ActivityPub — and, like it, ON by default now that the read/discovery path is
 * rolled out. Set `ATPROTO_ENABLED=false` to close it.
 *
 * `ATPROTO_BRIDGE_ENABLED` is a different question and stays closed by default:
 * this one reads, that one writes.
 */
export const ATPROTO_ENABLED = config.atproto.enabled;

/**
 * Bluesky's public AppView host. Read XRPC queries (`app.bsky.actor.getProfile`,
 * `app.bsky.feed.getAuthorFeed`, `com.atproto.identity.resolveHandle`) hit this
 * fixed, trusted host. Overridable for a self-hosted AppView.
 */
export const PUBLIC_APPVIEW = config.atproto.appViewHost;

/**
 * The PLC directory host that serves `did:plc:` DID documents
 * (`https://plc.directory/<did>`). Overridable for a mirror.
 */
export const PLC_DIRECTORY = config.atproto.plcDirectoryHost;

/** Bluesky's web app origin — the canonical web URL for a post / profile. */
export const BSKY_APP_ORIGIN = 'https://bsky.app';

/**
 * Bluesky's own moderation service. The public AppView applies its labels to
 * every view by default, so a `porn` / `graphic-media` label it put on a post
 * arrives on `postView.labels` beside the author's self-labels.
 */
export const BSKY_MODERATION_LABELER = 'did:plc:ar7c4by46qjdydhdevvrndac';

/** The atproto record collection that holds a feed post. */
export const POST_COLLECTION = 'app.bsky.feed.post';

/** The atproto record collection that holds a starter pack. */
export const STARTER_PACK_COLLECTION = 'app.bsky.graph.starterpack';

/** The atproto record collection that holds a feed generator declaration. */
export const FEED_GENERATOR_COLLECTION = 'app.bsky.feed.generator';

/**
 * A `did:plc:` identifier: the literal prefix followed by 24 base32-sortable
 * characters (lowercase `a-z` + digits `2-7`).
 */
export const DID_PLC_RE = /^did:plc:[a-z2-7]{24}$/;

/** Any supported atproto DID method (`did:plc:` or `did:web:`). */
export const ANY_DID_RE = /^did:(?:plc|web):/;

/**
 * An AT-URI: `at://<authority>/<collection>/<rkey>` where the authority is a DID
 * or a handle, the collection is an NSID, and the rkey is a record key. The
 * collection + rkey are optional so a bare `at://<authority>` also matches.
 */
export const AT_URI_RE =
  /^at:\/\/(did:(?:plc|web):[^/]+|[a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?:\/([a-zA-Z0-9.]+)(?:\/([a-zA-Z0-9._~-]+))?)?$/i;

/** True when `subject` is a supported atproto DID. */
export function isDid(subject: string): boolean {
  return ANY_DID_RE.test(subject);
}

/** True when `subject` is an AT-URI. */
export function isAtUri(subject: string): boolean {
  return AT_URI_RE.test(subject);
}

/**
 * The atproto DID authority of an AT-URI, whether the URI is bare
 * (`at://did:plc:.../app.bsky.feed.post/<rkey>`) or embedded in a larger URL
 * (Bridgy Fed wraps it as `https://bsky.brid.gy/convert/ap/at://<did>/...`).
 *
 * Returns the DID only when the authority is a supported atproto DID; a handle
 * authority (`at://alice.bsky.social/...`) is deliberately rejected, because
 * callers need a STABLE did to derive a deterministic bridged actor URI. Returns
 * undefined when no `at://<did>` appears in the input.
 */
export function didFromAtUri(value: string): string | undefined {
  const did = value.match(/at:\/\/(did:(?:plc|web):[^/\s?#]+)/i)?.[1];
  return did && ANY_DID_RE.test(did) ? did : undefined;
}

/** The handle rule is shared with the frontend (`@mention/shared-types/handle`). */
export { isAtprotoHandle } from '@mention/shared-types/handle';
