import { test, expect } from '@playwright/test';
import { setup, companies, owner, MENTION_ORIGIN } from './fixtures.mjs';

async function manage(page) {
  await page.goto(`${MENTION_ORIGIN}/@experience-owner/experience`);
  await expect(page.getByText('Creative Director. Video', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await page.getByText('Settings', { exact: true }).first().click();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await expect(page.getByText('Create account', { exact: true })).toBeVisible();
}
const reply = (route, value) =>
  route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify(value),
    headers: {
      'access-control-allow-origin': route.request().headers().origin || MENTION_ORIGIN,
      'access-control-allow-credentials': 'true',
    },
  });

test('shared account UI claims existing identities and adds neutral directory entries', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await setup(context);
  const claims = [];
  let accountCreates = 0;
  await context.route('**/organizations/**/claims', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const accountId = new URL(route.request().url()).pathname.split('/')[2];
    claims.push({ accountId, ...route.request().postDataJSON() });
    return reply(route, {
      id: 'claim-1',
      accountId,
      claimantUserId: owner.id,
      status: 'pending',
      createdAt: '2026-10-15T00:00:00Z',
    });
  });
  await context.route('**/organizations/claims/mine*', (route) =>
    reply(route, { items: [], nextCursor: null }),
  );
  await context.route('**/accounts', async (route) => {
    if (route.request().method() === 'POST') accountCreates++;
    return route.fallback();
  });
  const page = await context.newPage();
  await manage(page);
  await page.getByText('Create account', { exact: true }).click();
  await page.getByText('Organization', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Organization directory', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Create an account you control. It will have its own profile, members, and apps.',
      { exact: true },
    ),
  ).toHaveCount(0);
  await page.getByLabel('Find your organization', { exact: true }).fill('Oxy');
  await page.getByText('https://oxy.so · US · Unclaimed', { exact: true }).click();
  await page.getByLabel('Supporting evidence reference', { exact: true }).fill('private-case-123');
  await page.getByRole('button', { name: 'Request management access', exact: true }).click();
  await expect(page.getByText('Request submitted for review', { exact: true })).toBeVisible();
  expect(claims).toEqual([
    { accountId: '69b2d3df5d12f58c9800d651', evidenceReference: 'private-case-123' },
  ]);
  expect(accountCreates).toBe(0);
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('organization-claim-desktop.png'),
  });
  await page.getByRole('button', { name: 'Back to search', exact: true }).click();
  await page.getByLabel('Find your organization', { exact: true }).fill('Civic Studio & Co.');
  await page.getByRole('button', { name: 'Add to directory', exact: true }).click();
  await page.getByText('Community', { exact: true }).click();
  await page.getByRole('button', { name: 'Add to directory', exact: true }).click();
  await expect(page.getByText('Civic Studio & Co.', { exact: true })).toBeVisible();
  expect(companies.find((c) => c.name === 'Civic Studio & Co.')?.organizationType).toBe(
    'community',
  );
  expect(accountCreates).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${MENTION_ORIGIN}/settings`);
  await page.getByRole('button', { name: 'Manage account', exact: true }).click();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByText('Create account', { exact: true }).click();
  await page.getByText('Organization', { exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Organization directory', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Create an account you control. It will have its own profile, members, and apps.',
      { exact: true },
    ),
  ).toHaveCount(0);
  await page.getByLabel('Find your organization', { exact: true }).fill('Civic Studio & Co.');
  await page.getByText('Civic Studio & Co.', { exact: true }).click();
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('organization-directory-mobile.png'),
  });
  await context.close();
});

test('organization settings updates subtype on the same account identity', async ({
  browser,
}, testInfo) => {
  const organization = companies.find((c) => c.username === 'oxy');
  const viewer = {
    ...owner,
    id: organization.accountId,
    username: 'oxy',
    kind: 'organization',
    name: { displayName: 'Oxy' },
  };
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await setup(context, true, viewer);
  const updates = [];
  await context.route(`**/accounts/${organization.accountId}`, (route) =>
    reply(route, {
      account: {
        accountId: organization.accountId,
        kind: 'organization',
        parentAccountId: null,
        account: viewer,
        relationship: 'owner',
        callerMembership: null,
        childCount: 0,
      },
    }),
  );
  await context.route(`**/organizations/${organization.accountId}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      updates.push(route.request().postDataJSON());
      Object.assign(organization, updates.at(-1), { updatedAt: new Date().toISOString() });
      return reply(route, organization);
    }
    return route.fallback();
  });
  const page = await context.newPage();
  await manage(page);
  await page.getByText('Organization details', { exact: true }).click();
  await page.getByText('Nonprofit', { exact: true }).click();
  await page.getByRole('button', { name: 'Save organization', exact: true }).click();
  await expect(page.getByText('Organization updated', { exact: true })).toBeVisible();
  expect(updates).toEqual([
    {
      organizationType: 'nonprofit',
      legalName: null,
      websiteUrl: 'https://oxy.so',
      countryCode: 'US',
    },
  ]);
  expect(organization.accountId).toBe('69b2d3df5d12f58c9800d651');
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('organization-settings-desktop.png'),
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${MENTION_ORIGIN}/settings`);
  await page.getByRole('button', { name: 'Manage account', exact: true }).click();
  await page.getByRole('button', { name: 'Manage', exact: true }).click();
  await page.getByText('Organization details', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Nonprofit', exact: true })).toContainText('✓');
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('organization-settings-mobile.png'),
  });
  await context.close();
});
