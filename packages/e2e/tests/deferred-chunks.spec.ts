/**
 * Optional runtimes load when they are used, never with the page (#1216).
 *
 * Expo's web export hoists any module two async chunks share into the eager
 * `__common` chunk, so a second import path quietly moves a whole feature back
 * into every page load. `analyze-bundle --ci` guards the bytes at build time
 * (`deferredSources`); this guards the behaviour in a browser: the landing
 * routes fetch none of these chunks, and opening each feature fetches its chunk
 * and works. A module hoisted into `__common` is not a chunk of its own, so the
 * first test cannot see that regression — the second one does (the feature's
 * chunk never loads), and the bundle guard names it.
 */

import type { Page } from '@playwright/test';

import { PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';

/** Chunk names (Metro names an async chunk after its entry module). */
const DEFERRED = ['ComposeScreen', 'MentionSettingsModal', 'LiveFeatureRuntime', 'VideoReplies'] as const;

function recordScripts(page: Page): Set<string> {
  const loaded = new Set<string>();
  page.on('response', (response) => {
    const match = /\/([^/]+)-[0-9a-f]{32}\.js$/.exec(new URL(response.url()).pathname);
    if (match) loaded.add(match[1]);
  });
  return loaded;
}

test('home and a profile fetch no optional runtime', async ({ page, candidate }) => {
  const loaded = recordScripts(page);

  await page.goto('/');
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();
  await page.goto(`/@${PROFILE_HANDLE}`);
  await expect(page.getByTestId('profile-sticky-tabs')).toBeVisible();

  expect(DEFERRED.filter((name) => loaded.has(name))).toEqual([]);
  expect(candidate.scriptErrors).toEqual([]);
});

test('settings and live rooms fetch their chunk when opened, and work', async ({ page, candidate }) => {
  const loaded = recordScripts(page);
  await page.goto('/');
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();
  const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });

  await sidebar.getByText('Settings', { exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  expect(loaded.has('MentionSettingsModal')).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();

  await sidebar.getByText('Live Rooms', { exact: true }).click();
  await expect(page).toHaveURL(/\/live-rooms$/);
  await expect.poll(() => loaded.has('LiveFeatureRuntime')).toBe(true);

  expect(candidate.scriptErrors).toEqual([]);
});
