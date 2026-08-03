/**
 * URL extraction for the composer's link-preview cards and the profile
 * `LinkSummary`.
 *
 * What counts as a URL, where the run ends, and which trailing punctuation
 * belongs to the sentence rather than the link all come from
 * `@mention/shared-types/textEntities` — the same scan the renderer, the backend
 * extractor and the outbound-federation linkifier use, so a link that gets a
 * preview card is the same run of characters that gets linkified. This module
 * holds only what is specific to the composer: dedup, and removing one link from
 * the text.
 */

import {
  scanTextEntities,
  toOpenableUrl,
  trimUrlTrailingPunctuation,
} from '@mention/shared-types/textEntities';

/** Only URLs — a `#tag`, `@handle` or `$TICKER` is not a link preview. */
const URL_ONLY = ['url'] as const;

/**
 * Extracts cleaned, openable URLs from free text, in text order and DEDUPLICATED.
 * Matches http(s) URLs and bare `www.` forms, strips trailing punctuation, and
 * normalizes scheme-less matches to an `https://` form.
 *
 * Deduplication is by the normalized URL: callers key UI off these values (the
 * composer gives each detected link its own carousel key), so the same link
 * written twice must not yield two identical keys.
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];

  const urls = new Set<string>();
  for (const entity of scanTextEntities(text, { kinds: URL_ONLY })) {
    const { url } = trimUrlTrailingPunctuation(entity.value);
    if (url) urls.add(toOpenableUrl(url));
  }
  return Array.from(urls);
}

/**
 * Deletes every occurrence of `url` from `text`, leaving the other links intact —
 * the composer removes a single link-preview card without touching the rest.
 *
 * Detection and removal MUST agree on what counts as a URL, so this locates the
 * links with the same scan that produced the value in the first place —
 * otherwise a bare `www.x.com` in the text would never match its openable
 * `https://www.x.com` form and removal would silently no-op.
 *
 * Applied right-to-left so an earlier splice cannot shift the offsets of the
 * matches not yet applied. The horizontal whitespace preceding the URL goes with
 * it, so removing a link mid-sentence does not strand a gap; punctuation that
 * merely trailed it (`…example.com.`) is kept, as that belongs to the sentence,
 * not the link. Line breaks are never consumed — they are layout the author
 * wrote.
 */
export function removeUrlFromText(text: string, url: string): string {
  if (!text) return text;

  const matches = scanTextEntities(text, { kinds: URL_ONLY })
    .map((entity) => ({ entity, cleaned: trimUrlTrailingPunctuation(entity.value).url }))
    .filter(({ cleaned }) => cleaned !== '' && toOpenableUrl(cleaned) === url);

  let stripped = text;
  for (const { entity, cleaned } of matches.reverse()) {
    let start = entity.start;
    while (start > 0 && (text[start - 1] === ' ' || text[start - 1] === '\t')) start -= 1;
    stripped = stripped.slice(0, start) + stripped.slice(entity.start + cleaned.length);
  }

  return stripped.replace(/[^\S\r\n]{2,}/g, ' ').trim();
}
