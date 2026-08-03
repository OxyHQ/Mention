/**
 * WHICH URLS NAME A PROFILE, AND WHICH OF THOSE NAME ONE OF OURS.
 *
 * Two subsystems have to agree on this or they contradict each other in front of
 * the same reader: the inbound-federation ingest, which turns a profile link in a
 * remote note into a real mention, and the reading surface, which turns a profile
 * link in a body it is rendering into a mention that is only ever a rendering.
 * The path shapes are the same fact in both places — `https://<us>/@alice` is
 * alice's profile no matter who wrote the URL — so the shapes live here, once,
 * rather than as a second matcher written to look like the first.
 *
 * THE HOST GATE IS THE WHOLE SAFETY PROPERTY, AND IT IS NOT IN THE PATH.
 *
 *   `https://mastodon.social/@bob` and `https://<us>/@bob` have the identical
 *   path. Reading the path alone and calling the result "our user bob" would
 *   render somebody else's account under a handle in OUR namespace — a link that
 *   used to go to bob-on-mastodon quietly becoming a mention of whoever holds
 *   `bob` here. So the two exported functions are deliberately shaped so the gate
 *   cannot be forgotten by accident: {@link localProfilePathHandle} takes a
 *   PATHNAME (a caller holding only a path has already had to decide about the
 *   host somewhere else), and {@link ownProfileUrlHandle} takes a whole URL and
 *   does the gate itself. There is no function here that takes a URL and skips it.
 *
 * NOTHING HERE FETCHES ANYTHING. A URL in a post body is user text; resolving one
 * by dereferencing it would make every rendered post a request to a host of the
 * author's choosing. Every answer in this module is syntactic.
 */

/**
 * Our minted ActivityPub actor URI — `https://<us>/ap/users/<username>`.
 *
 * Anchored at both ends so `/ap/users/alice/followers` is not alice: it is a
 * different document, and a reader who taps it wants the collection, not the
 * profile.
 */
const ACTOR_URI_PATH = /^\/ap\/users\/([^/]+)\/?$/;

/**
 * The human profile page — `https://<us>/@<handle>`.
 *
 * One path segment, which is what makes `/@alice/followers` and `/@alice/media`
 * stay ordinary links. The segment is deliberately `[^/]+` rather than a username
 * character class: our own federated profiles are published at `/@alice@host`,
 * so the `@` inside the segment is part of the handle, and any narrower class
 * would silently drop the federated half of our own namespace.
 */
const PROFILE_PAGE_PATH = /^\/@([^/]+)\/?$/;

/**
 * The Mastodon/Pleroma actor URI — `https://<host>/users/<user-or-opaque-id>`.
 *
 * The Misskey family keys this by an opaque id rather than a username, which is
 * why the segment is not read as a handle anywhere: it is a lookup key for a
 * stored actor, and only ever meaningful on somebody else's host. OUR profiles
 * are published at `/@name` and `/ap/users/name` — a `/users/name` URL on our own
 * host is not one of ours, and must not be resolved as if it were.
 */
const REMOTE_ACTOR_URI_PATH = /^\/users\/([^/]+)\/?$/;

/**
 * The RAW path segment a URL names IF the URL has one of the two shapes every
 * fediverse server publishes a profile at, with NO opinion about who served it.
 *
 * Both shapes are emitted from one place because two subsystems key stored actors
 * off them — the inbound ingest and the write-time fold — and a candidate gate
 * that admitted a shape the resolver does not, or vice versa, would make a
 * composer announce a mention the write boundary will not store (or stay silent
 * about one it will). Verbatim, not decoded: the caller decides, since an `acct`
 * is matched decoded while a stored `uri` is matched as written.
 */
export function fediverseProfilePathSegment(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  return (
    PROFILE_PAGE_PATH.exec(parsed.pathname)?.[1] ?? REMOTE_ACTOR_URI_PATH.exec(parsed.pathname)?.[1]
  );
}

/**
 * True when a URL could name a user AT ALL — the gate for treating it as a
 * mention candidate rather than as an ordinary link.
 *
 * The two clauses are the two ways an identity can be found: a stored actor's
 * profile shape on any host, or a profile on one of OUR hosts (which resolves
 * through Oxy instead). Purely syntactic and I/O-free, so a composer can run it
 * on every keystroke and the write boundary can run it before spending a lookup
 * — and, being ONE function, the two cannot disagree about which links compete
 * for the per-body budget.
 *
 * `ownHosts` is the caller's own notion of "us", for the same reason
 * {@link ownProfileUrlHandle} takes it: the app's web base URL on the client, the
 * federation domains plus the identity apex on the server.
 */
export function isProfileLikeUrl(url: string, ownHosts: readonly string[]): boolean {
  return (
    fediverseProfilePathSegment(url) !== undefined
    || ownProfileUrlHandle(url, ownHosts) !== undefined
  );
}

/**
 * The handle a profile URL's PATH names, with NO opinion about who served it.
 *
 * The caller MUST have already established that the host is ours — see the host-
 * gate note at the top of this file. The inbound-federation path is the caller
 * this exists for: it establishes that separately and much more broadly (its own
 * domains AND the Oxy identity apex, via the federation domain policy), so it
 * cannot use {@link ownProfileUrlHandle}'s narrower list.
 *
 * Returns the segment VERBATIM — not percent-decoded, not lowercased. That is
 * what the federation path has always fed to the Oxy username resolver, and
 * changing it here would change which accounts that path resolves.
 */
export function localProfilePathHandle(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const actorMatch = ACTOR_URI_PATH.exec(pathname);
  if (actorMatch) return actorMatch[1];
  const profileMatch = PROFILE_PAGE_PATH.exec(pathname);
  if (profileMatch) return profileMatch[1];
  return undefined;
}

/** A leading `www.` is not part of a host's identity. Both sides drop it. */
function canonicalHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, '');
}

/**
 * A handle character that would make the handle unusable as a profile
 * destination. `getNormalizedUserHandle` in `@oxyhq/core` — the one helper every
 * profile route in the app goes through — rejects a handle containing any of
 * these, so producing one here would yield a "mention" that renders as inert
 * coloured text where a working link used to be. Better to leave it a link.
 */
const ROUTE_HOSTILE_HANDLE = /[/?#]/;

/**
 * The handle a URL names IF the URL points at a profile on one of OUR OWN hosts,
 * otherwise `undefined`.
 *
 * `hosts` is the instance's public web origin(s) — for the app, the host of its
 * configured web base URL. It is a parameter rather than a constant because this
 * module ships to both sides of the wire and neither one's notion of "us" belongs
 * in a shared package: the value comes from the caller's own configuration, so a
 * staging origin recognises staging's links and not production's.
 *
 * Unlike {@link localProfilePathHandle} the segment IS percent-decoded, because
 * the answer here is rendered to a reader (`@café`, not `@caf%C3%A9`) and routed
 * on. A segment that does not decode, decodes to nothing, or decodes to something
 * no profile route accepts yields `undefined` — the URL stays a URL.
 */
export function ownProfileUrlHandle(
  url: string,
  hosts: readonly string[],
): string | undefined {
  if (hosts.length === 0) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;

  const host = canonicalHost(parsed.hostname);
  if (!hosts.some((candidate) => canonicalHost(candidate) === host)) return undefined;

  const segment = localProfilePathHandle(url);
  if (segment === undefined) return undefined;

  let handle: string;
  try {
    handle = decodeURIComponent(segment);
  } catch {
    return undefined;
  }

  handle = handle.replace(/^@+/, '').trim();
  if (!handle || ROUTE_HOSTILE_HANDLE.test(handle)) return undefined;
  return handle;
}
