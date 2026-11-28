import { test, expect } from '@playwright/test';
const origin = 'http://localhost:8109';
const child = {
  id: 'supervised-writer',
  username: 'supervised-writer',
  kind: 'personal',
  name: { displayName: 'Supervised Writer' },
  email: 'writer@example.test',
  bio: '',
  avatar: null,
  verified: false,
  privacy: { isPrivate: true },
  counts: { followers: 0, following: 0, posts: 0 },
  locale: 'en',
};
const file = {
  id: '01a12355-5f04-73a5-bb5b-dbf6f53ce659',
  originalName: 'drawing.png',
  mime: 'image/png',
  size: 164,
  visibility: 'private',
  createdAt: '2026-10-15T00:00:00.000Z',
  userId: child.id,
  metadata: {},
};
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAa0lEQVR4nO3PwQkAIRAEQYMyFCO6jExO8HcxzIKwj4J5N1Pj7hVtfifa6/4AAAAAAAAAAAAAACgDuh1K+wAAAAAAAAAAAAAAdUC3Q2kfAAAAAAAAAAAAAKAO6HYo7QMAAAAAAAAAAAAAlPs/ug5RtFD0/84AAAAASUVORK5CYII=',
  'base64',
);
test('supervised writer uploads privately, previews through scoped access and submits private post', async ({
  context,
  page,
}, info) => {
  const token = [
    Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: child.id,
        userId: child.id,
        sessionId: 'kids-session',
        exp: Math.floor(Date.now() / 1000) + 7200,
      }),
    ).toString('base64url'),
    'fixture',
  ].join('.');
  const calls = [];
  let uploaded = false;
  await context.addInitScript(
    ({ child, token }) => {
      localStorage.setItem(
        'oxy.auth.v1',
        JSON.stringify({
          sessionId: 'kids-session',
          userId: child.id,
          deviceId: 'kids-device',
          deviceSecret: 'fixture-only',
        }),
      );
      localStorage.setItem(
        'oxy.auth.token.v1',
        JSON.stringify({
          accessToken: token,
          expiresAt: new Date(Date.now() + 7200000).toISOString(),
        }),
      );
    },
    { child, token },
  );
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      p = url.pathname,
      m = req.method();
    if (url.origin === origin || !['http:', 'https:'].includes(url.protocol))
      return route.continue();
    const headers = {
      'access-control-allow-origin': req.headers().origin || origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-allow-headers': '*',
    };
    const json = (data, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });
    if (m === 'OPTIONS') return route.fulfill({ status: 204, headers });
    calls.push({
      path: p,
      method: m,
      body: req.postData(),
      authorization: !!req.headers().authorization,
    });
    if (p === '/safety/supervision')
      return json({
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
      });
    if (p === '/session/device/token')
      return json({
        accessToken: token,
        expiresAt: new Date(Date.now() + 7200000).toISOString(),
        userId: child.id,
        sessionId: 'kids-session',
        nextDeviceSecret: 'fixture-only',
        user: child,
      });
    if (p.startsWith('/session/user/') || p === '/users/me' || p === `/users/${child.id}`)
      return json(child);
    if (p.startsWith('/session/validate'))
      return json({ valid: true, user: child, sessionId: 'kids-session' });
    if (p.startsWith('/auth/oauth/client/'))
      return json({
        application: {
          id: 'fixture-app',
          name: 'Mention',
          type: 'internal',
          isOfficial: true,
          isInternal: true,
          clientId: p.split('/').pop(),
          scopes: [],
        },
      });
    if (p === '/assets')
      return json({ files: uploaded ? [file] : [], total: uploaded ? 1 : 0, hasMore: false });
    if (p === '/assets/upload') {
      uploaded = true;
      return json({ file });
    }
    if (p === '/assets/batch-access')
      return json({
        results: Object.fromEntries(
          req.postDataJSON().files.map(({ fileId }) => [
            fileId,
            {
              allowed: true,
              visibility: 'private',
              mime: 'image/png',
              url: `https://api.oxy.so/assets/${fileId}/stream?token=fixture-scoped`,
            },
          ]),
        ),
      });
    if (p.endsWith('/stream'))
      return route.fulfill({ headers, contentType: 'image/png', body: png });
    if (p === `/assets/${file.id}/url`)
      return json({ url: `https://api.oxy.so/assets/${file.id}/stream?token=fixture-scoped` });
    if (p === `/assets/${file.id}`) return json(file);
    if (
      ['https://api.mention.earth', 'https://api.oxy.so'].includes(url.origin) &&
      (p === '/socket.io' || p === '/socket.io/')
    )
      return route.abort();
    if (p.includes('/session/sessions') || p.startsWith('/session/device/sessions'))
      return json([]);
    if (p.includes('/accounts')) return json({ accounts: [], items: [] });
    if (
      p.includes('settings') ||
      p.includes('preferences') ||
      p.includes('entitlements') ||
      p.includes('/appearance')
    )
      return json({});
    if (p.includes('/notifications/unread')) return json({ count: 0 });
    if (p === '/posts' && m === 'POST') {
      const submitted = req.postDataJSON();
      if (submitted.visibility !== 'private')
        return json({ message: 'Public publishing unavailable' }, 403);
      return json(
        {
          success: true,
          post: {
            id: 'private-drawing',
            user: {
              id: child.id,
              username: child.username,
              name: { displayName: 'Supervised Writer' },
            },
            content: {
              text: 'My drawing',
              media: [
                {
                  id: file.id,
                  type: 'image',
                  url: `https://api.oxy.so/assets/${file.id}/stream?token=fixture-scoped`,
                },
              ],
            },
            visibility: 'private',
            attachments: {},
            authors: [],
            permissions: { canReply: true, canDelete: true, canPin: true, canViewSources: true },
            metadata: {
              status: 'published',
              visibility: 'private',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            engagement: { replies: 0, likes: 0, boosts: 0, saves: 0 },
            viewerState: {
              isOwner: true,
              isLiked: false,
              isDownvoted: false,
              isBoosted: false,
              isSaved: false,
              isCollaborator: false,
            },
          },
        },
        201,
      );
    }
    if (p.includes('/feed') || p.includes('/posts'))
      return json({ posts: [], items: [], hasMore: false, nextCursor: null });
    return json({ items: [], data: [], nextCursor: null });
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('browser error', msg.text().slice(0, 250));
  });
  await page.goto(`${origin}/compose`);
  await expect(page.getByRole('button', { name: 'Add photos or videos' })).toBeVisible();
  await page.getByRole('button', { name: 'Add photos or videos' }).click();
  await expect.poll(() => calls.some((c) => c.path === '/assets')).toBe(true);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload Files', exact: true }).click();
  await (await chooser).setFiles({ name: 'drawing.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await expect.poll(() => calls.some((c) => c.path === '/assets/upload')).toBe(true);
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  await expect(page.getByText('1 Selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeHidden();
  await expect
    .poll(() =>
      calls.some((c) => c.path === '/assets/batch-access' && c.body?.includes('mention-compose')),
    )
    .toBe(true);
  await expect(page.locator(`img[src*="${file.id}/stream"]`).first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(`img[src*="${file.id}/stream"]`)
        .first()
        .evaluate((img) => img.complete && img.naturalWidth === 64),
    )
    .toBe(true);
  await page.getByPlaceholder("What's new?").fill('My drawing');
  await page.screenshot({ path: info.outputPath('child-private-preview.png') });
  await page.getByTestId('compose-submit').click();
  await expect.poll(() => calls.some((c) => c.path === '/posts' && c.method === 'POST')).toBe(true);
  const upload = calls.find((c) => c.path === '/assets/upload');
  expect(upload.authorization).toBe(true);
  expect(upload.body).toMatch(/name="visibility"\r\n\r\nprivate/);
  const submitted = JSON.parse(calls.find((c) => c.path === '/posts' && c.method === 'POST').body);
  expect(submitted.visibility).toBe('private');
  expect(JSON.stringify(submitted.content)).toContain(file.id);
  await expect(page.getByText('Post published successfully', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('child-posted.png') });
  await info.attach('calls', {
    body: JSON.stringify(calls, null, 2),
    contentType: 'application/json',
  });
});
