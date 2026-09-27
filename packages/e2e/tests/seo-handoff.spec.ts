/** Browser contract between the real backend renderer and the candidate Expo build. */
import { test, expect, type BrowserContext } from '@playwright/test';
import { renderShellWithOg, type OgData } from '../../backend/src/services/webShellRenderer';
import { APP_ORIGIN, CANDIDATE_ORIGIN, PROFILE_HANDLE } from '../environment';

const profilePath = `/@${PROFILE_HANDLE}`;
const profile: OgData = {
  title: `Nate (@${PROFILE_HANDLE}) on Mention`,
  description: 'Public profile rendered before JavaScript.',
  url: `${APP_ORIGIN}${profilePath}`,
  type: 'profile',
  robots: 'index,follow',
  jsonLd: { '@context': 'https://schema.org', '@type': 'ProfilePage', mainEntity: { '@type': 'Person', name: 'Nate' } },
  publicContent: { heading: 'Nate', text: 'Public profile rendered before JavaScript.', handle: `@${PROFILE_HANDLE}` },
};

async function serveDocument(context: BrowserContext, path: string, og: OgData | null) {
  await context.addInitScript(() => localStorage.setItem('welcome_modal_seen', 'true'));
  await context.route((url) => url.origin === APP_ORIGIN, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${CANDIDATE_ORIGIN}${url.pathname}${url.search}` });
    const headers = { ...response.headers() };
    for (const header of ['content-encoding', 'content-length', 'transfer-encoding']) delete headers[header];
    const body = route.request().isNavigationRequest() && url.pathname === path
      ? renderShellWithOg(await response.text(), og)
      : await response.body();
    await route.fulfill({ status: response.status(), headers, body });
  });
}

test('server profile remains readable without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await serveDocument(context, profilePath, profile);
    const page = await context.newPage();
    await page.goto(`${APP_ORIGIN}${profilePath}`);
    await expect(page.locator('[data-mention-seo-fallback] h1')).toHaveText('Nate');
    await expect(page.locator('[data-mention-seo-fallback]')).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
    expect(await page.locator('script[type="application/ld+json"]').textContent()).toContain('ProfilePage');
  } finally { await context.close(); }
});

test('loaded profile adopts one head and navigation drops the old profile schema', async ({ context, page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await serveDocument(context, profilePath, profile);
  let releaseProfile!: () => void;
  const profileGate = new Promise<void>((resolve) => { releaseProfile = resolve; });
  let profileRequested = false;
  await page.route(`https://api.oxy.so/profiles/username/${PROFILE_HANDLE}**`, async (route) => {
    profileRequested = true;
    await profileGate;
    await route.continue();
  });
  await page.goto(`${APP_ORIGIN}${profilePath}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => profileRequested).toBe(true);
  await expect(page.locator('[data-mention-seo-fallback]')).toBeVisible();
  await expect(page.locator('#root')).toBeHidden();
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  releaseProfile();
  await expect(page.locator('[data-mention-seo-fallback]')).toHaveCount(0);
  await expect(page.locator('#root')).toBeVisible();
  await expect(page).toHaveTitle(new RegExp(`\\(@${PROFILE_HANDLE}\\)`));
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  await expect(page.locator('meta[property="og:url"]')).toHaveCount(1);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
  await page.getByText('Explore', { exact: true }).click();
  await expect(page).toHaveURL(/\/explore(?:\?|$)/);
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${APP_ORIGIN}/explore`);
  await expect(page.locator('meta[property="og:url"]')).toHaveCount(1);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('post hydration cannot loosen authoritative noindex or publish a warning-gated body', async ({ context, page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const id = 'c186e8a0-e9a5-4e84-9c97-15b285a77777';
  const path = `/p/${id}`;
  await serveDocument(context, path, {
    title: 'Sensitive post on Mention', description: 'Content warning',
    url: `${APP_ORIGIN}${path}`, type: 'article', robots: 'noindex,nofollow',
  });
  // The API DTO deliberately lacks the raw federation warning that the server
  // SEO gate saw: public visibility alone must never override that decision.
  await page.route(`**/feed/item/${id}`, async (route) => route.fulfill({ json: {
    id, type: 'post', user: { id: 'seo-fixture-user', username: 'seo-fixture', name: { displayName: 'SEO Fixture' } },
    authors: [], attachments: {},
    viewerState: { isOwner: false, isCollaborator: false, isLiked: false, isDownvoted: false, isBoosted: false, isSaved: false, isFollowingAuthor: false },
    content: { text: 'WARNING_GATED_BODY_MUST_NOT_ENTER_HEAD', media: [] },
    metadata: { visibility: 'public', status: 'published', createdAt: '2026-01-01T00:00:00Z' },
    engagement: { likes: 0, downvotes: 0, replies: 0, boosts: 0, views: 0 },
  } }));
  await page.goto(`${APP_ORIGIN}${path}`);
  await expect(page.locator('meta[name="robots"][data-rh="true"]')).toHaveAttribute('content', 'noindex,nofollow');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', 'Content warning');
  await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
  expect(await page.locator('head').innerHTML()).not.toContain('WARNING_GATED_BODY_MUST_NOT_ENTER_HEAD');
  expect(errors).toEqual([]);
});


for (const initialRestricted of [true, false]) {
  test(`unknown profile privacy stays conservative while appearance is delayed and fails (server restriction=${initialRestricted})`, async ({ context, page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await serveDocument(context, profilePath, initialRestricted ? {
      ...profile, robots: 'noindex,nofollow', description: 'Profile unavailable', jsonLd: undefined, publicContent: undefined,
    } : null);
    await page.route(`https://api.oxy.so/profiles/username/${PROFILE_HANDLE}**`, async (route) => route.fulfill({ json: {
      id: 'seo-private-profile', username: PROFILE_HANDLE, kind: 'personal',
      name: { displayName: 'Nate' }, bio: 'PRIVATE_BIO_MUST_NOT_ENTER_HEAD',
      avatar: 'https://example.com/PRIVATE_AVATAR.jpg',
    } }));
    let releaseAppearance!: () => void;
    let requested = false;
    const gate = new Promise<void>((resolve) => { releaseAppearance = resolve; });
    await page.route('**/profile/design/**', async (route) => {
      requested = true;
      await gate;
      await route.fulfill({ status: 503, json: { error: 'Unavailable' } });
    });
    await page.goto(`${APP_ORIGIN}${profilePath}`);
    await expect.poll(() => requested).toBe(true);
    await expect(page.locator('meta[name="robots"][data-rh="true"]')).toHaveAttribute('content', 'noindex,nofollow');
    await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
    expect(await page.locator('head').innerHTML()).not.toMatch(/PRIVATE_BIO|PRIVATE_AVATAR/);
    const failed = page.waitForResponse((response) => response.url().includes('/profile/design/') && response.status() === 503);
    releaseAppearance();
    await failed;
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex,nofollow');
    expect(await page.locator('head').innerHTML()).not.toMatch(/PRIVATE_BIO|PRIVATE_AVATAR/);
    expect(errors).toEqual([]);
  });
}

test('a verified alias waits for readiness and adopts the primary canonical', async ({ context, page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const username = 'seoalias@instagram.com';
  const alias = 'seoalias@threads.net';
  const path = `/@${alias}`;
  const canonical = `${APP_ORIGIN}/@${encodeURIComponent(username)}`;
  await serveDocument(context, path, {
    ...profile, url: canonical, title: 'SEO Alias',
    publicContent: { heading: 'SEO Alias', text: 'Alias profile awaiting application readiness' },
  });
  let release!: () => void;
  let requested = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('https://api.oxy.so/profiles/resolve?**', async (route) => {
    requested = true;
    await gate;
    await route.fulfill({ json: { success: true, data: {
      id: 'seo-alias-person', username, type: 'federated', isFederated: true,
      name: { displayName: 'SEO Alias' }, bio: 'Alias profile', redirectedUserIds: [],
      externalIdentities: [
        { canonicalAcct: username, network: 'instagram.com', protocol: 'activitypub', actorUri: 'https://bridge.example/users/seoalias', transportAcct: 'seoalias@bridge.example', sourceUserId: 'seo-alias-instagram' },
        { canonicalAcct: alias, network: 'threads.net', protocol: 'activitypub', actorUri: 'https://threads.net/ap/users/seoalias', transportAcct: alias, sourceUserId: 'seo-alias-threads' },
      ],
    } } });
  });
  await page.goto(`${APP_ORIGIN}${path}`, { waitUntil: 'domcontentloaded' });
  await expect.poll(() => requested).toBe(true);
  await expect(page.locator('[data-mention-seo-fallback]')).toBeVisible();
  await expect(page.locator('#root')).toBeHidden();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', canonical);
  release();
  await expect(page.locator('[data-mention-seo-fallback]')).toHaveCount(0);
  await expect(page.locator('link[rel="canonical"][data-rh="true"]')).toHaveAttribute('href', canonical);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
  await page.getByText('Explore', { exact: true }).click();
  await expect(page).toHaveURL(/\/explore(?:\?|$)/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${APP_ORIGIN}/explore`);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a channel local tab keeps the indexing policy of its unchanged URL', async ({ context, page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const handle = 'seochannel';
  const path = `/c/${handle}`;
  await serveDocument(context, path, { ...profile, url: `${APP_ORIGIN}${path}`, title: 'SEO Channel' });
  await page.route(`https://api.oxy.so/profiles/username/${handle}**`, async (route) => route.fulfill({ json: {
    id: 'seo-channel', username: handle, kind: 'channel', name: { displayName: 'SEO Channel' },
  } }));
  await page.route('**/profile/design/**', async (route) => route.fulfill({ json: { privacy: { profileVisibility: 'public' } } }));
  await page.goto(`${APP_ORIGIN}${path}`);
  await expect(page.locator('meta[name="robots"][data-rh="true"]')).toHaveAttribute('content', 'index,follow');
  const media = page.getByRole('tab', { name: 'Media', exact: true });
  await expect(media).toBeVisible();
  await media.focus();
  await page.keyboard.press('Enter');
  await expect(media).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(`${APP_ORIGIN}${path}`);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'index,follow');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${APP_ORIGIN}${path}`);
  expect(errors).toEqual([]);
});
