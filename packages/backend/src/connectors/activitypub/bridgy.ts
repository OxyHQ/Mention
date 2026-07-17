/**
 * Bridgy Fed (brid.gy) — deterministic identity derivation for INBOUND bridged
 * atproto (Bluesky) content.
 *
 * Bridgy Fed is an ActivityPub bridge: a Bluesky user is represented to the
 * fediverse at a DETERMINISTIC actor URI derived from the user's atproto DID —
 * `https://bsky.brid.gy/ap/<did>` — and a Bluesky post's AT-URI is wrapped as the
 * AP object URL `https://bsky.brid.gy/convert/ap/at://<did>/app.bsky.feed.post/<rkey>`.
 *
 * A cohort of LEGACY orphan posts stored only that object URL
 * (`federation.url` / `federation.activityId`) and never the author's
 * `federation.actorUri`. Because the actor URI is a pure function of the DID
 * embedded in the object URL, it can be RECOVERED with NO network round trip —
 * which is exactly what hydration needs to resolve such an orphan's real author.
 */

import { ANY_DID_RE, BSKY_APP_ORIGIN, didFromAtUri } from '../atproto/constants';

/** Bridgy Fed's Bluesky↔fediverse bridge host (where the `/ap/<did>` scheme lives). */
const BRIDGY_FED_BSKY_HOST = 'bsky.brid.gy';

/**
 * Derive the canonical Bridgy Fed ActivityPub actor URI
 * (`https://bsky.brid.gy/ap/<did>`) for a bridged Bluesky post, given the post's
 * federation object URLs (`activityId` and/or `url`, tried in order).
 *
 * Returns undefined unless a candidate is a `bsky.brid.gy`-hosted URL carrying an
 * atproto DID — a non-brid.gy URL, or one with no `at://<did>`, is left for the
 * caller to degrade gracefully. Pure and synchronous.
 */
export function deriveBridgyActorUri(...candidateUrls: Array<string | undefined>): string | undefined {
  for (const candidate of candidateUrls) {
    if (!candidate) continue;
    let host: string;
    try {
      host = new URL(candidate).host.toLowerCase();
    } catch {
      continue;
    }
    if (host !== BRIDGY_FED_BSKY_HOST) continue;
    const did = didFromAtUri(candidate);
    if (did) return `https://${BRIDGY_FED_BSKY_HOST}/ap/${did}`;
  }
  return undefined;
}

/**
 * The atproto DID of a Bridgy Fed actor URI (`https://bsky.brid.gy/ap/<did>`) —
 * the inverse of {@link deriveBridgyActorUri}. Returns undefined for any
 * non-brid.gy URL or one whose path is not exactly `/ap/<did>`. Pure and
 * synchronous; used to recognise a bridged mention and derive its Bluesky web
 * profile URL.
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

/**
 * The in-content profile-anchor hrefs a Bridgy Fed (brid.gy) @mention can use.
 *
 * Bridgy's `Mention` tag carries the bridged actor URI
 * (`https://bsky.brid.gy/ap/<did>`) as `href` and `@<handle>@bsky.brid.gy` as
 * `name`, but the anchor INSIDE the content points at the Bluesky WEB profile —
 * `https://bsky.app/profile/<did>` OR `https://bsky.app/profile/<handle>` — which
 * matches neither the actor URI nor the reconstructed `https://bsky.brid.gy/@<handle>`
 * profile URL the generic mention resolver derives. Emitting both bsky.app forms
 * as extra anchor candidates lets a bridged mention resolve to the internal
 * `[mention:<id>]` placeholder exactly like a Mastodon mention does. Returns `[]`
 * for a non-brid.gy tag (zero cost). Pure and synchronous.
 */
export function bridgedMentionAnchorHrefs(tag: { href: string; name?: string }): string[] {
  const did = didFromBridgyActorUri(tag.href);
  if (!did) return [];
  const hrefs = [`${BSKY_APP_ORIGIN}/profile/${did}`];

  // `name` is `@<handle>@bsky.brid.gy`; the handle is everything between the
  // leading `@` and the trailing `@<domain>` (a Bluesky handle has no `@`).
  const cleaned = (tag.name ?? '').replace(/^@+/, '');
  const lastAt = cleaned.lastIndexOf('@');
  const handle = lastAt > 0 ? cleaned.slice(0, lastAt) : '';
  if (handle) hrefs.push(`${BSKY_APP_ORIGIN}/profile/${handle}`);

  return hrefs;
}
