import { PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';

for (const width of [390, 1024, 1440]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`profile media and docked chrome share geometry (${width}, ${colorScheme})`, async ({ page, candidate }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme });
      await page.goto(`/@${PROFILE_HANDLE}`);
      const header = page.getByTestId('profile-page-header');
      const banner = page.getByTestId('profile-banner');
      const tabs = page.getByTestId('profile-sticky-tabs');
      const fill = page.getByTestId('profile-page-header-docked-fill');
      await expect(tabs).toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
      if (width >= 500) {
        const sidebar = page.getByRole('complementary', { name: 'Sidebar', exact: true });
        const footer = sidebar.getByTestId(/sidebar.*-footer$/);
        await expect(footer).toBeVisible();
        const [s, f] = await Promise.all([sidebar.boundingBox(), footer.boundingBox()]);
        expect(s && f ? s.y + s.height - f.y - f.height : Infinity).toBeLessThanOrEqual(24);
      }

      // The media starts behind the header; the header reserves no blank band.
      await expect.poll(async () => {
        const [h, b] = await Promise.all([header.boundingBox(), banner.boundingBox()]);
        return h && b ? Math.abs(h.y - b.y) : Infinity;
      }).toBeLessThan(1);

      // Wait for actual feed runway. Scrolling before posts arrive clamps to 0
      // and would accidentally inspect the resting chrome twice.
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight)).toBeGreaterThan(900);
      for (const offset of [600, 850]) {
        await page.evaluate(y => window.scrollTo(0, y), offset);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(offset);
        await expect.poll(async () => {
          const [h, t] = await Promise.all([header.boundingBox(), tabs.boundingBox()]);
          return h && t ? Math.abs(t.y - h.y - h.height) : Infinity;
        }).toBeLessThan(1);
        await expect(fill).toHaveCSS('opacity', '1');
        const headerFill = await fill.evaluate(node => getComputedStyle(node).backgroundColor);
        expect(headerFill).not.toBe('rgba(0, 0, 0, 0)');
        await expect(tabs).toHaveCSS('background-color', headerFill);
        // Mask/border layers must not cover the interactive header islands.
        const back = page.getByTestId('profile-page-header-back');
        expect(await back.evaluate(node => {
          const r = node.getBoundingClientRect();
          return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
        })).toBe(true);
      }
      expect(candidate.scriptErrors).toEqual([]);
    });
  }
}
