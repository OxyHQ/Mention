import { APP_ORIGIN, PROFILE_HANDLE } from '../environment';
import { expect, test } from '../fixtures';

for (const navigation of [
  { path: `/@${PROFILE_HANDLE}`, back: 'app' },
  { path: `/@${PROFILE_HANDLE}`, back: 'browser' },
  { path: '/', back: 'app' },
  { path: '/', back: 'browser' },
] as const) {
  test(`${navigation.path} retains its feed and reading position after ${navigation.back} Back from a post`, async ({
    page,
    candidate,
  }) => {
    await page.goto(navigation.path);
    await expect(page.locator('[data-post-uri]').first()).toBeAttached();
    await page.mouse.move(600, 500);
    await page.mouse.wheel(0, 3000);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(1000);

    const selectedPost = await page.evaluate(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('[data-post-uri]')).find(
        (element) => {
          const box = element.getBoundingClientRect();
          return box.top >= 0 && box.top < window.innerHeight - 100;
        },
      );
      const target = row?.querySelector<HTMLElement>('[tabindex="0"]');
      if (!row || !target) throw new Error('No visible keyboard-accessible post after scrolling');
      target.focus();
      return { uri: row.getAttribute('data-post-uri') };
    });
    expect(selectedPost.uri).toBeTruthy();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/p\/[^/]+$/);
    await expect(page.getByRole('button', { name: 'Back', exact: true }).first()).toBeVisible();
    if (navigation.back === 'browser') await page.goBack();
    else {
      const back = page.getByRole('button', { name: 'Back', exact: true }).first();
      await back.focus();
      await page.keyboard.press('Enter');
    }
    await expect(page).toHaveURL(`${APP_ORIGIN}${navigation.path}`);
    // The old profile failure returned only its chrome: no rows, no pinned
    // post, no loading/error state. The same URL alone cannot establish recovery.
    await expect.poll(() => page.locator('[data-post-uri]').count()).toBeGreaterThan(0);
    await expect
      .poll(() =>
        page.evaluate(
          (uri) =>
            Array.from(document.querySelectorAll('[data-post-uri]')).some((row) => {
              if (row.getAttribute('data-post-uri') !== uri) return false;
              const box = row.getBoundingClientRect();
              return box.bottom > 0 && box.top < window.innerHeight;
            }),
          selectedPost.uri,
        ),
      )
      .toBe(true);
    expect(candidate.scriptErrors).toEqual([]);
  });
}
