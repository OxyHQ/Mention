import { config } from '../../config';

/**
 * AT Protocol (Bluesky) connector constants.
 *
 * Read/discovery only (Phase C2): the connector talks to the public Bluesky
 * AppView for profiles/feeds and resolves identities through PLC / did:web /
 * handle resolution. All host/identity strings and the classification regexes a
 * caller needs to recognise atproto subjects live here.
 */

/**
 * Master gate for the atproto connector. OFF by default — the connector is only
 * instantiated and registered when `ATPROTO_ENABLED === 'true'`, mirroring the
 * `FEDERATION_ENABLED` gate for ActivityPub but defaulting closed because the
 * read/discovery path is still being rolled out.
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

/**
 * A `did:web:` identifier: the prefix followed by a percent-encoded host
 * (optionally `:`-separated path segments, with `%3A` encoding a port).
 */
export const DID_WEB_RE = /^did:web:[a-zA-Z0-9._%-]+(?::[a-zA-Z0-9._%-]+)*$/;

/** Any supported atproto DID method (`did:plc:` or `did:web:`). */
export const ANY_DID_RE = /^did:(?:plc|web):/;

/**
 * An AT-URI: `at://<authority>/<collection>/<rkey>` where the authority is a DID
 * or a handle, the collection is an NSID, and the rkey is a record key. The
 * collection + rkey are optional so a bare `at://<authority>` also matches.
 */
export const AT_URI_RE =
  /^at:\/\/(did:(?:plc|web):[^/]+|[a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?:\/([a-zA-Z0-9.]+)(?:\/([a-zA-Z0-9._~-]+))?)?$/i;

/**
 * An atproto handle: a DNS domain name (≥2 labels, e.g. `alice.bsky.social` or a
 * custom domain `example.com`). Deliberately excludes anything containing `@`
 * (that is a fediverse `user@host` acct, owned by the ActivityPub connector) or a
 * URL scheme. The TLD label must be alphabetic so a bare IP / numeric form never
 * matches.
 */
export const HANDLE_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * The literal handle an AppView serves when a handle's bidirectional
 * DNS/DID verification FAILS.
 *
 * It is an ERROR STRING, not an identity: every account whose handle cannot be
 * verified gets the same one, so it is the single value in the whole atproto
 * namespace that is guaranteed NOT to be unique. Keying an actor on it collapses
 * every such account onto one identity — in Mongo that silently produced 21 rows
 * sharing `acct: 'handle.invalid'`, and against `federated_actors_acct_key` it
 * refuses every account after the first. Use {@link isUnresolvedAtprotoHandle}
 * and fall back to the DID, which is the stable identifier atproto actually
 * guarantees.
 */
export const UNRESOLVED_HANDLE = 'handle.invalid';

/**
 * True when a handle is the unresolved-handle sentinel rather than a real one.
 *
 * Compared case-insensitively on the trimmed value: the sentinel arrives in the
 * same `handle` field as a real handle, which is DNS and therefore already
 * case-insensitive, so a check that only matched the exact lower-case spelling
 * would be a narrower question than the one being asked.
 */
export function isUnresolvedAtprotoHandle(handle: string): boolean {
  return handle.trim().toLowerCase() === UNRESOLVED_HANDLE;
}

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

/**
 * True when `subject` looks like an atproto handle (a bare DNS name with no `@`
 * and no URL scheme). `*.bsky.social` and any other registrable domain qualify.
 */
export function isAtprotoHandle(subject: string): boolean {
  if (subject.includes('@') || subject.includes('://') || subject.includes(' ')) return false;
  return HANDLE_RE.test(subject);
}
