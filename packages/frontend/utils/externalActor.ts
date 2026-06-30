/**
 * Frontend classifier for cross-network search queries.
 *
 * Mirrors the backend `classifyQuery` (`packages/backend/src/connectors/resolve.ts`)
 * and the connector `matches()` shapes so the search box only fires a
 * `GET /federation/resolve` request when a query actually looks like a REMOTE
 * actor — never for a bare local `@username`, which the existing Oxy people
 * search already handles. Keeping this purely client-side avoids a network round
 * trip on every keystroke for local queries.
 *
 * Recognized remote shapes:
 *  - `@user@host` / bare `user@domain`              → ActivityPub (Mastodon, …)
 *  - `user.bsky.social` / any bare DNS handle       → atproto (Bluesky)
 *  - `did:plc:…` / `did:web:…`                       → atproto
 *  - `at://…`                                        → atproto
 */

/** A `did:plc:` or `did:web:` identifier. */
const DID_RE = /^did:(?:plc|web):/;

/** An `at://<authority>[/<collection>[/<rkey>]]` AT-URI. */
const AT_URI_RE =
  /^at:\/\/(did:(?:plc|web):[^/]+|[a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?:\/([a-zA-Z0-9.]+)(?:\/([a-zA-Z0-9._~-]+))?)?$/i;

/** A bare DNS handle (≥2 labels, alphabetic TLD): `alice.bsky.social`, `example.com`. */
const HANDLE_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** True when `query` is a fediverse `user@host` acct (with or without a leading `@`). */
function isFediverseAcct(query: string): boolean {
  const cleaned = query.replace(/^@/, '');
  const at = cleaned.indexOf('@');
  if (at <= 0 || at === cleaned.length - 1) return false;
  const domain = cleaned.slice(at + 1);
  // The domain part must itself be a DNS name (≥2 labels) so a single trailing
  // `@x` typo never resolves as an acct.
  return HANDLE_RE.test(domain);
}

/** True when `query` is a bare atproto handle (a DNS name, no `@`, no scheme). */
function isAtprotoHandle(query: string): boolean {
  if (query.includes('@') || query.includes('://') || query.includes(' ')) return false;
  return HANDLE_RE.test(query);
}

/**
 * Whether a raw search query looks like a REMOTE actor handle the connectors can
 * resolve. Only these queries are sent to `GET /federation/resolve`; a local
 * `@username` / `username` returns false and stays on the existing people search.
 */
export function looksLikeRemoteHandle(raw: string): boolean {
  const query = raw.trim();
  if (!query) return false;
  if (DID_RE.test(query) || AT_URI_RE.test(query)) return true;
  if (isFediverseAcct(query)) return true;
  return isAtprotoHandle(query);
}
