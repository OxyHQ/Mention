/**
 * The Apple Podcasts show a link names, if it names one:
 * `https://podcasts.apple.com/<storefront>/podcast/<slug>/id<digits>`. The digits
 * are Apple's collection id for the show. An episode link carries one too, and
 * names the same show. Anything else is not an Apple show: `null`.
 */
export function applePodcastCollectionId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'podcasts.apple.com') {
    return null;
  }
  const match = /\/id(\d{1,15})(?:\/|$)/.exec(parsed.pathname);
  return match?.[1] ?? null;
}
