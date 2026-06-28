import {
  normalizeProfileLinks,
  type ProfileLink,
  type ProfileLinkMetadata,
} from '@oxyhq/core';
import { extractUrls } from './extractUrls';
import { prettifyUrl } from './prettifyUrl';

/**
 * Comparison key for deduping links: scheme (`http(s)://`), a leading `www.`, and
 * a trailing slash stripped (via `prettifyUrl`), lowercased. So `https://x.com/`,
 * `http://www.x.com`, and `X.com` all collapse to the same key.
 */
function normalizedKey(url: string): string {
  return prettifyUrl(url).toLowerCase();
}

/**
 * Merges URLs found in the profile bio into the explicit profile-link set so the
 * `LinkSummary` row and sheet show both. Explicit links come first (keeping their
 * title/description/image metadata); bio-only URLs are appended in bio order.
 * Dedup is by normalized URL and explicit links always win.
 */
export function mergeBioAndProfileLinks(
  linksMetadata?: ProfileLinkMetadata[],
  links?: string[],
  bioText?: string,
): ProfileLink[] {
  const explicit = normalizeProfileLinks(linksMetadata, links);
  if (!bioText) return explicit;

  const seen = new Set(explicit.map((link) => normalizedKey(link.url)));
  const merged: ProfileLink[] = [...explicit];

  let bioIndex = 0;
  for (const url of extractUrls(bioText)) {
    const key = normalizedKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ id: `bio-${bioIndex}`, url });
    bioIndex += 1;
  }

  return merged;
}
