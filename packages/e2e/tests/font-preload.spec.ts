/**
 * The first-paint font is preloaded, and the preload is the request the app uses.
 *
 * Bloom registers `@font-face` from JavaScript, so without the
 * `<link rel="preload">` that `packages/frontend/scripts/web-font-preload.mjs`
 * writes into the exported `index.html`, the font is not discovered until the
 * common chunk has run (~2.7 s into a cold load on mention.earth).
 *
 * A wrong preload does not break anything visible, which is why this is
 * asserted in a browser. If its href or `crossorigin` differs from the
 * `@font-face` request, the browser downloads the font a second time and only
 * logs a console warning. So this checks that each preloaded font is fetched
 * exactly once, by the preload, and that Inter is what the page renders.
 */

import { expect, test } from '../fixtures';

test('cold boot fetches the first-paint font once, through its preload', async ({
  page,
  candidate,
}) => {
  const fontRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.woff2')) fontRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();

  const preloads = await page.locator('head link[rel="preload"][as="font"]').evaluateAll((links) =>
    links.map((link) => ({
      href: (link as HTMLLinkElement).href,
      type: link.getAttribute('type'),
      crossOrigin: (link as HTMLLinkElement).crossOrigin,
    })),
  );
  expect(
    preloads.length,
    'the exported index.html must preload the first-paint font',
  ).toBeGreaterThan(0);

  const loaded = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      interLoaded: [...document.fonts].some(
        (face) => face.family.replace(/"/g, '') === 'Inter' && face.status === 'loaded',
      ),
      fontEntries: performance
        .getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).pathname.endsWith('.woff2'))
        .map((entry) => ({
          url: entry.name,
          initiator: (entry as PerformanceResourceTiming).initiatorType,
        })),
    };
  });
  expect(loaded.interLoaded, 'the page must render Inter').toBe(true);

  for (const preload of preloads) {
    expect(preload.type).toBe('font/woff2');
    expect(
      preload.crossOrigin,
      'fonts are CORS requests; only an anonymous preload is reused',
    ).toBe('anonymous');
    expect(
      fontRequests.filter((url) => url === preload.href),
      `${preload.href} must be requested exactly once; twice means the @font-face URL did not match`,
    ).toHaveLength(1);
    expect(loaded.fontEntries.filter((entry) => entry.url === preload.href)).toEqual([
      { url: preload.href, initiator: 'link' },
    ]);
  }

  expect(candidate.scriptErrors).toEqual([]);
});
