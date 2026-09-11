/**
 * Flow — a bridge TRANSPORT acct is not a public Mention profile URL.
 *
 * A bridged account is reachable at two addresses, and only one of them is an
 * identity:
 *
 *     transport acct     @zuck@kilogram.makeup   how the copy reached us
 *     network identity   @zuck@instagram.com     the account that wrote it
 *
 * The federation layer legitimately resolves the first — ActivityPub addresses
 * actors by it, and inbox/outbox/follow delivery depends on that continuing to
 * work. What it must never be is a second public profile URL: `/@zuck@kilogram.makeup`
 * rendering the profile gives one person two canonical addresses, publishes the
 * bridge hostname where a reader expects a network, and hands share sheets and
 * search engines a link that contradicts the one the page itself shows.
 *
 * ## Why this is worth a browser gate rather than a unit test
 *
 * The rule lives in the frontend's profile data hook, and its failure mode is
 * the quiet one: the page keeps rendering, nothing errors, and the only symptom
 * is a URL that should not exist continuing to work. Nothing in the API changes,
 * so no backend assertion can see it. Only loading both URLs in a browser and
 * asserting that they behave DIFFERENTLY catches a regression.
 *
 * The transport half deliberately asserts the absence of the profile rather than
 * a specific not-found string: what matters is that the account does not render,
 * and pinning the exact empty-state copy would make this fail on a wording
 * change that is not a regression.
 */

import { BRIDGED_NETWORK_HANDLE, BRIDGED_TRANSPORT_HANDLE } from '../environment';
import { expect, test } from '../fixtures';

test('a bridged account renders at its network identity', async ({ page, candidate }) => {
  await page.goto(`/@${BRIDGED_NETWORK_HANDLE}`);

  // The profile screen mounts `<SEO>` only once the profile has resolved, so the
  // title is a real readiness condition rather than a string present from the
  // first byte.
  await expect(page).toHaveTitle(new RegExp(`\\(@${BRIDGED_NETWORK_HANDLE}\\)`));

  expect(candidate.scriptErrors).toEqual([]);
});

test('the same account does NOT render at its transport acct', async ({ page, candidate }) => {
  await page.goto(`/@${BRIDGED_TRANSPORT_HANDLE}`);

  // Give the resolve the same chance to land that the passing case gets, so this
  // cannot go green merely by asserting before anything rendered.
  await page.waitForLoadState('networkidle');

  await expect(page).not.toHaveTitle(new RegExp(`\\(@${BRIDGED_TRANSPORT_HANDLE}\\)`));
  await expect(page).not.toHaveTitle(new RegExp(`\\(@${BRIDGED_NETWORK_HANDLE}\\)`));
  // The bridge hostname must not reach the reader through this route at all.
  await expect(page.getByText(`@${BRIDGED_TRANSPORT_HANDLE}`, { exact: false })).toHaveCount(0);

  expect(candidate.scriptErrors).toEqual([]);
});
