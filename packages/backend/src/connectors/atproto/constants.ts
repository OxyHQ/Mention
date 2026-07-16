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
export const ATPROTO_ENABLED = process.env.ATPROTO_ENABLED === 'true';

/**
 * Bluesky's public AppView host. Read XRPC queries (`app.bsky.actor.getProfile`,
 * `app.bsky.feed.getAuthorFeed`, `com.atproto.identity.resolveHandle`) hit this
 * fixed, trusted host. Overridable for a self-hosted AppView.
 */
export const PUBLIC_APPVIEW = process.env.ATPROTO_APPVIEW || 'public.api.bsky.app';

/**
 * The PLC directory host that serves `did:plc:` DID documents
 * (`https://plc.directory/<did>`). Overridable for a mirror.
 */
export const PLC_DIRECTORY = process.env.ATPROTO_PLC_DIRECTORY || 'plc.directory';

/** Bluesky's web app origin — the canonical web URL for a post / profile. */
export const BSKY_APP_ORIGIN = 'https://bsky.app';

/** The atproto record collection that holds a feed post. */
export const POST_COLLECTION = 'app.bsky.feed.post';

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
