import type { Page, Route } from '@playwright/test';
import {
  DRAFT_KEY,
  DRAFT_VIEWER_ID,
  installDraftFixture,
  type FixtureDraft,
} from '../draftFixture';
import { APP_ORIGIN } from '../environment';
import { expect, test } from '../fixtures';

const OTHER_VIEWER = 'draft-other-viewer';
const OTHER_KEY = `@mention_drafts:v2:${OTHER_VIEWER}`;
const expiresAt = new Date(Date.now() + 7_200_000).toISOString();

function token(id: string, sessionId: string): string {
  return [
    Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: id,
        userId: id,
        sessionId,
        exp: Math.floor(Date.now() / 1000) + 7200,
      }),
    ).toString('base64url'),
    'fixture',
  ].join('.');
}

function user(id: string) {
  return {
    id,
    username: id,
    kind: 'personal',
    name: { displayName: id },
    email: 'viewer@example.test',
    avatar: null,
    verified: false,
    privacy: { isPrivate: false },
    counts: { followers: 0, following: 0, posts: 0 },
    locale: 'en',
  };
}

async function installRemoteSession(page: Page) {
  let active = DRAFT_VIEWER_ID;
  let revision = 1;
  let aSession = 'draft-fixture';
  const headers = {
    'access-control-allow-origin': APP_ORIGIN,
    'access-control-allow-credentials': 'true',
  };
  await page.route('**/session/device/state', (route) =>
    route.fulfill({
      headers,
      json: {
        state: {
          deviceId: 'fixture-device',
          accounts: [
            { accountId: DRAFT_VIEWER_ID, sessionId: aSession, authuser: 0 },
            { accountId: OTHER_VIEWER, sessionId: 'other-fixture', authuser: 1 },
          ],
          activeAccountId: active,
          revision,
          updatedAt: Date.now(),
        },
        activeToken: {
          accessToken: token(active, active === DRAFT_VIEWER_ID ? aSession : 'other-fixture'),
          expiresAt,
        },
      },
    }),
  );
  await page.route('**/users/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/users/by-ids')
      return route.fulfill({ headers, json: [user(DRAFT_VIEWER_ID), user(OTHER_VIEWER)] });
    if (
      path === '/users/me' ||
      path === `/users/${DRAFT_VIEWER_ID}` ||
      path === `/users/${OTHER_VIEWER}`
    )
      return route.fulfill({ headers, json: user(active) });
    return route.fallback();
  });
  return async (next: string, nextSession?: string) => {
    active = next;
    if (nextSession) aSession = nextSession;
    revision += 1;
    await page.evaluate(() => {
      const channel = new BroadcastChannel('oxy.session');
      channel.postMessage({ type: 'commit', at: Date.now() });
      channel.close();
    });
  };
}

async function openA(page: Page) {
  await page.goto('/compose');
  await expect(page.getByPlaceholder("What's new?")).toBeVisible();
  await page.getByRole('button', { name: 'Open drafts and scheduled posts' }).click();
  const draft = page
    .getByRole('button', { name: 'Continue writing' })
    .filter({ hasText: 'Draft A original' });
  await draft.click();
  await expect(draft).toBeHidden();
}

async function drafts(page: Page, key: string): Promise<FixtureDraft[]> {
  return page.evaluate(
    (storageKey) => JSON.parse(localStorage.getItem(storageKey) ?? '[]') as FixtureDraft[],
    key,
  );
}

test.beforeEach(async ({ context, candidate }) => {
  expect(candidate.servedPaths).toBeDefined();
  await installDraftFixture(context);
});

test.afterEach(async ({ candidate }) => {
  expect(candidate.scriptErrors.filter((error) => error.startsWith('uncaught '))).toEqual([]);
});

for (const status of [200, 500] as const) {
  test(`a delayed ${status} after a remote switch cannot navigate or erase the next viewer`, async ({
    page,
  }) => {
    const switchTo = await installRemoteSession(page);
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/posts', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      markStarted();
      await gate;
      await route
        .fulfill({
          status,
          headers: {
            'access-control-allow-origin': APP_ORIGIN,
            'access-control-allow-credentials': 'true',
          },
          json:
            status === 200
              ? { success: true, post: { id: 'remote-fixture-post' } }
              : { error: 'Synthetic server failure' },
        })
        .catch(() => {});
    });
    try {
      await openA(page);
      await page.getByTestId('compose-submit').click();
      await started;
      await switchTo(OTHER_VIEWER);
      await expect(page.getByText(`@${OTHER_VIEWER}`, { exact: true }).first()).toBeVisible();
      const editor = page.getByPlaceholder("What's new?");
      await expect(editor).toHaveValue('');
      await editor.fill('Private edit from B');
      release();
      await expect
        .poll(async () =>
          (await drafts(page, OTHER_KEY)).some((d) => d.postContent === 'Private edit from B'),
        )
        .toBe(true);
      await expect(editor).toHaveValue('Private edit from B');
      await expect(page).toHaveURL(`${APP_ORIGIN}/compose`);
      await expect(page.getByText('Post published successfully', { exact: true })).toHaveCount(0);
      // Oxy discards both late responses on a changed session; the result is
      // uncertain to this client even when the fixture sent HTTP 200.
      await expect
        .poll(async () =>
          (await drafts(page, DRAFT_KEY)).some((d) => d.postContent === 'Draft A original'),
        )
        .toBe(true);
    } finally {
      release();
    }
  });
}

test('an incomplete response keeps the draft and warns before retrying', async ({ page }) => {
  let attempts = 0;
  await page.route('**/posts', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts += 1;
    return route.fulfill({
      headers: {
        'access-control-allow-origin': APP_ORIGIN,
        'access-control-allow-credentials': 'true',
      },
      json: { success: true, post: null },
    });
  });
  await openA(page);
  await page.getByTestId('compose-submit').click();
  await expect(
    page.getByText('Could not confirm the result. Check whether the change took effect before trying again.'),
  ).toBeVisible();
  await expect(page.getByPlaceholder("What's new?")).toHaveValue('Draft A original');
  await expect
    .poll(async () =>
      (await drafts(page, DRAFT_KEY)).some((d) => d.postContent === 'Draft A original'),
    )
    .toBe(true);
  expect(attempts).toBe(1);
});

for (const status of [400, 500] as const) {
  test(`an HTTP ${status} after submission keeps the draft and warns before retrying`, async ({
    page,
  }) => {
    let attempts = 0;
    await page.route('**/posts', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      attempts += 1;
      return route.fulfill({
        status,
        headers: {
          'access-control-allow-origin': APP_ORIGIN,
          'access-control-allow-credentials': 'true',
        },
        json: { message: 'Synthetic failure after submission' },
      });
    });
    await openA(page);
    await page.getByTestId('compose-submit').click();
    await expect(
      page.getByText('Could not confirm the result. Check whether the change took effect before trying again.'),
    ).toBeVisible();
    await expect(page.getByPlaceholder("What's new?")).toHaveValue('Draft A original');
    await expect
      .poll(async () =>
        (await drafts(page, DRAFT_KEY)).some((d) => d.postContent === 'Draft A original'),
      )
      .toBe(true);
    expect(attempts).toBe(1);
  });
}

test('a replaced session for the same viewer releases the composer after a pending request', async ({
  page,
}) => {
  const switchTo = await installRemoteSession(page);
  let release!: () => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let attempts = 0;
  await page.route('**/posts', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts += 1;
    started();
    await gate;
    await route
      .fulfill({
        status: 500,
        headers: {
          'access-control-allow-origin': APP_ORIGIN,
          'access-control-allow-credentials': 'true',
        },
        json: { error: 'Synthetic failure' },
      })
      .catch(() => {});
  });
  try {
    await openA(page);
    await page.getByTestId('compose-submit').click();
    await requestStarted;
    const newProjection = page.waitForResponse((response) => {
      if (!response.url().includes('/users/by-ids')) return false;
      return (
        response.request().headers().authorization ===
        `Bearer ${token(DRAFT_VIEWER_ID, 'draft-fixture-new')}`
      );
    });
    await switchTo(DRAFT_VIEWER_ID, 'draft-fixture-new');
    await newProjection;
    release();
    await expect(
      page.getByText('Could not confirm the result. Check whether the change took effect before trying again.'),
    ).toBeVisible();
    await expect(page.getByTestId('compose-submit')).toBeEnabled();
    await expect(page.getByPlaceholder("What's new?")).toHaveValue('Draft A original');
    expect(attempts).toBe(1);
  } finally {
    release();
  }
});
