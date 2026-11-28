import { normalizeFederatedAcct } from './activitypub/helpers';
import { isAtUri, isAtprotoHandle, isDid } from './atproto/constants';

/**
 * Network classification for a unified cross-network resolve.
 *
 * Maps a raw search query to the network that owns it WITHOUT touching the
 * network (pure, synchronous). The `/federation/resolve` route uses this to
 * short-circuit local Oxy handles and to know which family a subject belongs to;
 * the actual fetch is dispatched through the connector registry (whose
 * `connectorFor` uses each connector's `matches`).
 *
 *  - `@user@host` / bare `user@domain`               → activitypub
 *  - `*.bsky.social` / bare domain / did:* / at://    → atproto
 *  - `@username` / bare local username                → local (Oxy profile)
 */
export type QueryNetwork = 'activitypub' | 'atproto' | 'local';

/** Classify a resolve query into the network that owns it. */
export function classifyQuery(raw: string): QueryNetwork {
  const query = raw.trim();
  if (!query) return 'local';

  // atproto: a DID or an AT-URI is unambiguous.
  if (isDid(query) || isAtUri(query)) return 'atproto';

  // ActivityPub: a fediverse `user@host` acct (with or without a leading `@`).
  if (normalizeFederatedAcct(query)) return 'activitypub';

  // atproto: a bare handle is a DNS name (≥2 labels, no `@`, no scheme).
  if (isAtprotoHandle(query)) return 'atproto';

  // Everything else (`@alice`, `alice`) is a local Oxy username.
  return 'local';
}
