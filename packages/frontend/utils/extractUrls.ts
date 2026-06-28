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
 * Extracts cleaned, openable URLs from free text. Matches http(s) URLs and bare
 * `www.` forms, strips trailing punctuation, and normalizes scheme-less matches
 * to an `https://` form. Does NOT match `#`/`@`/`$` entities.
 */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const pattern = new RegExp(URL_PATTERN_SOURCE, 'g');
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const { url } = trimUrlTrailingPunct(match[0]);
    if (url) urls.push(toOpenableUrl(url));
  }
  return urls;
}
