/**
 * Flow 1 — cold boot of the home feed.
 *
 * This is the regression lock for two shipped outages that `tsc`, the unit
 * suites and the build all passed cleanly through, because neither is a type
 * error or a broken import — both only exist once a browser mounts the tree:
 *
 *   * `useTheme()` called outside `<BloomThemeProvider>` throws at mount, so
 *     the app dies on the very first render (AGENTS.md § Theming).
 *   * a boot-mounted component calling `useTranslation()` suspends before i18n
 *     finishes initialising, the root render never commits, the init effect it
 *     was waiting on never runs, and the page stays white forever with zero
 *     console output (AGENTS.md § expo-router).
 *
 * The second one is why "renders rows" and "no script errors" are BOTH here and
 * are not redundant: the suspense deadlock produces no error at all, and a
 * provider-ordering throw can still leave a partly-painted document.
 */

import { expect, test } from '../fixtures';

test('cold boot paints feed rows without raising a script error', async ({ page, candidate }) => {
  await page.goto('/');

  // The impression observer's row attribute is the one DOM contract the web
  // feed guarantees for every post row (`Feed.web.tsx`), so it is the honest
  // signal that the root committed and the feed actually rendered content —
  // not merely that the document responded.
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();

  expect(candidate.scriptErrors).toEqual([]);
});
