import type { Locator } from '@playwright/test';
import { expect, contractTest as test } from '../fixtures';

const recommendations = Array.from({ length: 40 }, (_, index) => ({
  id: `019e23ee-2d68-7000-8000-${String(index + 500).padStart(12, '0')}`,
  username: `exploresticky${index}`,
  name: { displayName: `Explore sticky person ${index}` },
}));

test.beforeEach(async ({ page }) => {
  await page.route('**/recommendations?**', (route) =>
    route.fulfill({ json: { recommendations, hasMore: false, nextCursor: null } }),
  );
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({ json: { items: [], hasMore: false } }),
  );
});

async function expectDockedTabs(tabs: Locator, scroll: () => Promise<void>) {
  await scroll();
  await expect(tabs).toBeVisible();
  await expect.poll(async () => (await tabs.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  expect((await tabs.boundingBox())?.y).toBeLessThan(180);
  const sticky = await tabs.evaluate((node) => {
    let element: HTMLElement | null = node as HTMLElement;
    while (element) {
      const style = getComputedStyle(element);
      if (style.position === 'sticky') {
        return {
          background: style.backgroundColor,
          height: element.getBoundingClientRect().height,
        };
      }
      element = element.parentElement;
    }
    return null;
  });
  expect(sticky).not.toBeNull();
  expect(sticky?.height).toBeGreaterThan(30);
  expect(sticky?.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(sticky?.background).not.toBe('transparent');
}

for (const width of [390, 1440]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`Explore tabs remain opaque and docked while the document scrolls at ${width}px in ${colorScheme}`, async ({
      page,
      candidate,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme });
      await page.goto('/explore/who-to-follow');
      const tabs = page.getByRole('tablist');
      await expect(
        page.getByRole('button', { name: /Explore sticky person 0/ }).first(),
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollHeight))
        .toBeGreaterThan(1600);
      await expectDockedTabs(tabs, async () => {
        await page.evaluate(() => window.scrollTo(0, 700));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
      });
      await tabs.getByRole('tab', { name: 'Media', exact: true }).click();
      await expect(page).toHaveURL(/\/explore\/media$/);
      await expect(tabs.getByRole('tab', { name: 'Media', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      expect(candidate.scriptErrors).toEqual([]);
    });
  }
}

test('Explore tabs remain docked inside the Deck column scroll owner', async ({
  page,
  candidate,
}) => {
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
  const tabs = column.getByRole('tablist');
  await tabs.getByRole('tab', { name: 'Who to follow', exact: true }).click();
  await expect(column.getByRole('button', { name: /Explore sticky person 0/ })).toBeVisible();
  const viewport = column.locator('[data-bloom-screen-viewport="element"]');
  await expect(viewport).toHaveCount(1);
  await expectDockedTabs(tabs, async () => {
    await viewport.evaluate((element) => {
      element.scrollTop = 700;
    });
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(500);
  });
  await tabs.getByRole('tab', { name: 'Media', exact: true }).click();
  await expect(tabs.getByRole('tab', { name: 'Media', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(candidate.scriptErrors).toEqual([]);
});
