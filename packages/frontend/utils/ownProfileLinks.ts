/**
 * WHICH URLS NAME A PROFILE ON THIS INSTANCE — the app's single answer.
 *
 * Three surfaces need it and they are halves of one behaviour, so they cannot be
 * allowed to disagree about a URL:
 *   - the reading surface re-labels such a URL as a mention (`./linkifyPattern`);
 *   - the composer withholds the link-preview card for it (`hooks/useLinkDetection`),
 *     matching hydration, which withholds the card server-side for exactly the
 *     same URLs (`PostHydrationService.ownProfileLinkUrls`);
 *   - the composer resolves it and says who the post will mention
 *     (`./composerProfileLinks`).
 *
 * If the three derived the host list separately, a URL could become a mention in
 * one and stay a link in another — a mention with a redundant card under it, or a
 * card in the composer for a link that publishes without one.
 *
 * Purely syntactic, and deliberately so: nothing here fetches the URL. Whether we
 * hold the account it names is a different question, answered against stored
 * identities at the write boundary — see `./composerProfileLinks`.
 */

import { ownProfileUrlHandle } from '@mention/shared-types/profileUrls';
import { toOpenableUrl } from '@mention/shared-types/textEntities';
import { WEB_BASE_URL } from '@/config';

/**
 * This instance's own public web host — the one whose `/@alice` URLs name a user
 * in OUR namespace rather than somebody else's.
 *
 * Read from the configured web base URL, the same constant share links are built
 * from, so a staging build recognises staging's own links and not production's.
 * A base URL that does not parse yields no hosts at all, which turns every
 * conversion below off rather than guessing — a misconfigured origin should leave
 * links as links, not mint mentions against a host nobody declared.
 */
export const OWN_PROFILE_HOSTS: readonly string[] = (() => {
  try {
    return [new URL(WEB_BASE_URL).hostname];
  } catch {
    return [];
  }
})();

/**
 * The handle a URL names if it points at a profile on this instance, else
 * `undefined`.
 *
 * `toOpenableUrl` supplies the scheme a bare `www.` form omits, so a pasted
 * `www.<us>/@alice` is recognised as the same thing as the full form; it is
 * idempotent, so passing an already-normalized URL is safe. Callers that need the
 * URL's LENGTH (to bound a span in the text) must trim trailing prose punctuation
 * themselves and pass the trimmed value — this function has no span to report.
 */
export function ownProfileLinkHandle(url: string): string | undefined {
  return ownProfileUrlHandle(toOpenableUrl(url), OWN_PROFILE_HOSTS);
}
