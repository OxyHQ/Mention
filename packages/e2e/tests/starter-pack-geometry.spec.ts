import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';
import { installNotificationFixture } from '../notificationFixture';

const packs = Array.from({ length: 3 }, (_, index) => ({
  id: `019e23ee-2d68-7000-8001-${String(index + 100).padStart(12, '0')}`,
  name: `Geometry pack ${index}`,
  description: 'A stable starter pack used for card geometry.',
  creator: { id: 'geometry-creator', username: 'geometrycreator' },
  memberCount: 3,
  memberOxyUserIds: [],
  useCount: 0,
}));

for (const width of [390, 1440]) {
  test(`starter pack cards preserve the column inset at ${width}px`, async ({
    page,
    context,
    candidate,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installNotificationFixture(context);
    await page.route('https://api.mention.earth/starter-packs**', (route) =>
      route.fulfill({
        headers: {
          'access-control-allow-origin': APP_ORIGIN,
          'access-control-allow-credentials': 'true',
        },
        json: { items: packs, hasMore: false },
      }),
    );
    await page.goto('/explore/starter-packs');
    const card = page.getByTestId(`starterpack-${packs[0].id}`);
    await expect(card).toBeVisible();
    const cardBox = await card.boundingBox();
    const columnBox = await page.getByRole('tablist').first().boundingBox();
    expect(cardBox).not.toBeNull();
    expect(columnBox).not.toBeNull();
    const left = (cardBox?.x ?? 0) - (columnBox?.x ?? 0);
    const right =
      (columnBox?.x ?? 0) + (columnBox?.width ?? 0) - (cardBox?.x ?? 0) - (cardBox?.width ?? 0);
    expect(left).toBeGreaterThanOrEqual(15);
    expect(right).toBeGreaterThanOrEqual(15);
    expect(left).toBeLessThanOrEqual(17);
    expect(right).toBeLessThanOrEqual(17);
    expect(candidate.scriptErrors).toEqual([]);
  });
}

test('search starter-pack skeleton cards retain their inset while results load', async ({
  page,
  context,
  candidate,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await installNotificationFixture(context);
  let release: () => void = () => {
    throw new Error('Search response gate was not initialized');
  };
  let markRequested: () => void = () => {
    throw new Error('Search request signal was not initialized');
  };
  const waitForRelease = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  await page.route('https://api.mention.earth/starter-packs?**', async (route) => {
    markRequested();
    await waitForRelease;
    await route.fulfill({
      headers: {
        'access-control-allow-origin': APP_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
      json: { items: packs, hasMore: false },
    });
  });
  try {
    await page.goto('/search?q=uniquegeometrytest');
    await page.getByRole('tab', { name: 'Starter Packs', exact: true }).click();
    await requested;
    const skeleton = page.locator('[data-bloom-skeleton-motion]').first();
    await expect(skeleton).toBeAttached();
    const card = await skeleton.evaluate((node) => {
      let element: HTMLElement | null = node as HTMLElement;
      while (element) {
        const style = getComputedStyle(element);
        if (parseFloat(style.borderTopWidth) > 0 && parseFloat(style.borderTopLeftRadius) > 0) {
          const box = element.getBoundingClientRect();
          return { left: box.left, right: window.innerWidth - box.right };
        }
        element = element.parentElement;
      }
      return null;
    });
    expect(card).not.toBeNull();
    expect(card?.left).toBeGreaterThanOrEqual(11);
    expect(card?.right).toBeGreaterThanOrEqual(11);
    expect(card?.left).toBeLessThanOrEqual(13);
    expect(card?.right).toBeLessThanOrEqual(13);
  } finally {
    release();
  }
  await expect(page.getByTestId(`starterpack-${packs[0].id}`)).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});
