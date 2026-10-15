import { test, expect } from '@playwright/test';
import { setup, entries, MENTION_ORIGIN, CLARITY_ORIGIN } from './fixtures.mjs';
test('the same role can be edited and removed across Mention and Clarity', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await setup(context);
  const mention = await context.newPage();
  mention.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await mention.goto(`${MENTION_ORIGIN}/@experience-owner/experience`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(mention.getByRole('button', { name: 'Add experience', exact: true })).toBeVisible({
    timeout: 60000,
  });
  await expect(mention.getByText('Creative Director. Video', { exact: true })).toBeVisible();
  await mention.screenshot({ path: testInfo.outputPath('mention-desktop.png') });
  await mention.getByRole('button', { name: 'Add experience', exact: true }).click();

  await mention.getByLabel('Title *', { exact: true }).fill('Staff Designer');
  await mention.getByLabel('Company or organization *', { exact: true }).fill('Oxy');
  await expect
    .poll(() =>
      mention
        .locator('img[src*="69b85ff8a08af16d4b87155e"]')
        .evaluateAll((images) => images.some((image) => image.complete && image.naturalWidth > 0)),
    )
    .toBe(true);
  await mention.getByText('https://oxy.so · US', { exact: true }).click();
  await mention.getByLabel('Start date *', { exact: true }).fill('2025-01');
  await mention.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(mention.getByText('Staff Designer', { exact: true })).toBeVisible();
  const savedId = entries.find((e) => e.title === 'Staff Designer').id;
  const clarity = await context.newPage();
  await clarity.goto(`${CLARITY_ORIGIN}/settings/experience`, { waitUntil: 'domcontentloaded' });
  await expect(clarity.getByText('Staff Designer', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await clarity.screenshot({ path: testInfo.outputPath('clarity-desktop.png') });
  await clarity.getByRole('button', { name: 'Edit Staff Designer', exact: true }).click();
  await clarity.getByLabel('Title *', { exact: true }).fill('Principal Designer');
  await clarity.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(clarity.getByText('Principal Designer', { exact: true })).toBeVisible();
  if (entries.find((e) => e.id === savedId)?.title !== 'Principal Designer')
    throw Error('Clarity changed the wrong role ID');
  await mention.reload();
  await expect(mention.getByText('Principal Designer', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await mention.setViewportSize({ width: 390, height: 844 });
  const selectedTab = mention.getByRole('tab', { name: 'Experience', exact: true });
  await expect(selectedTab).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(async () => {
      const bounds = await selectedTab.boundingBox();
      return bounds !== null && bounds.x >= 0 && bounds.x + bounds.width <= 390;
    })
    .toBe(true);
  await mention.screenshot({ path: testInfo.outputPath('mention-mobile.png') });
  await mention.getByRole('button', { name: 'Edit Principal Designer', exact: true }).click();
  await mention.screenshot({ path: testInfo.outputPath('editor-mobile.png') });
  await mention.getByRole('button', { name: 'Delete', exact: true }).click();
  await mention.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(mention.getByText('Principal Designer', { exact: true })).toHaveCount(0);
  await clarity.reload();
  await expect(clarity.getByText('Principal Designer', { exact: true })).toHaveCount(0);
  await clarity.setViewportSize({ width: 390, height: 844 });
  await expect(clarity.getByRole('button', { name: 'Add experience', exact: true })).toBeVisible();
  await clarity.screenshot({ path: testInfo.outputPath('clarity-mobile.png') });
});
