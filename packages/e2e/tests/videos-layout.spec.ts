import { expect, test } from '../fixtures';

for (const viewport of [
  { width: 412, height: 915 },
  { width: 1440, height: 900 },
]) {
  test(`empty videos fill the reading area at ${viewport.width}px`, async ({ page, candidate }) => {
    await page.setViewportSize(viewport);
    await page.route('**/feed/mtn?**', (route) =>
      route.fulfill({ json: { items: [], hasMore: false } }),
    );
    await page.goto('/videos');
    await expect(page.getByText('No video posts yet', { exact: true })).toBeVisible();
    const screen = page.getByTestId('videos-screen');
    const status = page.getByTestId('videos-status');
    const panel = page.getByTestId('mention-shell-panels-main');
    const invitation = panel.getByTestId('sign-in-banner');
    await expect(invitation).toBeVisible();
    await expect
      .poll(async () => {
        const area = await panel.boundingBox();
        const content = await status.boundingBox();
        const footer = await invitation.boundingBox();
        if (!area || !content || !footer) return Infinity;
        // The invitation now belongs to this panel. The empty state fills its
        // reading area above that footer, without a gap, overlap or overflow.
        return Math.max(
          Math.abs(content.y - area.y),
          Math.abs(content.y + content.height - footer.y),
          Math.abs(footer.y + footer.height - area.y - area.height),
        );
      })
      .toBeLessThan(2);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight,
        ),
      )
      .toBe(0);
    const bounds = await screen.boundingBox();
    const selector = await page.getByRole('radiogroup').boundingBox();
    expect(bounds).not.toBeNull();
    expect(selector).not.toBeNull();
    if (!bounds || !selector) throw new Error('Missing video layout');
    expect(Math.abs(selector.x + selector.width / 2 - bounds.x - bounds.width / 2)).toBeLessThan(2);
    expect(candidate.scriptErrors).toEqual([]);
  });
}

test('a failed video feed offers retry instead of claiming there are no videos', async ({
  page,
  candidate,
}) => {
  let shouldFail = true;
  await page.route('**/feed/mtn?**', (route) =>
    shouldFail
      ? route.fulfill({ status: 503, json: { error: 'Unavailable' } })
      : route.fulfill({ json: { items: [], hasMore: false } }),
  );
  await page.goto('/videos');
  await expect(page.getByText('Couldn’t load videos', { exact: true })).toBeVisible();
  await expect(page.getByText('No video posts yet', { exact: true })).toHaveCount(0);
  shouldFail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('No video posts yet', { exact: true })).toBeVisible();
  // Network failure logging is expected; uncaught exceptions are not.
  expect(candidate.scriptErrors.filter((error) => error.startsWith('uncaught '))).toEqual([]);
});
