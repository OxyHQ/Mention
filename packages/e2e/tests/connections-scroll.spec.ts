import { PROFILE_HANDLE } from '../environment';
import { expect, contractTest as test } from '../fixtures';

const profile = {
  id: '019e23ee-2d68-7000-8001-000000000078',
  username: PROFILE_HANDLE,
  kind: 'personal',
  name: { displayName: 'Scroll profile' },
};
const recommendations = Array.from({ length: 40 }, (_, index) => ({
  id: `019e23ee-2d68-7000-8000-${String(index + 100).padStart(12, '0')}`,
  username: `scrollperson${index}`,
  name: { displayName: `Scroll person ${index}` },
}));

test.beforeEach(async ({ page }) => {
  await page.route(`https://api.oxy.so/profiles/username/${PROFILE_HANDLE}**`, (route) =>
    route.fulfill({ json: profile }),
  );
  await page.route('**/recommendations?**', (route) =>
    route.fulfill({ json: { recommendations, hasMore: false, nextCursor: null } }),
  );
});

for (const width of [390, 1024, 1440]) {
  test(`recommendations remain inside the scrolling panel at ${width}px`, async ({
    page,
    candidate,
  }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/@${PROFILE_HANDLE}/who-may-know`);
    const main = page.getByTestId('mention-shell-panels-main');
    const viewport = main.locator('[data-bloom-screen-viewport="document"]');
    await expect(viewport).toHaveCount(1);
    await expect(page.getByText('Scroll person 0', { exact: true }).first()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollHeight))
      .toBeGreaterThan(1600);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect(page.getByText('Scroll person 39', { exact: true }).first()).toBeVisible();
    const geometry = await main.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return {
        bottom: box.bottom,
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });
    expect(geometry.bottom).toBeGreaterThan(0);
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(candidate.scriptErrors).toEqual([]);
  });
}

test('profile navigation retains one scroll owner when opening connections and returning', async ({
  page,
  candidate,
}) => {
  await page.goto(`/@${PROFILE_HANDLE}/who-may-know`);
  const main = page.getByTestId('mention-shell-panels-main');
  await expect(page.getByText('Scroll person 0', { exact: true }).first()).toBeVisible();
  await page.getByText('Followers', { exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/@${PROFILE_HANDLE}/followers$`));
  await expect(main.locator('[data-bloom-screen-viewport="document"]')).toHaveCount(1);
  await page.goBack();
  await expect(page.getByText('Scroll person 0', { exact: true }).first()).toBeVisible();
  await expect(main.locator('[data-bloom-screen-viewport="document"]')).toHaveCount(1);
  expect(candidate.scriptErrors).toEqual([]);
});
