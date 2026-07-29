/**
 * Flow 2 — client-side navigation across code-split routes.
 *
 * expo-router splits every web route into its own hashed async chunk, and
 * `packages/frontend/lib/chunkReload.web.ts` exists precisely because that split
 * has a production failure mode: after a deploy the already-loaded bundle asks
 * for chunk hashes the host no longer has, the host answers `index.html` with
 * `text/html`, and Metro's async require rejects. The recovery is a full page
 * reload — so the symptom of a broken chunk is not an exception anybody sees, it
 * is a silent reload. Nothing else in the repo covers this surface: it is
 * web-only, so no test on the native path can reach it.
 *
 * The marker below is what makes that observable. It is written after the first
 * document load and read at the end: it survives client-side route transitions
 * and is destroyed by any document load, so it fails both when a transition was
 * not client-side at all and when the stale-chunk recovery reload fired.
 */

import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';

declare global {
  interface Window {
    /** Written once, after the first document load. Any reload destroys it. */
    __mentionE2eDocumentMarker?: string;
  }
}

const DOCUMENT_MARKER = 'home';

test('routes navigate client-side without a recovery reload', async ({ page, candidate }) => {
  await page.goto('/');
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();

  await page.evaluate((marker) => {
    window.__mentionE2eDocumentMarker = marker;
  }, DOCUMENT_MARKER);

  // The persistent sidebar navigates with an imperative `router.navigate` on a
  // Pressable rather than an anchor (`SideBarItem`), so this is a real in-app
  // transition and not a browser-level link follow.
  await page.getByText('Explore', { exact: true }).click();
  await expect(page).toHaveURL(`${APP_ORIGIN}/explore`);

  const exploreRow = page.locator('[data-post-uri]').first();
  await expect(exploreRow).toBeVisible();

  // Activate the post card through the keyboard rather than a click. A click
  // lands on whatever occupies the row's centre — usually a media attachment,
  // which opens a lightbox instead of navigating — so a mouse gesture would
  // have to hard-code a safe offset and would silently start testing the wrong
  // thing the next time a post's layout changes. The card is the row's first
  // focusable labelled element (`PostItem` puts `accessibilityLabel` and the
  // press handler on the same Pressable), and driving it this way also asserts
  // that a post stays reachable without a pointer.
  await exploreRow.locator('[aria-label][tabindex="0"]').first().focus();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/p\/[^/]+$/);
  // The post's own action bar: proof the detail route's chunk loaded and
  // painted the post, not merely that the URL changed.
  await expect(page.getByLabel('Reply', { exact: true }).first()).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(`${APP_ORIGIN}/explore`);
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();

  expect(await page.evaluate(() => window.__mentionE2eDocumentMarker)).toBe(DOCUMENT_MARKER);
  expect(candidate.scriptErrors).toEqual([]);
});
