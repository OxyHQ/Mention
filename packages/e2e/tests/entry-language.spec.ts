import { expect, test } from '../fixtures';

// Real anonymous SDK boot against the candidate. No identity or locale API mocks.
test('entry locale precedes saved preference and persists with first campaign attribution', async ({
  page,
  context,
  candidate,
}) => {
  await context.addInitScript(() => {
    if (!localStorage.getItem('language-test-seeded')) {
      localStorage.setItem('user_language_preference', JSON.stringify('fr-FR'));
      localStorage.setItem('language-test-seeded', 'true');
    }
  });
  await page.goto('/?lang=es&utm_source=release-gate&utm_campaign=locale-entry');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es-ES');
  await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible();
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mention_language')))
    .toBe('["es-ES"]');
  expect(await page.evaluate(() => localStorage.getItem('user_language_preference'))).toBeNull();
  const attribution = JSON.stringify({ utmSource: 'release-gate', utmCampaign: 'locale-entry' });
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('mention_campaign_attribution')))
    .toBe(attribution);
  await page.goto('/?utm_source=later-visit');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es-ES');
  expect(await page.evaluate(() => localStorage.getItem('mention_campaign_attribution'))).toBe(
    attribution,
  );
  await expect(page.getByRole('link', { name: 'Inicio', exact: true })).toBeVisible();
  expect(candidate.scriptErrors).toEqual([]);
});

test('cold boot migrates the former Mention language preference', async ({
  page,
  context,
  candidate,
}) => {
  await context.addInitScript(() => {
    localStorage.setItem('user_language_preference', JSON.stringify('fr-FR'));
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr-FR');
  await expect(page.getByRole('link', { name: 'Accueil', exact: true })).toBeVisible();
  await expect(page.locator('[data-post-uri]').first()).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('mention_language'))).toBe('["fr-FR"]');
  expect(await page.evaluate(() => localStorage.getItem('user_language_preference'))).toBeNull();
  expect(candidate.scriptErrors).toEqual([]);
});
