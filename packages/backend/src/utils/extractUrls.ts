import { MAX_POST_LINK_PREVIEWS } from '@mention/shared-types';

/**
 * Extract the http(s)/www URLs from post text, in text order (composer +
 * hydration parity: same regex, same trailing-punctuation trim, same
 * scheme-less `www.` → `https://` normalization as the frontend
 * `utils/extractUrls.ts`).
 *
 * URLs are deduplicated preserving first-occurrence order, matches that are not
 * parseable as a URL are discarded, and the result is capped at `max` (default
 * {@link MAX_POST_LINK_PREVIEWS}) — the number of preview cards a post renders.
 */
export function extractUrls(text: string, max: number = MAX_POST_LINK_PREVIEWS): string[] {
  if (!text || max <= 0) return [];

  const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+)/gi;
  const urls: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = urlPattern.exec(text)) !== null) {
    if (!match[0]) continue;

    let url = match[0];
    while (/[.,!?):;\]]$/.test(url)) {
      url = url.slice(0, -1);
    }
    if (!url) continue;

    if (!/^https?:\/\//i.test(url)) {
      url = `https://${url}`;
    }

    try {
      new URL(url);
    } catch {
      continue;
    }

    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);

    if (urls.length >= max) break;
  }

  return urls;
}
