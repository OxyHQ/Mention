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

import { didFromAtUri } from '../atproto/constants';

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
