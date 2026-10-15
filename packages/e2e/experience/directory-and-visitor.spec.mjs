import { test, expect } from '@playwright/test';
import { setup, entries, companies, owner, MENTION_ORIGIN } from './fixtures.mjs';

test('creates a neutral employer and preserves role privacy controls for a visitor', async ({
  browser,
}) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await setup(context);
  const page = await context.newPage();
  await page.goto(`${MENTION_ORIGIN}/@experience-owner/experience`);
  await page.getByRole('button', { name: 'Add experience', exact: true }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(
    page.getByText('Enter a title (up to 200 characters).', { exact: true }),
  ).toBeVisible();
  await page.getByLabel('Title *', { exact: true }).fill('Researcher');
  await page.getByLabel('Company or organization *', { exact: true }).fill('New Studio');
  await page.getByRole('button', { name: 'Organization missing? Add it', exact: true }).click();
  await expect(page.getByText(/adds an unclaimed organization/)).toBeVisible();
  await page.getByRole('button', { name: 'Add to directory', exact: true }).click();
  await page.getByLabel('Start date *', { exact: true }).fill('2024-03');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Researcher', { exact: true })).toBeVisible();
  const created = entries.find((entry) => entry.title === 'Researcher');
  expect(created.employerOxyAccountId).toBe('new-company');
  expect(created).not.toHaveProperty('companyName');
  expect(companies.at(-1).claimStatus).toBe('unclaimed');

  const visitor = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await setup(visitor, true, {
    ...owner,
    id: 'experience-visitor',
    username: 'experience-visitor',
  });
  const publicPage = await visitor.newPage();
  let failed = true;
  await publicPage.route('**/api/experience/users/*', (route) =>
    route.fulfill({
      status: failed ? 403 : 200,
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': MENTION_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify(
        failed
          ? { error: { code: 'forbidden', message: 'Unavailable' } }
          : { items: entries, nextCursor: null },
      ),
    }),
  );
  await publicPage.goto(`${MENTION_ORIGIN}/@experience-owner/experience`);
  await expect(
    publicPage.getByText('Experience could not be loaded. Please try again.', { exact: true }),
  ).toBeVisible();
  await expect(publicPage.getByRole('button', { name: 'Add experience', exact: true })).toHaveCount(
    0,
  );
  failed = false;
  await publicPage.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(publicPage.getByText('Researcher', { exact: true })).toBeVisible();
  await expect(publicPage.getByRole('button', { name: /^Edit .*Designer$/ })).toHaveCount(0);
  await context.close();
  await visitor.close();
});
