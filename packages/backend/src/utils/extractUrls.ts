import { MAX_POST_LINK_PREVIEWS } from '@mention/shared-types';
import {
  scanTextEntities,
  toOpenableUrl,
  trimUrlTrailingPunctuation,
} from '@mention/shared-types/textEntities';

/** Only URLs — a `#tag`, `@handle` or `$TICKER` is not a link preview. */
const URL_ONLY = ['url'] as const;

/**
 * Extract the http(s)/www URLs from post text, in text order.
 *
 * Composer + hydration parity is structural rather than maintained by hand: the
 * scan, the trailing-punctuation trim and the scheme-less `www.` → `https://`
 * normalization are the shared ones from `@mention/shared-types/textEntities`,
 * which is what the frontend's `utils/extractUrls.ts` calls too. The two used to
 * carry matching regexes and trim loops copied between them.
 *
 * URLs are deduplicated preserving first-occurrence order, matches that are not
 * parseable as a URL are discarded, and the result is capped at `max` (default
 * {@link MAX_POST_LINK_PREVIEWS}) — the number of preview cards a post renders.
 */
export function extractUrls(text: string, max: number = MAX_POST_LINK_PREVIEWS): string[] {
  if (!text || max <= 0) return [];

  const urls: string[] = [];
  const seen = new Set<string>();

  for (const entity of scanTextEntities(text, { kinds: URL_ONLY })) {
    const { url: trimmed } = trimUrlTrailingPunctuation(entity.value);
    if (!trimmed) continue;

    const url = toOpenableUrl(trimmed);

    // The pattern finds link-SHAPED runs; only the URL parser can say whether
    // one is addressable.
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
