import type { Locator } from '@playwright/test';
import { expect, contractTest as test } from '../fixtures';

const people = Array.from({ length: 40 }, (_, index) => ({
  id: `019e23ee-2d68-7000-8000-${String(index + 500).padStart(12, '0')}`,
  username: `searchsticky${index}`,
  name: { displayName: `Search sticky person ${index}` },
}));

test.beforeEach(async ({ page }) => {
  await page.route('https://api.oxy.so/profiles/search**', (route) =>
    route.fulfill({ json: { data: people, pagination: { offset: 0, limit: 40, hasMore: false } } }),
  );
  await page.route('**/search/overview?**', (route) =>
    route.fulfill({
      json: {
        lanes: Object.fromEntries(
          ['feeds', 'hashtags', 'lists', 'starterPacks'].map((lane) => [
            lane,
            { status: 'ok', items: [] },
          ]),
        ),
      },
    }),
  );
  await page.route('https://api.mention.earth/feeds?**', (route) =>
    route.fulfill({ json: { items: [], feeds: [], pagination: { hasMore: false } } }),
  );
  await page.route('https://api.mention.earth/hashtags/search?**', (route) =>
    route.fulfill({ json: { hashtags: [], items: [], pagination: { hasMore: false } } }),
  );
  await page.route('https://api.mention.earth/starter-packs?**', (route) =>
    route.fulfill({ json: { items: [], starterPacks: [], hasMore: false } }),
  );
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
});

async function expectPinnedPaint(control: Locator) {
  await expect(control).toBeVisible();
  const geometry = await control.evaluate((node) => {
    let element: HTMLElement | null = node as HTMLElement;
    let hasOpaqueBackground = false;
    while (element) {
      const style = getComputedStyle(element);
      if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') {
        hasOpaqueBackground = true;
      }
      if (style.position === 'sticky') {
        const box = node.getBoundingClientRect();
        return { hasOpaqueBackground, top: box.top, bottom: box.bottom };
      }
      element = element.parentElement;
    }
    return null;
  });
  expect(geometry).not.toBeNull();
  expect(geometry?.top).toBeGreaterThanOrEqual(0);
  expect(geometry?.bottom).toBeLessThan(220);
  expect(geometry?.hasOpaqueBackground).toBe(true);
}

for (const width of [390, 1440]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`search header and tabs remain painted while scrolling at ${width}px in ${colorScheme}`, async ({
      page,
      candidate,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme });
      await page.goto('/search?q=sticky');
      const search = page.getByPlaceholder('Search...', { exact: true });
      const tabs = page.getByRole('tablist');
      await expect(search).toHaveValue('sticky');
      await expect(page.getByText('Search for "sticky"', { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /Search sticky person 0/ }).first(),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollHeight))
        .toBeGreaterThan(1600);
      await page.evaluate(() => window.scrollTo(0, 700));
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
      await expectPinnedPaint(search);
      await expectPinnedPaint(tabs);
      const title = page.getByTestId('search-page-header');
      await expect(title).toBeVisible();
      expect((await title.boundingBox())?.y).toBeGreaterThanOrEqual(0);
      expect((await title.boundingBox())?.y).toBeLessThan(100);
      await tabs.getByRole('tab', { name: 'Users', exact: true }).click();
      await expect(tabs.getByRole('tab', { name: 'Users', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await search.fill('refined');
      await expect(search).toHaveValue('refined');
      await expect(search).toBeFocused();
      const submitted = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === '/profiles/search' && url.searchParams.get('query') === 'refined';
      });
      await search.press('Enter');
      await submitted;
      expect(candidate.scriptErrors).toEqual([]);
    });
  }
}

test('search header stays painted within the Deck column', async ({ page, candidate }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const sources = ['explore', 'trending', 'following', 'saved'];
    const ids = ['deck-custom', 'deck-1', 'deck-2', 'deck-3'];
    const state = {
      syncEnabled: false,
      order: ids,
      panels: Object.fromEntries(
        sources.map((source, index) => [
          ids[index],
          { source, width: 390, resizable: true, appearance: 'solid' },
        ]),
      ),
    };
    localStorage.setItem(
      'mention:deck:workspace',
      JSON.stringify({
        version: 1,
        state: { records: { anonymous: { state, base: null, revision: 0, dirty: false } } },
      }),
    );
  });
  await page.goto('/deck');
  const column = page.getByTestId('mention-shell-panels-deck-custom');
  await column.getByRole('button', { name: 'Search', exact: true }).click();
  const search = column.getByPlaceholder('Search...', { exact: true });
  await search.fill('sticky');
  await search.press('Enter');
  const tabs = column.getByRole('tablist');
  await expect(column.getByRole('button', { name: /Search sticky person 0/ })).toBeVisible();
  const viewport = column.locator('[data-bloom-screen-viewport="element"]');
  await expect(viewport).toHaveCount(1);
  await viewport.evaluate((element) => {
    element.scrollTop = 700;
  });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  await expectPinnedPaint(search);
  await expectPinnedPaint(tabs);
  await tabs.getByRole('tab', { name: 'Users', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: 'Users', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(candidate.scriptErrors).toEqual([]);
});
