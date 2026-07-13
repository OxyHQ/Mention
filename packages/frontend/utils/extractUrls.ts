/**
 * Shared URL-detection helpers. The plain-URL regex and trailing-punctuation
 * trimming used to live inline in `components/common/LinkifiedText.tsx`; they are
 * centralized here so the URL parsing lives in ONE place and the profile
 * `LinkSummary` (which merges bio URLs) and `LinkifiedText` cannot diverge.
 */

/**
 * Regex SOURCE for the URL alternative — http(s) URLs and bare `www.` forms.
 * Kept as a string so it can be embedded into larger combined patterns (e.g.
 * `LinkifiedText`'s mention/hashtag/cashtag matcher) without duplicating it.
 */
export const URL_PATTERN_SOURCE = 'https?:\\/\\/[^\\s]+|www\\.[^\\s]+';

/**
 * Strips trailing punctuation (`. , ! ? ) : ; ]`) from a matched URL, returning
 * the cleaned URL and the stripped trailing characters separately so callers can
 * render the trailing punctuation as plain text.
 */
export function trimUrlTrailingPunct(raw: string): { url: string; trailing: string } {
  let url = raw;
  let trailing = '';
  while (/[.,!?):;\]]$/.test(url)) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

/**
 * Normalizes a matched URL to an openable form by prefixing `https://` when it
 * has no scheme (e.g. a bare `www.example.com` match).
 */
export function toOpenableUrl(url: string): string {
  return url.startsWith('http') ? url : `https://${url}`;
}

/**
 * Extracts cleaned, openable URLs from free text, in text order and DEDUPLICATED.
 * Matches http(s) URLs and bare `www.` forms, strips trailing punctuation, and
 * normalizes scheme-less matches to an `https://` form. Does NOT match `#`/`@`/`$`
 * entities.
 *
 * Deduplication is by the normalized URL: callers key UI off these values (the
 * composer gives each detected link its own carousel key), so the same link
 * written twice must not yield two identical keys.
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const pattern = new RegExp(URL_PATTERN_SOURCE, 'g');
  const urls = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const { url } = trimUrlTrailingPunct(match[0]);
    if (url) urls.add(toOpenableUrl(url));
  }
  return Array.from(urls);
}

/**
 * Deletes every occurrence of `url` from `text`, leaving the other links intact —
 * the composer removes a single link-preview card without touching the rest.
 *
 * Detection and removal MUST agree on what counts as a URL, so this matches with
 * the same {@link URL_PATTERN_SOURCE} / {@link trimUrlTrailingPunct} /
 * {@link toOpenableUrl} pipeline that produced the value in the first place —
 * otherwise a bare `www.x.com` in the text would never match its openable
 * `https://www.x.com` form and removal would silently no-op.
 *
 * The spaces preceding the URL go with it, so removing a link mid-sentence does
 * not strand a gap; punctuation that merely trailed it (`…example.com.`) is kept,
 * as that belongs to the sentence, not the link. Line breaks are never collapsed.
 */
export function removeUrlFromText(text: string, url: string): string {
  const pattern = new RegExp(`([^\\S\\r\\n]*)(${URL_PATTERN_SOURCE})`, 'g');
  const stripped = text.replace(pattern, (match: string, spacing: string, rawUrl: string) => {
    const { url: cleaned } = trimUrlTrailingPunct(rawUrl);
    if (!cleaned || toOpenableUrl(cleaned) !== url) return match;
    // Give back whatever trailed the URL but was not part of it.
    return match.slice(spacing.length + cleaned.length);
  });
  return stripped.replace(/[^\S\r\n]{2,}/g, ' ').trim();
}
