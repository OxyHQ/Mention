import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures';

/**
 * The SDK's device storage: `@oxy.so/bloom-data`'s device database. Opening a
 * database that does not exist yet would create it empty under the app, so it
 * is only opened once listed.
 */
const deviceValue = (page: Page, key: string) =>
  page.evaluate(async (wanted) => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === 'oxy-data-device')) return null;
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('oxy-data-device');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!database.objectStoreNames.contains('records')) return null;
      const records = await new Promise<{ type: string; json: string }[]>((resolve, reject) => {
        const request = database.transaction('records').objectStore('records').getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = records.find((entry) => entry.type === 'oxy.device-key-values');
      if (!record) return null;
      const parsed: { value: { values: Record<string, string> } } = JSON.parse(record.json);
      return parsed.value.values[wanted] ?? null;
    } finally {
      database.close();
    }
  }, key);

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
  await expect.poll(() => deviceValue(page, 'mention_language')).toBe('["es-ES"]');
  expect(await page.evaluate(() => localStorage.getItem('user_language_preference'))).toBeNull();
  const attribution = JSON.stringify({ utmSource: 'release-gate', utmCampaign: 'locale-entry' });
  await expect.poll(() => deviceValue(page, 'mention_campaign_attribution')).toBe(attribution);
  await page.goto('/?utm_source=later-visit');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es-ES');
  await expect.poll(() => deviceValue(page, 'mention_campaign_attribution')).toBe(attribution);
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
  await expect.poll(() => deviceValue(page, 'mention_language')).toBe('["fr-FR"]');
  expect(await page.evaluate(() => localStorage.getItem('user_language_preference'))).toBeNull();
  expect(candidate.scriptErrors).toEqual([]);
});
