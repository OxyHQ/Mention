/**
 * Flow 3 — a local profile URL, in both of the shapes the outside world asks
 * for it.
 *
 * `packages/backend/src/routes/webShell.routes.ts` serves one URL two ways: a
 * browser gets the OG-injected SPA shell, and a request that `Accept`s
 * ActivityPub is 302-redirected to the canonical actor. Mastodon resolves a
 * pasted profile URL through exactly that second path.
 *
 * Its failure mode is the reason this is worth a gate rather than a curl in the
 * existing smoke script: when the negotiation breaks, the profile keeps
 * rendering perfectly in a browser and nothing looks wrong, while every
 * fediverse discovery-by-URL silently stops working. Only asserting both halves
 * of the same URL catches it.
 */

import { API_ORIGIN, APP_ORIGIN, PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';

test('a local profile URL renders as a page', async ({ page, candidate }) => {
  await page.goto(`/@${PROFILE_HANDLE}`);

  // The profile screen only mounts `<SEO>` once the profile has actually
  // resolved, so the document title is a real readiness condition rather than a
  // string that exists from the first byte.
  await expect(page).toHaveTitle(new RegExp(`\\(@${PROFILE_HANDLE}\\)`));

  expect(candidate.scriptErrors).toEqual([]);
});

// Deliberately does not take the `candidate` fixture: content negotiation is
// served by the backend for the live origin and has nothing to do with which
// frontend bundle is deployed, so routing this request at the candidate would
// test nothing.
test('a local profile URL negotiates ActivityPub to the canonical actor', async ({ request }) => {
  const response = await request.get(`${APP_ORIGIN}/@${PROFILE_HANDLE}`, {
    headers: { Accept: 'application/activity+json' },
    maxRedirects: 0,
  });

  expect(response.status()).toBe(302);
  expect(response.headers()['location']).toBe(`${API_ORIGIN}/ap/users/${PROFILE_HANDLE}`);
});
