/**
 * Every layout chunk the cold boot needs is preloaded, and nothing else is.
 *
 * The root, `(app)` and `(app)/(tabs)` layouts load on every URL, and only
 * the startup JavaScript names them, so without the `<link rel="preload">` tags
 * that `packages/frontend/scripts/web-layout-preload.mjs` writes into the
 * exported `index.html` they are a second round trip after the whole common
 * chunk.
 *
 * A wrong preload breaks nothing visible, which is why this runs in a browser:
 * one that does not match the async loader's request (a different URL, or a CORS
 * mode the plain `<script src>` does not use) is downloaded a second time, and a
 * layout the scan missed simply goes back to waiting. So: the page requests
 * exactly the preloaded layouts, each one once, and through its preload.
 */

import { expect, test } from '../fixtures';

const LAYOUT_CHUNK = /\/_expo\/static\/js\/web\/_layout-[0-9a-f]{32}\.js$/;

test('cold boot fetches every layout chunk once, through its preload', async ({
  page,
  candidate,
}) => {
  const layoutRequests: string[] = [];
  page.on('request', (request) => {
    if (LAYOUT_CHUNK.test(new URL(request.url()).pathname)) layoutRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();

  const preloads = await page
    .locator('head link[rel="preload"][as="script"][data-route-layout]')
    .evaluateAll((links) =>
      links.map((link) => ({
        href: (link as HTMLLinkElement).href,
        crossOrigin: (link as HTMLLinkElement).crossOrigin,
      })),
    );
  expect(preloads.length, 'the exported index.html must preload the layout chunks').toBeGreaterThan(
    0,
  );

  const entries = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .filter((entry) => /\/_layout-[0-9a-f]{32}\.js$/.test(new URL(entry.name).pathname))
      .map((entry) => ({
        url: entry.name,
        initiator: (entry as PerformanceResourceTiming).initiatorType,
      })),
  );

  expect(
    [...new Set(layoutRequests)].sort(),
    'the page must request exactly the preloaded layouts',
  ).toEqual(preloads.map((preload) => preload.href).sort());
  for (const preload of preloads) {
    expect(
      preload.crossOrigin,
      'the async loader injects a plain <script src>; only a no-cors preload is reused',
    ).toBeNull();
    expect(
      layoutRequests.filter((url) => url === preload.href),
      `${preload.href} must be requested exactly once; twice means the preload was not reused`,
    ).toHaveLength(1);
    expect(entries.filter((entry) => entry.url === preload.href)).toEqual([
      { url: preload.href, initiator: 'link' },
    ]);
  }

  expect(candidate.scriptErrors).toEqual([]);
});
