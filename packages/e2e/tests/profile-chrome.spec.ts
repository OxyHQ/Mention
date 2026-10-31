import { PROFILE_HANDLE } from '../environment';
import { expect, contractTest as test } from '../fixtures';

// Geometry needs a stable avatar and enough rows to scroll, not whichever
// posts happen to be on the production account when the release runs.
const author = {
  id: '019e23ee-2d68-7000-8001-000000000078',
  username: PROFILE_HANDLE,
  kind: 'personal',
  name: { displayName: 'Profile geometry' },
  avatar: 'https://media.mention.earth/profile-geometry/avatar.svg',
};
test.beforeEach(async ({ page }) => {
  await page.route(author.avatar, (route) =>
    route.fulfill({
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" fill="blue"/></svg>',
    }),
  );
  await page.route(`https://api.oxy.so/profiles/username/${PROFILE_HANDLE}**`, (route) =>
    route.fulfill({ json: author }),
  );
  await page.route('**/feed/mtn?**', (route) =>
    route.fulfill({
      json: {
        items: Array.from({ length: 30 }, (_, index) => ({
          id: `019e23ee-2d68-7000-8000-${String(index + 100).padStart(12, '0')}`,
          user: author,
          authors: [],
          attachments: {},
          content: {
            text: `Profile geometry row ${index + 1}\nStable content for a scrollable profile.`,
          },
          metadata: {
            visibility: 'public',
            status: 'published',
            createdAt: '2026-10-01T12:00:00Z',
          },
          engagement: { likes: 0, downvotes: 0, boosts: 0, replies: 0 },
          viewerState: { isOwner: false, isLiked: false, isBoosted: false, isSaved: false },
        })),
        hasMore: false,
      },
    }),
  );
});

test('viewing a profile does not load the media editing sheet', async ({ page, candidate }) => {
  const pickerRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/MediaPickerSheet-[0-9a-f]{32}\.js$/.test(new URL(request.url()).pathname)) {
      pickerRequests.push(request.url());
    }
  });
  await page.goto(`/@${PROFILE_HANDLE}`);
  await expect(page.getByTestId('profile-sticky-tabs')).toBeVisible();
  await expect(page.getByText('Profile geometry row 1', { exact: false }).first()).toBeVisible();
  expect(pickerRequests).toEqual([]);
  expect(candidate.scriptErrors).toEqual([]);
});

test('the profile avatar opens and reopens its image on the first click', async ({
  page,
  candidate,
}) => {
  await page.goto(`/@${PROFILE_HANDLE}`);
  const avatar = page.getByLabel('Profile avatar').first();
  const close = page.getByLabel('Close media viewer').first();
  await expect(avatar).toBeVisible();
  await expect(close).toHaveCount(0);

  await avatar.click();
  await expect(close).toBeVisible();
  await expect(page.locator(`img[src="${author.avatar}"]`).last()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(close).not.toBeVisible();

  await avatar.click();
  await expect(close).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});

for (const width of [390, 1024, 1440]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`profile media and docked chrome share geometry (${width}, ${colorScheme})`, async ({
      page,
      candidate,
    }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme });
      await page.goto(`/@${PROFILE_HANDLE}`);
      const header = page.getByTestId('profile-page-header');
      const banner = page.getByTestId('profile-hero-cover');
      const summary = page.getByTestId('profile-hero-content');
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
      await expect
        .poll(async () => {
          const [h, b] = await Promise.all([header.boundingBox(), banner.boundingBox()]);
          return h && b ? Math.abs(h.y - b.y) : Infinity;
        })
        .toBeLessThan(1);

      // The avatar rises 45px into the banner, painted over it, and the tab
      // strip starts where the summary ends — no transform hole under it.
      const hero = await page.evaluate(() => {
        const cover = document
          .querySelector('[data-testid="profile-hero-cover"]')!
          .getBoundingClientRect();
        const content = document.querySelector('[data-testid="profile-hero-content"]')!;
        const avatar = [...content.querySelectorAll('img')].find(
          (img) => img.getBoundingClientRect().width >= 80,
        );
        if (!avatar) return null;
        const a = avatar.getBoundingClientRect();
        const hit = document.elementFromPoint(a.left + a.width / 2, cover.bottom - 10);
        return {
          overlap: cover.bottom - a.top,
          onTop: Boolean(hit && avatar.parentElement?.contains(hit)),
        };
      });
      expect(hero).not.toBeNull();
      expect(Math.abs(hero!.overlap - 41)).toBeLessThanOrEqual(2); // 45 minus the 4px ring
      expect(hero!.onTop).toBe(true);
      const [sb, tb] = await Promise.all([summary.boundingBox(), tabs.boundingBox()]);
      expect(sb && tb ? Math.abs(tb.y - (sb.y + sb.height)) : Infinity).toBeLessThan(1);

      // Wait for actual feed runway. Scrolling before posts arrive clamps to 0
      // and would accidentally inspect the resting chrome twice.
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight))
        .toBeGreaterThan(900);
      for (const offset of [600, 850]) {
        await page.evaluate((y) => window.scrollTo(0, y), offset);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(offset);
        await expect
          .poll(async () => {
            const [h, t] = await Promise.all([header.boundingBox(), tabs.boundingBox()]);
            return h && t ? Math.abs(t.y - h.y - h.height) : Infinity;
          })
          .toBeLessThan(1);
        await expect(fill).toHaveCSS('opacity', '1');
        const headerFill = await fill.evaluate((node) => getComputedStyle(node).backgroundColor);
        expect(headerFill).not.toBe('rgba(0, 0, 0, 0)');
        await expect(tabs).toHaveCSS('background-color', headerFill);
        // Mask/border layers must not cover the interactive header islands.
        const back = page.getByTestId('profile-page-header-back');
        expect(
          await back.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
          }),
        ).toBe(true);
      }
      expect(candidate.scriptErrors).toEqual([]);
    });
  }
}
