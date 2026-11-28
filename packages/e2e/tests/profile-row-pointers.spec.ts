// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { Locator, Page } from '@playwright/test';
import { expect, contractTest as test } from '../fixtures';
import { installReplySession } from '../fixtures/replySession';

const author = {
  id: '019e23ee-2d68-7000-8000-000000000002',
  username: 'semantic-author',
  name: { displayName: 'Semantic author' },
  bio: 'A shared person row',
  kind: 'personal',
  counts: { followers: 0, following: 0, posts: 0 },
};

// Passive identity content deliberately lets the sibling opening target receive
// the physical pointer. Locator.click would reject that intended interception.
async function clickVisibleCenter(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  const box = await target.boundingBox();
  if (!box) throw new Error('Visible row content has no pointer target');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

for (const width of [1440, 390]) {
  test(`profile avatar and name open independently of follow at ${width}px`, async ({
    page,
    context,
    candidate,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await installReplySession(context);
    const follows: string[] = [];
    await page.route('**/profiles/search?**', (route) =>
      route.fulfill({ json: { data: [author], pagination: { hasMore: false } } }),
    );
    await page.route('**/users/follow-status/bulk', (route) =>
      route.fulfill({ json: { statuses: { [author.id]: false } } }),
    );
    await page.route(`**/users/${author.id}/follow`, (route) => {
      follows.push(route.request().method());
      return route.fulfill({ json: { success: true, counts: { followers: 1, following: 1 } } });
    });
    await page.route(`**/profiles/username/${author.username}`, (route) =>
      route.fulfill({ json: author }),
    );
    await page.route(`**/users/${author.id}`, (route) => route.fulfill({ json: author }));

    const row = page.locator('[data-bloom-list-row]').filter({ hasText: author.bio });
    for (const target of ['avatar', 'name']) {
      await page.goto('/search?q=semantic');
      await clickVisibleCenter(
        page,
        row.getByText(target === 'avatar' ? 'S' : 'Semantic author', { exact: true }),
      );
      await expect(page).toHaveURL(/\/@semantic-author$/);
      expect(follows).toEqual([]);
    }

    await page.goto('/search?q=semantic');
    await row.getByRole('button', { name: 'Follow @semantic-author', exact: true }).click();
    await expect.poll(() => follows).toEqual(['POST']);
    await expect(page).toHaveURL(/\/search\?q=semantic$/);
    await expect(
      row.getByRole('button', { name: 'Following @semantic-author', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(candidate.scriptErrors).toEqual([]);
  });
}
