import { test, expect } from '@playwright/test';
import { setup, owner, companies, entries, MENTION_ORIGIN } from '../experience/fixtures.mjs';

test('supervised visitors cannot load unrated career or employer details', async ({
  context,
  page,
}, info) => {
  const child = { ...owner, id: 'supervised-visitor', username: 'supervised-visitor' };
  await setup(context, true, child);
  const privateRequests = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/experience/') || path.startsWith('/organizations/'))
      privateRequests.push(path);
  });
  await context.route('**/safety/supervision', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': MENTION_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify({
        self: {
          childAccountId: child.id,
          guardianAccountId: 'guardian',
          status: 'active',
          policyVersion: '2',
          consentVersion: '1',
          createdAt: '2026-10-15T00:00:00.000Z',
        },
        children: [],
        invitations: [],
      }),
    }),
  );
  await context.route('**/safety/supervision/people', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers: {
        'access-control-allow-origin': MENTION_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
      body: JSON.stringify({
        items: [{ accountId: owner.id, username: owner.username, displayName: 'Alex Rivera' }],
      }),
    }),
  );
  await page.goto(`${MENTION_ORIGIN}/@experience-owner/experience`);
  await expect(page.getByText('Unavailable for this account', { exact: true })).toBeVisible();
  await expect(page.getByText('Designer', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add experience', exact: true })).toHaveCount(0);
  expect(privateRequests).toEqual([]);
  await page.screenshot({
    path: info.outputPath('supervised-experience-unavailable.png'),
    fullPage: true,
  });
});

test('supervised owners add, edit and delete roles with existing minimal employer identities', async ({
  context,
  page,
}, info) => {
  await setup(context);
  const forbiddenRequests = [];
  const minimalRequests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/organizations/') || url.hostname === 'cloud.oxy.so')
      forbiddenRequests.push(request.url());
  });
  const headers = {
    'access-control-allow-origin': MENTION_ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
  await context.route('**/safety/supervision', (route) =>
    route.fulfill({
      contentType: 'application/json',
      headers,
      body: JSON.stringify({
        self: {
          childAccountId: owner.id,
          guardianAccountId: 'guardian',
          status: 'active',
          policyVersion: '2',
          consentVersion: '1',
          createdAt: '2026-10-15T00:00:00.000Z',
        },
        children: [],
        invitations: [],
      }),
    }),
  );
  await context.route('**/safety/supervision/organizations', (route) => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    expect(route.request().headers().authorization).toMatch(/^Bearer /);
    const input = route.request().postDataJSON();
    minimalRequests.push(input);
    const found = companies.filter((company) =>
      input.ids
        ? input.ids.includes(company.accountId)
        : company.name.toLowerCase().includes(input.query.toLowerCase()),
    );
    return route.fulfill({
      contentType: 'application/json',
      headers,
      body: JSON.stringify({
        items: found.map(({ accountId, username, name, organizationType }) => ({
          requestedAccountId: accountId,
          organization: { accountId, username, name, organizationType },
        })),
        missingIds: [],
      }),
    });
  });
  await page.goto(`${MENTION_ORIGIN}/@experience-owner/experience`);
  await expect(page.getByText('Creative Director. Video', { exact: true })).toBeVisible();
  await expect.poll(() => minimalRequests.some((request) => request.ids?.length > 0)).toBe(true);
  await page.getByRole('button', { name: 'Add experience', exact: true }).click();
  await page.getByLabel('Title *', { exact: true }).fill('Student researcher');
  await page.getByLabel('Company or organization *', { exact: true }).fill('Oxy');
  await expect.poll(() => minimalRequests.some((request) => request.query === 'Oxy')).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Organization missing? Add it', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText('https://oxy.so · US', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Oxy', exact: true }).click();
  await page.getByLabel('Start date *', { exact: true }).fill('2025-01');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Student researcher', { exact: true })).toBeVisible();
  const savedId = entries.find((entry) => entry.title === 'Student researcher').id;
  await page.getByRole('button', { name: 'Edit Student researcher', exact: true }).click();
  await page.getByLabel('Title *', { exact: true }).fill('Research assistant');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Research assistant', { exact: true })).toBeVisible();
  expect(entries.find((entry) => entry.id === savedId).title).toBe('Research assistant');
  await page.screenshot({ path: info.outputPath('supervised-own-experience.png'), fullPage: true });
  await page.getByRole('button', { name: 'Edit Research assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).last().click();
  await expect(page.getByText('Research assistant', { exact: true })).toHaveCount(0);
  expect(entries.find((entry) => entry.id === savedId)).toBeUndefined();
  expect(forbiddenRequests).toEqual([]);
});
