/**
 * The image the server named as a page's largest contentful paint.
 *
 * A public post page's document preloads its first image
 * (`<link rel="preload" as="image" fetchpriority="high" data-mention-lcp>`, the
 * web shell), at exactly the URL the media card requests. The card that
 * renders that URL loads it eagerly at high priority instead of expo-image's
 * default `loading="lazy"`, which held the post's own image back until layout
 * — measured as the LCP element at 16 s on mobile (2026-11-28).
 *
 * Read once per document; every other image keeps its lazy default.
 */
let preloaded: string | null | undefined;

function readPreloaded(): string | null {
  if (typeof document === 'undefined') return null;
  const link = document.querySelector<HTMLLinkElement>(
    'link[rel="preload"][as="image"][data-mention-lcp]',
  );
  return link?.getAttribute('href') ?? null;
}

/** Whether `src` is the image the server preloaded as this page's LCP. */
export function isPreloadedLcpImage(src: string): boolean {
  if (preloaded === undefined) preloaded = readPreloaded();
  return preloaded !== null && preloaded === src;
}

/** Tests only: forget what was read. */
export function resetPreloadedLcpImageForTests(): void {
  preloaded = undefined;
}
