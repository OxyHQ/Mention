/**
 * Flow 6 — a profile URL resolves to the tab it names, and the strip that says
 * so is never rebuilt by the navigation it performs.
 *
 * Two failures live here, and the file-tree gate next door
 * (`packages/frontend/app/(app)/[username]/__tests__/profileTabRouteTargets.test.ts`)
 * cannot see either of them. It asserts that every tab has a route FILE. Both of
 * these are about which screen the ROUTER then picks, and what the reader sees
 * while it picks it:
 *
 *  - **The tab strip disappearing on every tab switch.** Measured at 597ms with
 *    no strip at all on production — the strip used to be rendered inside each
 *    tab screen, so the `<Slot/>` swapped it away and the incoming route's async
 *    chunk had to arrive before anything could replace it. It is chrome on the
 *    `[username]` layout now, and a layout does not remount.
 *  - **A pushed profile landing on `/about`.** The first attempt at the fix
 *    grouped the tab routes under a nested `(tabs)` segment. `router.push` of
 *    another profile then created a `[username]` entry carrying no nested state,
 *    its child navigator settled on a sibling, and expo-router wrote
 *    `/@handle/about` into the URL. It shipped and was reverted.
 *
 *    Mutation-tested, which is the only reason the second flow is shaped the way
 *    it is. Against a real web export of the reverted commit `da4e2d8d`, three
 *    runs each: pushing a FEDERATED account landed on
 *    `/@aurius@mastodon.social/about` 3/3, while pushing a LOCAL one landed
 *    correctly 3/3 — so the obvious version of this flow passes against the very
 *    build it exists to catch. Controls on the same probe: this branch and
 *    `main` both land on the bare profile URL 3/3 with the federated target.
 *
 * Neither is reachable from jest: `jest-expo` resolves `.native.tsx` and never
 * `.web.tsx`, the failure is a navigation race rather than a render, and the
 * 597ms window only exists where routes are async chunks. A real browser is the
 * only instrument.
 */

import { APP_ORIGIN, PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';
import type { Page } from '@playwright/test';

/** The tab a bare profile URL must resolve to. */
const DEFAULT_TAB = 'Posts';

/** A tab to switch to. Any tab other than the default would do. */
const SECOND_TAB = 'Media';

/**
 * How often to look for the strip while a tab switch is in flight. The bug this
 * samples for lasted ~600ms, so a sample every ~50ms cannot miss it; the loop is
 * bounded by the navigation completing, not by a fixed count.
 */
const STRIP_SAMPLE_INTERVAL_MS = 50;

/** The strip's currently selected tab, or `null` when no strip is showing. */
async function selectedTab(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    return selected?.textContent?.trim() ?? null;
  });
}

/** Whether a profile tab strip is on screen at all. */
async function stripIsShowing(page: Page): Promise<boolean> {
  return page.evaluate(() => document.querySelectorAll('[role="tab"]').length > 0);
}

/**
 * Fails with the URL the browser is actually on, not merely with "expected
 * Posts, got null" — the whole point of the second flow is that the router chose
 * a DIFFERENT SCREEN, and a message that does not name it sends the reader
 * looking through their own diff.
 */
async function expectProfileRootOnDefaultTab(page: Page, handle: string) {
  const pathname = decodeURIComponent(new URL(page.url()).pathname);
  const tab = await selectedTab(page);
  expect(
    { pathname, tab },
    `expected the bare profile URL to resolve to the ${DEFAULT_TAB} tab`,
  ).toEqual({ pathname: `/@${handle}`, tab: DEFAULT_TAB });
}

test('a bare profile URL is the default tab, and the strip survives a tab switch', async ({
  page,
  candidate,
}) => {
  await page.goto(`/@${PROFILE_HANDLE}`);

  // The strip is the layout's, so it paints as soon as the account resolves —
  // waiting on it is waiting on the chrome, not on the feed.
  await expect(page.getByRole('tab', { name: DEFAULT_TAB, exact: true })).toBeVisible();
  await expectProfileRootOnDefaultTab(page, PROFILE_HANDLE);

  // Focus + Enter, never a click: `mention.earth` renders zero anchors — every
  // row is an RNW `Pressable` — and a real `page.mouse.click` on a tab trigger
  // is a measured no-op.
  const target = page.getByRole('tab', { name: SECOND_TAB, exact: true });
  await target.focus();

  // Sample the strip's presence for the whole transition. This is the reported
  // symptom itself: not "the strip came back", but "the strip was never gone".
  // An evaluate that throws mid-navigation counts as STILL SHOWING, so a
  // transport hiccup cannot manufacture a failure.
  let sawStripDisappear = false;
  let stopSampling = false;
  const sampling = (async () => {
    while (!stopSampling && !sawStripDisappear) {
      if (!(await stripIsShowing(page).catch(() => true))) {
        sawStripDisappear = true;
        return;
      }
      await page.waitForTimeout(STRIP_SAMPLE_INTERVAL_MS);
    }
  })();

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`${APP_ORIGIN}/@${PROFILE_HANDLE}/${SECOND_TAB.toLowerCase()}`);
  await expect(page.getByRole('tab', { name: SECOND_TAB, exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  stopSampling = true;
  await sampling;
  expect(sawStripDisappear, 'the tab strip was unmounted by the navigation it performed').toBe(
    false,
  );
  expect(candidate.scriptErrors).toEqual([]);
});

test('a profile pushed from another profile still opens on the default tab', async ({
  page,
  candidate,
}) => {
  // The target must be a FEDERATED account, and that is the whole flow rather
  // than a detail. Measured against real exports of `da4e2d8d`, three runs each,
  // pushing from this same page: a LOCAL target landed on `/@handle` 3/3 — it
  // does not reproduce — while a federated one landed on `/@handle/about` 3/3.
  // A remote actor resolves slowly enough to flip the profile's loading state,
  // which is the condition the reverted build's nested navigator was rebuilt
  // under; a warm local account never flips it. So a gate that pushed whichever
  // card came first would pass against the very build it exists to catch.
  //
  // The followers list is the origin because it needs only the follow graph,
  // which Oxy serves — the flow keeps working when Mention's own API is the
  // thing that has broken, and each row is a `ProfileCard`, i.e. a literal
  // `router.push('/@handle')`.
  await page.goto(`/@${PROFILE_HANDLE}/followers`);
  await expect(page.locator('[role="button"]').first()).toBeVisible();

  const pushed = await page.evaluate((here: string) => {
    const cards = Array.from(document.querySelectorAll('[role="button"]')).filter((element) => {
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length > 200 || text.includes('·')) return false;
      const match = text.match(/@([a-z0-9_.@-]+)/i);
      // An instance suffix is what makes the actor remote, and therefore cold.
      return Boolean(match) && match?.[1] !== here && Boolean(match?.[1]?.includes('@'));
    });
    const first = cards[0];
    if (!first) return false;
    // Focus + Enter: `mention.earth` renders zero anchors, and a real mouse
    // click on an RNW `Pressable` is a measured no-op.
    (first as HTMLElement).focus();
    return true;
  }, PROFILE_HANDLE);

  // Not a skip. A skip is indistinguishable from a pass in a report, and this
  // flow exists to block a promotion. If no federated card rendered, the gate
  // could not reach a verdict, and it says which dependency is at fault — the
  // same distinction `preflight.ts` draws for the API.
  expect(
    pushed,
    'GATE COULD NOT EVALUATE THIS CANDIDATE: no FEDERATED account appeared in ' +
      `@${PROFILE_HANDLE}'s followers, and a local target does not reproduce the failure this ` +
      'flow exists for. Set MENTION_E2E_PROFILE_HANDLE to an account with at least one ' +
      'remote follower.',
  ).toBe(true);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/@[^/]+(\/|$)/);
  await expect(page).not.toHaveURL(/\/followers$/);
  // Then let the router settle before judging. On the reverted build the rewrite
  // was already in place 16-20ms after the key press — it never showed the bare
  // profile URL at all — so this window is not what makes the check work today.
  // It is here because the failure is a navigator settling, not a paint, and a
  // variant that settles a beat later would otherwise read as a clean pass.
  await page.waitForTimeout(6_000);

  // Asserted as a SHAPE — one segment, on the default tab — rather than against
  // a handle read out of the card. A `ProfileCard` renders the bio straight
  // after the handle with no separator in `textContent`, so scraping the handle
  // yields `@user@instance.socialTheirBioHere`; the property under test is that
  // nothing was appended to the URL, and that is what this says.
  const pathname = decodeURIComponent(new URL(page.url()).pathname);
  const tab = await selectedTab(page);
  expect(
    pathname.startsWith('/@'),
    `expected a profile URL after the push, landed on ${pathname}`,
  ).toBe(true);
  expect(
    { segments: pathname.split('/').filter(Boolean).length, tab },
    `the pushed profile did not open on its own default tab — landed on ${pathname}`,
  ).toEqual({ segments: 1, tab: DEFAULT_TAB });

  expect(candidate.scriptErrors).toEqual([]);
});
