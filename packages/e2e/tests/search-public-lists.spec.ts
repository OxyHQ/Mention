// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { expect, contractTest as test } from '../fixtures';

test('a signed-out visitor finds a public list in All and Lists', async ({ page, candidate }) => {
  const list = { id: '019e23ee-2d68-7000-8000-000000000001', title: 'Rust public list' };
  const privateListReads: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/lists/${list.id}`) {
      privateListReads.push(request.url());
    }
  });
  await page.route('https://api.oxy.so/profiles/search**', (route) =>
    route.fulfill({ json: { data: [], pagination: { hasMore: false } } }),
  );
  await page.route('**/search/overview?**', (route) =>
    route.fulfill({
      json: {
        lanes: {
          lists: { status: 'ok', items: [list] },
          feeds: { status: 'ok', items: [] },
          hashtags: { status: 'ok', items: [] },
          starterPacks: { status: 'ok', items: [] },
        },
      },
    }),
  );
  await page.route('**/search/lists?**', (route) =>
    route.fulfill({
      json: { items: [list], pagination: { offset: 0, limit: 20, hasMore: false } },
    }),
  );
  await page.goto('/search?q=rust');
  await expect(page.getByText('Rust public list')).toBeVisible();
  const publicRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/search/lists' && url.searchParams.get('q') === 'rust';
  });
  await page.getByRole('tab', { name: 'Lists', exact: true }).click();
  await publicRequest;
  await expect(page.getByText('Rust public list')).toBeVisible();
  await page.getByText('Rust public list').click();
  await expect(page).toHaveURL(new RegExp(`/lists/${list.id}$`));
  await expect(page.getByText('Sign in to use lists')).toBeVisible();
  expect(privateListReads).toEqual([]);
  expect(candidate.scriptErrors).toEqual([]);
});
